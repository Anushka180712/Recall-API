/*
 * HistoryIndex: an in-memory, serialisable index of prompts you have sent.
 *
 * Each entry is one user message from one conversation. Search returns at most
 * one hit per conversation (its best-matching prompt), ranked by similarity.
 * Document frequencies are maintained incrementally so TF-IDF weights reflect
 * *your* history: words you use all the time ("code", "python") matter less
 * than the rare words that identify a topic.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./text.js'), require('./similarity.js'));
  } else {
    root.RecallDefine('historyIndex', ['text', 'similarity'], factory);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (text, similarity) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const MAX_PROMPT_CHARS = 400;
  const DEFAULT_MAX_ENTRIES = 5000;
  const MAX_PER_CONVERSATION = 60;
  const MAX_TOMBSTONES = 2000;

  class HistoryIndex {
    constructor({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
      this.maxEntries = maxEntries;
      /** @type {Map<string, object>} id -> entry */
      this.entries = new Map();
      /** @type {Map<string, Set<string>>} token -> ids of entries containing it (inverted index) */
      this.postings = new Map();
      /** @type {Map<string, Set<string>>} conversationId -> entry ids */
      this.byConversation = new Map();
      /** @type {Map<string, Set<string>>} full-text hash -> entry ids (exact copies) */
      this.exact = new Map();
      /** @type {Map<string, {title: string, updatedAt: number}>} */
      this.conversations = new Map();
      /** Conversations deleted in ChatGPT; never re-added by a merge. */
      this.tombstones = new Set();
      /** When the user last wiped the index (lets other tabs drop stale copies). */
      this.clearedAt = 0;
    }

    get size() {
      return this.entries.size;
    }

    /** Hash of the whole normalised prompt (computed before storage truncation). */
    static fullHash(prompt) {
      return text.hash(text.normalize(prompt));
    }

    static entryId(conversationId, prompt, h = HistoryIndex.fullHash(prompt)) {
      return text.hash(`${conversationId}\u0000${h}`);
    }

    /**
     * Add (or refresh) a prompt.
     * @returns {boolean} true if a new entry was created
     */
    add({ conversationId, prompt, title = '', createdAt = Date.now(), source = 'observed', hash }) {
      if (!conversationId || typeof prompt !== 'string') return false;
      if (this.tombstones.has(conversationId)) return false;
      const clean = prompt.trim();
      if (!clean) return false;

      // Cheap duplicate check first (hash only), so re-merging thousands of
      // known prompts between tabs costs almost nothing.
      // `hash` is passed back in when loading a stored (possibly truncated)
      // prompt, so long prompts keep the identity of their full text.
      const h = hash || HistoryIndex.fullHash(clean);
      const id = HistoryIndex.entryId(conversationId, clean, h);
      const existing = this.entries.get(id);
      if (existing) {
        this.touchConversation(conversationId, title, createdAt);
        // 0 means "time unknown" (e.g. learned by reading an open chat).
        if (createdAt > 0 && (existing.createdAt === 0 || createdAt < existing.createdAt)) existing.createdAt = createdAt;
        return false;
      }

      const stored = clean.length > MAX_PROMPT_CHARS ? clean.slice(0, MAX_PROMPT_CHARS) : clean;
      const f = similarity.features(stored);
      if (!f.tokens.length) return false;
      this.touchConversation(conversationId, title, createdAt);

      const entry = { id, conversationId, prompt: stored, createdAt, source, f, h };
      this.entries.set(id, entry);
      let same = this.exact.get(h);
      if (!same) this.exact.set(h, (same = new Set()));
      same.add(id);
      let own = this.byConversation.get(conversationId);
      if (!own) this.byConversation.set(conversationId, (own = new Set()));
      own.add(id);
      for (const t of new Set(f.tokens)) {
        let set = this.postings.get(t);
        if (!set) this.postings.set(t, (set = new Set()));
        set.add(id);
      }

      this.enforcePerConversationCap(conversationId);
      this.enforceCap();
      return true;
    }

    touchConversation(conversationId, title, at = Date.now()) {
      if (this.tombstones.has(conversationId)) return;
      const prev = this.conversations.get(conversationId);
      this.conversations.set(conversationId, {
        title: title || (prev && prev.title) || '',
        updatedAt: Math.max(at, prev ? prev.updatedAt : 0),
      });
    }

    remove(id) {
      const entry = this.entries.get(id);
      if (!entry) return false;
      this.entries.delete(id);
      const same = this.exact.get(entry.h);
      if (same) {
        same.delete(id);
        if (!same.size) this.exact.delete(entry.h);
      }
      const own = this.byConversation.get(entry.conversationId);
      if (own) {
        own.delete(id);
        if (!own.size) this.byConversation.delete(entry.conversationId);
      }
      for (const t of new Set(entry.f.tokens)) {
        const set = this.postings.get(t);
        if (!set) continue;
        set.delete(id);
        if (!set.size) this.postings.delete(t);
      }
      return true;
    }

    /** Forget a conversation entirely (e.g. after it was deleted in ChatGPT). */
    removeConversation(conversationId) {
      let removed = 0;
      for (const id of [...(this.byConversation.get(conversationId) || [])]) {
        if (this.remove(id)) removed++;
      }
      this.conversations.delete(conversationId);
      this.tombstones.add(conversationId);
      if (this.tombstones.size > MAX_TOMBSTONES) this.tombstones.delete(this.tombstones.values().next().value);
      return removed;
    }

    /** Allow a conversation to be learned again (it was restored after a delete). */
    restoreConversation(conversationId) {
      this.tombstones.delete(conversationId);
    }

    clear(at = Date.now()) {
      this.entries.clear();
      this.postings.clear();
      this.byConversation.clear();
      this.exact.clear();
      this.conversations.clear();
      this.tombstones.clear();
      this.clearedAt = at;
    }

    enforcePerConversationCap(conversationId) {
      const ids = this.byConversation.get(conversationId);
      if (!ids || ids.size <= MAX_PER_CONVERSATION) return;
      const own = [...ids].map((id) => this.entries.get(id));
      own.sort((a, b) => a.createdAt - b.createdAt);
      for (const e of own.slice(0, own.length - MAX_PER_CONVERSATION)) this.remove(e.id);
    }

    enforceCap() {
      // Trim in small batches (2 % slack) instead of re-sorting on every add.
      if (this.entries.size <= this.maxEntries + Math.floor(this.maxEntries * 0.02)) return;
      const sorted = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
      for (const e of sorted.slice(0, this.entries.size - this.maxEntries)) this.remove(e.id);
    }

    docFreq(token) {
      const set = this.postings.get(token);
      return set ? set.size : 0;
    }

    idf(token) {
      const n = this.entries.size;
      // Words never seen before are treated like words seen once, so a single
      // new word in the query can't drown out several shared rare ones.
      const df = Math.max(1, this.docFreq(token));
      return Math.log((n + 1) / (df + 1)) + 1;
    }

    /**
     * Best match per conversation, highest score first.
     * @param {string} prompt
     * @param {{topK?: number, minScore?: number, excludeConversationId?: string}} [opts]
     */
    search(prompt, { topK = 3, minScore = 0, excludeConversationId = null } = {}) {
      const clean = String(prompt || '').trim();
      // Compare like with like: stored prompts are truncated, so the query is too.
      const q = similarity.features(clean.length > MAX_PROMPT_CHARS ? clean.slice(0, MAX_PROMPT_CHARS) : clean);
      if (!q.tokens.length) return [];
      const idf = (t) => this.idf(t);
      const best = new Map();
      const exactIds = this.exact.get(HistoryIndex.fullHash(clean)) || new Set();

      // Exact copies (same whole text, ignoring case and punctuation) score 1.
      for (const id of exactIds) {
        const e = this.entries.get(id);
        if (!e || (excludeConversationId && e.conversationId === excludeConversationId)) continue;
        const prev = best.get(e.conversationId);
        if (!prev || e.createdAt > prev.entry.createdAt) best.set(e.conversationId, { score: 1, entry: e, exact: true });
      }

      // Only score entries that share at least one word with the query (via
      // the inverted index) instead of scanning the whole history.
      const candidates = new Set();
      for (const t of new Set(q.tokens)) {
        const set = this.postings.get(t);
        if (set) for (const id of set) candidates.add(id);
      }

      for (const id of candidates) {
        const e = this.entries.get(id);
        if (!e || exactIds.has(id)) continue;
        if (excludeConversationId && e.conversationId === excludeConversationId) continue;
        // Early exit: if even a perfect trigram overlap couldn't reach minScore,
        // skip the (more expensive) trigram comparison entirely.
        if (e.f.norm !== q.norm && minScore > 0) {
          const cos = similarity.tfidfCosine(q.tokens, e.f.tokens, idf);
          if (similarity.TOKEN_WEIGHT * cos + similarity.TRIGRAM_WEIGHT < minScore) continue;
        }
        const score = similarity.scoreFeatures(q, e.f, idf);
        if (score < minScore) continue;
        const prev = best.get(e.conversationId);
        if (prev && prev.exact) continue;
        if (!prev || score > prev.score || (score === prev.score && e.createdAt > prev.entry.createdAt)) {
          best.set(e.conversationId, { score, entry: e });
        }
      }

      return [...best.values()]
        .sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt)
        .slice(0, topK)
        .map(({ score, entry, exact }) => ({
          score,
          exact: !!exact,
          conversationId: entry.conversationId,
          prompt: entry.prompt,
          title: (this.conversations.get(entry.conversationId) || {}).title || '',
          createdAt: entry.createdAt,
          source: entry.source,
        }));
    }

    /** All prompts of a conversation, oldest first (chat titles excluded unless asked). */
    promptsFor(conversationId, { includeTitles = false } = {}) {
      return [...(this.byConversation.get(conversationId) || [])]
        .map((id) => this.entries.get(id))
        .filter((e) => includeTitles || e.source !== 'title')
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((e) => e.prompt);
    }

    stats() {
      return { prompts: this.entries.size, conversations: this.conversations.size };
    }

    /** Compact JSON for chrome.storage.local (features are recomputed on load). */
    toJSON() {
      return {
        v: SCHEMA_VERSION,
        e: [...this.entries.values()].map((e) => [e.conversationId, e.prompt, e.createdAt, e.source, e.h]),
        c: [...this.conversations.entries()].map(([id, c]) => [id, c.title, c.updatedAt]),
        x: [...this.tombstones],
        z: this.clearedAt,
      };
    }

    static fromJSON(json, opts) {
      const idx = new HistoryIndex(opts);
      idx.merge(json);
      return idx;
    }

    /** Union another serialised index into this one (used to sync between tabs). */
    merge(json) {
      if (!json || json.v !== SCHEMA_VERSION) return this;
      if ((json.z || 0) > this.clearedAt) this.clear(json.z); // wiped elsewhere: drop our stale copy
      for (const id of json.x || []) this.removeConversation(id);
      for (const [id, title, updatedAt] of json.c || []) this.touchConversation(id, title, updatedAt);
      for (const [conversationId, prompt, createdAt, source, hash] of json.e || []) {
        this.add({ conversationId, prompt, createdAt, source, hash, title: '' });
      }
      return this;
    }
  }

  return { HistoryIndex, SCHEMA_VERSION, MAX_PROMPT_CHARS, MAX_PER_CONVERSATION };
});
