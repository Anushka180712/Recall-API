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
      /** @type {Map<string, number>} token -> number of entries containing it */
      this.df = new Map();
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

    static entryId(conversationId, prompt) {
      return text.hash(`${conversationId}\u0000${text.normalize(prompt)}`);
    }

    /**
     * Add (or refresh) a prompt.
     * @returns {boolean} true if a new entry was created
     */
    add({ conversationId, prompt, title = '', createdAt = Date.now(), source = 'observed' }) {
      if (!conversationId || typeof prompt !== 'string') return false;
      if (this.tombstones.has(conversationId)) return false;
      const clean = prompt.trim();
      if (!clean || text.tokenize(clean).length === 0) return false;

      this.touchConversation(conversationId, title, createdAt);

      const id = HistoryIndex.entryId(conversationId, clean);
      const existing = this.entries.get(id);
      if (existing) {
        // 0 means "time unknown" (e.g. learned by reading an open chat).
        if (createdAt > 0 && (existing.createdAt === 0 || createdAt < existing.createdAt)) existing.createdAt = createdAt;
        return false;
      }

      const stored = clean.length > MAX_PROMPT_CHARS ? clean.slice(0, MAX_PROMPT_CHARS) : clean;
      const entry = { id, conversationId, prompt: stored, createdAt, source, f: similarity.features(stored) };
      this.entries.set(id, entry);
      for (const t of new Set(entry.f.tokens)) this.df.set(t, (this.df.get(t) || 0) + 1);

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
      for (const t of new Set(entry.f.tokens)) {
        const n = (this.df.get(t) || 1) - 1;
        if (n <= 0) this.df.delete(t);
        else this.df.set(t, n);
      }
      return true;
    }

    /** Forget a conversation entirely (e.g. after it was deleted in ChatGPT). */
    removeConversation(conversationId) {
      let removed = 0;
      for (const [id, e] of this.entries) {
        if (e.conversationId === conversationId && this.remove(id)) removed++;
      }
      this.conversations.delete(conversationId);
      this.tombstones.add(conversationId);
      if (this.tombstones.size > MAX_TOMBSTONES) this.tombstones.delete(this.tombstones.values().next().value);
      return removed;
    }

    clear(at = Date.now()) {
      this.entries.clear();
      this.df.clear();
      this.conversations.clear();
      this.tombstones.clear();
      this.clearedAt = at;
    }

    enforcePerConversationCap(conversationId) {
      const own = [...this.entries.values()].filter((e) => e.conversationId === conversationId);
      if (own.length <= MAX_PER_CONVERSATION) return;
      own.sort((a, b) => a.createdAt - b.createdAt);
      for (const e of own.slice(0, own.length - MAX_PER_CONVERSATION)) this.remove(e.id);
    }

    enforceCap() {
      if (this.entries.size <= this.maxEntries) return;
      const sorted = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
      for (const e of sorted.slice(0, this.entries.size - this.maxEntries)) this.remove(e.id);
    }

    idf(token) {
      const n = this.entries.size;
      // Words never seen before are treated like words seen once, so a single
      // new word in the query can't drown out several shared rare ones.
      const df = Math.max(1, this.df.get(token) || 0);
      return Math.log((n + 1) / (df + 1)) + 1;
    }

    /**
     * Best match per conversation, highest score first.
     * @param {string} prompt
     * @param {{topK?: number, minScore?: number, excludeConversationId?: string}} [opts]
     */
    search(prompt, { topK = 3, minScore = 0, excludeConversationId = null } = {}) {
      const q = similarity.features(prompt);
      if (!q.tokens.length) return [];
      const qTokens = new Set(q.tokens);
      const idf = (t) => this.idf(t);
      const best = new Map();

      for (const e of this.entries.values()) {
        if (excludeConversationId && e.conversationId === excludeConversationId) continue;
        // Cheap pre-filter: skip entries that share no token and no exact text.
        if (e.f.norm !== q.norm && !e.f.tokens.some((t) => qTokens.has(t))) continue;
        const score = similarity.scoreFeatures(q, e.f, idf);
        if (score < minScore) continue;
        const prev = best.get(e.conversationId);
        if (!prev || score > prev.score || (score === prev.score && e.createdAt > prev.createdAt)) {
          best.set(e.conversationId, { score, entry: e });
        }
      }

      return [...best.values()]
        .sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt)
        .slice(0, topK)
        .map(({ score, entry }) => ({
          score,
          conversationId: entry.conversationId,
          prompt: entry.prompt,
          title: (this.conversations.get(entry.conversationId) || {}).title || '',
          createdAt: entry.createdAt,
          source: entry.source,
        }));
    }

    /** All prompts of a conversation, oldest first. */
    promptsFor(conversationId) {
      return [...this.entries.values()]
        .filter((e) => e.conversationId === conversationId)
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
        e: [...this.entries.values()].map((e) => [e.conversationId, e.prompt, e.createdAt, e.source]),
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
      for (const [conversationId, prompt, createdAt, source] of json.e || []) {
        this.add({ conversationId, prompt, createdAt, source, title: '' });
      }
      return this;
    }
  }

  return { HistoryIndex, SCHEMA_VERSION, MAX_PROMPT_CHARS, MAX_PER_CONVERSATION };
});
