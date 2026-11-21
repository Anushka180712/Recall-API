/*
 * "Take me there": deciding which message in a chat is the one you asked.
 *
 * Pure functions, so the tricky part of jumping is unit-tested without a
 * browser. The content script feeds in what it knows:
 *
 *   target = {
 *     prompt,     // the earlier prompt that matched (may be the chat's TITLE)
 *     query,      // what you just typed
 *     fromTitle,  // true when the match came from the chat title, not a message
 *     messageId,  // ChatGPT's id of the message, once looked up (optional)
 *     text,       // that message's full text, once looked up (optional)
 *   }
 *
 * and the user messages currently on screen as {id, text} (id is the page's
 * data-message-id, when present).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./text.js'), require('./similarity.js'));
  else root.RecallDefine('jump', ['text', 'similarity'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (text, similarity) {
  'use strict';

  /** Score at which a rendered message is accepted as "the one". */
  const ACCEPT = 0.6;
  /** ...or a weaker score that beats every other message by a clear margin. */
  const STANDOUT_MIN = 0.3;
  const STANDOUT_GAP = 0.2;

  /** 2 for the same text (or one is the start of the other), else 0..1 similarity. */
  function closeness(a, b) {
    const x = text.normalize(a);
    const y = text.normalize(b);
    if (!x || !y) return 0;
    if (x === y) return 2;
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    if (short.length > 20 && long.startsWith(short)) return 2;
    return similarity.score(x.slice(0, 600), y.slice(0, 600));
  }

  /** What to compare messages against: the message text if known, else the matched prompt, plus what you typed. */
  function probes(target) {
    const out = [];
    if (target.text) out.push(target.text);
    if (target.prompt && !target.fromTitle) out.push(target.prompt);
    if (target.query) out.push(target.query);
    return out;
  }

  /**
   * Pick the message (from a conversation's list, e.g. ChatGPT's API) that the
   * target refers to. Used to learn its id and full text before the page renders.
   * @returns {{index: number, score: number}|null}
   */
  function resolve(messages, target) {
    let best = null;
    let second = 0;
    const list = probes(target);
    messages.forEach((m, index) => {
      const score = Math.max(0, ...list.map((p) => closeness(m.text, p)));
      // Earliest wins ties: that's where it was first answered.
      if (!best || score > best.score) {
        second = best ? best.score : 0;
        best = { index, score };
      } else if (score > second) second = score;
    });
    if (!best) return null;
    // Accept a clear match, or a weaker one that clearly stands out from the
    // rest of the chat (typical when only the chat's title matched).
    const standsOut = best.score >= STANDOUT_MIN && best.score - second >= STANDOUT_GAP;
    return best.score >= ACCEPT || standsOut ? best : null;
  }

  /**
   * Find the target among the rendered messages.
   * @returns {{index: number, score: number, via: 'message-id'|'text'|'similar'}|null}
   */
  function locate(rendered, target) {
    if (target.messageId) {
      const index = rendered.findIndex((m) => m.id && m.id === target.messageId);
      if (index >= 0) return { index, score: 2, via: 'message-id' };
    }
    const best = resolve(rendered, target);
    if (!best) return null;
    return { ...best, via: best.score >= 2 ? 'text' : 'similar' };
  }

  return { ACCEPT, closeness, resolve, locate };
});
