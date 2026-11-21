/*
 * User settings: defaults, validation and the sensitivity presets shown in the popup.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecallDefine('settings', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,
    threshold: 0.7, // similarity needed to suggest a redirect (0..1)
    minChars: 12, // prompts shorter than this are never checked
    minContentTokens: 3, // ...nor prompts with fewer meaningful words
    maxChars: 1500, // longer prompts are treated as pasted, unique content
    maxSuggestions: 3,
    freshnessGuard: true, // skip "latest / today / price..." questions
    passiveIndexing: true, // learn from chats you open, not just ones you send
    showLauncher: true, // small floating button on chatgpt.com
    cleanupNudge: true, // occasionally offer to tidy up stale chats
    nudgeIntervalDays: 7,
    nudgeMinSuggestions: 5,
    staleDays: 60,
    snoozeDays: 30, // how long "not helpful" silences a pair
  });

  const PRESETS = Object.freeze([
    { id: 'loose', label: 'Loose', threshold: 0.6, hint: 'Catches more re-phrasings, occasionally a near miss.' },
    { id: 'balanced', label: 'Balanced', threshold: 0.7, hint: 'Recommended.' },
    { id: 'strict', label: 'Strict', threshold: 0.82, hint: 'Only near-identical questions.' },
  ]);

  const NUMERIC = {
    threshold: [0.4, 0.98],
    minChars: [1, 200],
    minContentTokens: [1, 20],
    maxChars: [200, 20000],
    maxSuggestions: [1, 5],
    nudgeIntervalDays: [1, 90],
    nudgeMinSuggestions: [1, 100],
    staleDays: [7, 730],
    snoozeDays: [1, 365],
  };

  /** Merge stored values over defaults, dropping unknown keys and clamping numbers. */
  function sanitize(input) {
    const out = { ...DEFAULTS };
    if (!input || typeof input !== 'object') return out;
    for (const key of Object.keys(DEFAULTS)) {
      if (!(key in input)) continue;
      const def = DEFAULTS[key];
      const val = input[key];
      if (typeof def === 'boolean') {
        if (typeof val === 'boolean') out[key] = val;
      } else if (typeof def === 'number') {
        const n = Number(val);
        if (Number.isFinite(n)) {
          const [lo, hi] = NUMERIC[key];
          out[key] = Math.min(hi, Math.max(lo, n));
        }
      }
    }
    return out;
  }

  function presetFor(threshold) {
    let best = PRESETS[1];
    for (const p of PRESETS) if (Math.abs(p.threshold - threshold) < Math.abs(best.threshold - threshold)) best = p;
    return best;
  }

  return { DEFAULTS, PRESETS, sanitize, presetFor };
});
