/*
 * Cleanup suggestions: which chats are probably clutter?
 *
 * Each conversation earns points for signals of staleness. Anything at or
 * above SUGGEST_AT is offered for deletion; anything at or above PRESELECT_AT
 * is ticked by default. Nothing is ever deleted without an explicit
 * confirmation in the UI (see content/overlay.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./text.js'), require('./similarity.js'), require('./policy.js'));
  } else {
    root.RecallDefine('cleanup', ['text', 'similarity', 'policy'], factory);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (text, similarity, policy) {
  'use strict';

  const DAY = 24 * 60 * 60 * 1000;
  const SUGGEST_AT = 2;
  const PRESELECT_AT = 3;
  // ChatGPT auto-titles "hi"-only chats with names like "Friendly Greeting".
  const GREETING_TITLE_RE = /\bgreetings?\b|^(?:hi|hey|hello|test(?:ing)?)(?: there)?[\s!.?]*$/i;
  const UNTITLED = new Set(['', 'new chat', 'untitled', 'new conversation', 'untitled chat']);

  const SIGNALS = Object.freeze({
    UNTITLED: { id: 'untitled', points: 3, label: 'Never got a title' },
    GREETING_ONLY: { id: 'greeting-only', points: 3, label: 'Only small talk ("hi", "test"...)' },
    DUPLICATE: { id: 'duplicate', points: 2, label: 'Same question as a newer chat' },
    INACTIVE: { id: 'inactive', points: 2, label: 'Not opened in a long time' },
    VERY_OLD: { id: 'very-old', points: 1, label: 'Untouched for twice as long' },
    ONE_SHOT: { id: 'one-shot', points: 1, label: 'Single question, no follow-up' },
  });

  /**
   * @param {Array<{id: string, title?: string, createdAt?: number, updatedAt?: number, prompts?: string[]}>} conversations
   * @param {object} [opts]
   * @param {number} [opts.now]
   * @param {number} [opts.staleDays=60]
   * @param {number} [opts.duplicateThreshold=0.8]
   * @param {Set<string>|string[]} [opts.protectedIds] chats the user said to keep
   * @param {string|null} [opts.currentConversationId] never suggest the open chat
   * @returns {Array<{id, title, updatedAt, score, reasons: Array<{id,label,detail?}>, preselected: boolean}>}
   */
  function suggest(conversations, opts = {}) {
    const now = opts.now ?? Date.now();
    const staleMs = (opts.staleDays ?? 60) * DAY;
    const dupThreshold = opts.duplicateThreshold ?? 0.8;
    const protectedIds = new Set(opts.protectedIds || []);

    const list = (conversations || []).filter(
      (c) => c && c.id && !protectedIds.has(c.id) && c.id !== opts.currentConversationId
    );
    const keyText = (c) => (c.prompts && c.prompts[0]) || c.title || '';
    const feats = new Map(list.map((c) => [c.id, similarity.features(keyText(c))]));

    const out = [];
    for (const c of list) {
      const reasons = [];
      const title = String(c.title || '').trim();
      const updated = c.updatedAt || c.createdAt || 0;
      const prompts = c.prompts || [];

      if (UNTITLED.has(title.toLowerCase())) reasons.push(sig(SIGNALS.UNTITLED));

      if (prompts.length && prompts.every((p) => isSmallTalk(p))) reasons.push(sig(SIGNALS.GREETING_ONLY));
      // Titles are short by nature, so only an actual greeting title counts.
      else if (!prompts.length && (GREETING_TITLE_RE.test(title) || policy.precheck(title, {}, {}) === policy.REASONS.GENERIC)) {
        reasons.push(sig(SIGNALS.GREETING_ONLY));
      }

      if (updated && now - updated > staleMs) {
        reasons.push(sig(SIGNALS.INACTIVE, `${Math.floor((now - updated) / DAY)} days ago`));
        if (now - updated > 2 * staleMs) reasons.push(sig(SIGNALS.VERY_OLD));
      }

      if (prompts.length === 1) reasons.push(sig(SIGNALS.ONE_SHOT));

      const dup = findNewerDuplicate(c, list, feats, dupThreshold);
      if (dup) reasons.push(sig(SIGNALS.DUPLICATE, `see "${text.truncate(dup.title || 'Untitled', 40)}"`));

      const score = reasons.reduce((s, r) => s + r.points, 0);
      if (score >= SUGGEST_AT) {
        out.push({
          id: c.id,
          title: title || 'Untitled',
          updatedAt: updated,
          score,
          reasons: reasons.map(({ id, label, detail }) => (detail ? { id, label, detail } : { id, label })),
          preselected: score >= PRESELECT_AT,
        });
      }
    }
    return out.sort((a, b) => b.score - a.score || a.updatedAt - b.updatedAt);
  }

  function sig(signal, detail) {
    return detail ? { ...signal, detail } : { ...signal };
  }

  function isSmallTalk(s) {
    const r = policy.precheck(s, {}, { freshnessGuard: false });
    return r === policy.REASONS.GENERIC || r === policy.REASONS.TOO_SHORT || r === policy.REASONS.EMPTY;
  }

  function findNewerDuplicate(c, list, feats, threshold) {
    const f = feats.get(c.id);
    if (!f.tokens.length) return null;
    const cTime = c.updatedAt || c.createdAt || 0;
    for (const other of list) {
      if (other.id === c.id) continue;
      const oTime = other.updatedAt || other.createdAt || 0;
      // Only the older of the pair is flagged; ties broken by id for determinism.
      if (oTime < cTime || (oTime === cTime && other.id < c.id)) continue;
      if (similarity.scoreFeatures(f, feats.get(other.id)) >= threshold) return other;
    }
    return null;
  }

  return { suggest, SIGNALS, SUGGEST_AT, PRESELECT_AT, DAY };
});
