/*
 * The redirect policy: decides, for a prompt that is about to be sent, whether
 * Recall should step in and suggest an earlier conversation.
 *
 * The rules are evaluated in a fixed order and the first one that applies wins.
 * Every outcome carries a machine-readable `reason`, so the behaviour is easy to
 * test, to explain in the UI, and to document (see README "When does Recall
 * step in?").
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./text.js'), require('./similarity.js'));
  else root.RecallDefine('policy', ['text', 'similarity'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (text, similarity) {
  'use strict';

  /** Every possible decision. `intercept: true` only for MATCH. */
  const REASONS = Object.freeze({
    DISABLED: 'disabled',
    USER_OVERRIDE: 'user-override',
    TEMPORARY_CHAT: 'temporary-chat',
    HAS_ATTACHMENTS: 'has-attachments',
    EMPTY: 'empty',
    TOO_SHORT: 'too-short',
    GENERIC: 'generic',
    WANTS_NEW_ANSWER: 'wants-new-answer',
    NEEDS_FRESH_INFO: 'needs-fresh-info',
    CONTEXTUAL_FOLLOWUP: 'contextual-followup',
    PASTED_CONTENT: 'pasted-content',
    SNOOZED: 'snoozed',
    NO_MATCH: 'no-match',
    REPEAT_IN_THIS_CHAT: 'repeat-in-this-chat',
    MATCH: 'match',
  });

  const HUMAN = Object.freeze({
    [REASONS.DISABLED]: 'Recall is switched off.',
    [REASONS.USER_OVERRIDE]: 'You chose "Ask anyway" for this prompt.',
    [REASONS.TEMPORARY_CHAT]: 'Temporary chats are never checked or stored.',
    [REASONS.HAS_ATTACHMENTS]: 'The prompt has a file or image attached, so the answer depends on it.',
    [REASONS.EMPTY]: 'Nothing to check.',
    [REASONS.TOO_SHORT]: 'Too short to be a meaningful question.',
    [REASONS.GENERIC]: 'Small talk or a chat command (e.g. "hi", "continue", "thanks").',
    [REASONS.WANTS_NEW_ANSWER]: 'You explicitly asked for a new / fresh / different answer.',
    [REASONS.NEEDS_FRESH_INFO]: 'The question needs up-to-date information (news, prices, "latest", "today"...).',
    [REASONS.CONTEXTUAL_FOLLOWUP]: 'A follow-up that refers to the current conversation ("make it shorter", "what about...").',
    [REASONS.PASTED_CONTENT]: 'The prompt contains pasted code or a long document, so it is unique input.',
    [REASONS.SNOOZED]: 'You said this suggestion was not helpful for this prompt.',
    [REASONS.NO_MATCH]: 'No earlier chat is similar enough.',
    [REASONS.REPEAT_IN_THIS_CHAT]: 'You already asked this earlier in this same chat.',
    [REASONS.MATCH]: 'You asked this before.',
  });

  // Whole-prompt small talk and chat-control commands. Anchored: the entire
  // prompt must be one of these (ignoring punctuation and a trailing "please").
  const GENERIC_RE = new RegExp(
    '^(?:' +
      [
        'h(?:i|ello|ey|iya)(?: there)?',
        'yo', 'sup', 'good (?:morning|afternoon|evening|night)',
        'thanks?(?: you)?(?: so much| a lot)?', 'thx', 'ty', 'cheers', 'great', 'cool', 'nice', 'perfect', 'awesome',
        'ok(?:ay)?', 'k', 'yes', 'yeah', 'yep', 'no', 'nope', 'sure', 'got it', 'i see',
        'continue', 'go on', 'keep going', 'carry on', 'more', 'next', 'proceed', 'and', 'then',
        'what', 'why', 'how', 'really', 'huh', 'test(?:ing)?',
        '(?:please )?(?:try|do it|say (?:it|that)) again', 'again', 'retry', 'regenerate',
        'explain(?: it| that| this)?(?: again| more| better| simpler)?',
        'elaborate', 'expand', 'summari[sz]e(?: it| this| that)?', 'tl ?dr',
        'shorter', 'longer', 'simpler', 'in short', 'example', 'examples',
        'translate(?: it| this| that)?', 'fix it', 'fix this', 'stop',
        'who are you', 'what can you do', 'what are you',
      ].join('|') +
      ')(?: please| pls| plz)?$'
  );

  // Explicit requests for a new answer. This is the strongest signal: if the
  // user *asks* for something new, Recall never redirects, however similar the
  // rest of the prompt is.
  const WANTS_NEW_RE = new RegExp(
    [
      '\\b(?:generate|give|write|create|make|draft|produce|come up with|show)(?: me)? (?:a |an |some )?(?:new|fresh|different|another|other|alternative|brand new|second|more)\\b',
      '\\b(?:new|fresh|different|another|alternative|second) (?:answer|response|version|take|attempt|one|idea|ideas|option|options|variant|variation|perspective|angle|approach|draft|example|examples|set)\\b',
      '\\b(?:answer|respond|explain|do|write|generate|redo|rewrite|try) (?:it |this |that )?(?:again|afresh|anew|from scratch|one more time|differently)\\b',
      '\\b(?:regenerate|redo|re-?do|re-?answer|re-?explain)\\b',
      '\\b(?:again|once more|one more time)[\\s.!?]*$',
      '\\bfrom scratch\\b',
      '\\b(?:don\'?t|do not|dont) (?:redirect|repeat|reuse|send me)\\b',
      '\\b(?:not|without) (?:the )?(?:same|previous|old|last) (?:answer|response|one)\\b',
      '\\bask(?:ing)? (?:again|anyway)\\b',
      '\\bone more\\b',
    ].join('|'),
    'i'
  );

  // Time-sensitive questions: an old answer is likely stale.
  const FRESH_RE = new RegExp(
    [
      // Kept deliberately narrow: words like "current", "still" or "next month"
      // appear in plenty of timeless questions and must not block a redirect.
      '\\b(?:latest|newest|most recent|up[- ]to[- ]date|right now|as of (?:today|now))\\b',
      '\\b(?:today|tonight|tomorrow|yesterday|this (?:morning|week|weekend))\\b',
      '\\b(?:news|headlines?|breaking news|trending|live scores?|standings|weather|forecast)\\b',
      '\\b(?:stock price|share price|exchange rate|bitcoin price|crypto prices?|price of|prices of|how much (?:is|does|do) .* cost)\\b',
      '\\b(?:in|for|of|as of) 20[2-9]\\d\\b',
    ].join('|'),
    'i'
  );

  // Follow-ups that only make sense inside the current conversation.
  const CONTEXTUAL_RE = new RegExp(
    '^(?:' +
      [
        'what about\\b', 'how about\\b', 'what if\\b',
        'make (?:it|this|that|them)\\b', 'change (?:it|this|that)\\b', 'rewrite (?:it|this|that)\\b',
        'can you (?:make|change|rewrite|shorten|expand|fix|add|remove) (?:it|this|that|them)\\b',
        'same (?:but|for|with)\\b', 'do (?:it|this|that|the same)\\b',
        '(?:add|remove|use|include|without)\\b.*\\b(?:instead|too|as well)\\b',
      ].join('|') +
      ')|\\b(?:above|previous (?:answer|response|message|code)|your (?:last|previous) (?:answer|response|message)|the code you (?:gave|wrote|sent)|you just (?:said|wrote|gave))\\b',
    'i'
  );

  const CONNECTIVE_RE = /^(?:and|also|now|then|but|so|or)\b/i;

  const CODE_FENCE_RE = /```|~~~/;

  // Rules that judge the *content* of a prompt. An exact copy of something
  // you already asked in another chat overrides them: you clearly asked this
  // before. Rules about intent or context (asking for a new answer, small
  // talk, attachments, temporary chats, Recall switched off) never yield.
  const EXACT_OVERRIDES = new Set(['too-short', 'contextual-followup', 'needs-fresh-info', 'pasted-content']);

  /**
   * Pre-checks that don't need the index. Returns a reason string, or null when
   * the prompt is a candidate for matching.
   */
  function precheck(prompt, ctx = {}, settings = {}) {
    if (settings.enabled === false) return REASONS.DISABLED;
    if (ctx.bypass) return REASONS.USER_OVERRIDE;
    if (ctx.temporaryChat) return REASONS.TEMPORARY_CHAT;
    if (ctx.hasAttachments) return REASONS.HAS_ATTACHMENTS;

    const raw = String(prompt || '').trim();
    if (!raw) return REASONS.EMPTY;

    const norm = text.normalize(raw);
    // Order matters: an explicit "give me a new one" beats every other rule.
    if (WANTS_NEW_RE.test(raw) || WANTS_NEW_RE.test(norm)) return REASONS.WANTS_NEW_ANSWER;
    if (GENERIC_RE.test(norm)) return REASONS.GENERIC;

    const tokenCount = text.tokenize(raw).length;

    // A short deictic prompt ("what about in Java?", "make it shorter") is a
    // follow-up to the open conversation, not a standalone question.
    if (CONTEXTUAL_RE.test(norm) && tokenCount <= 12) return REASONS.CONTEXTUAL_FOLLOWUP;
    // A *very* short prompt opening with a connective ("and in Java?", "so why?").
    if (CONNECTIVE_RE.test(norm) && tokenCount <= 5) return REASONS.CONTEXTUAL_FOLLOWUP;

    const minChars = settings.minChars ?? 12;
    const minTokens = settings.minContentTokens ?? 3;
    if (raw.length < minChars || tokenCount < minTokens) return REASONS.TOO_SHORT;

    if (settings.freshnessGuard !== false && FRESH_RE.test(norm)) return REASONS.NEEDS_FRESH_INFO;

    const maxChars = settings.maxChars ?? 1500;
    if (CODE_FENCE_RE.test(raw) || raw.length > maxChars) return REASONS.PASTED_CONTENT;

    return null;
  }

  /**
   * Full decision.
   *
   * @param {string} prompt the text about to be sent
   * @param {object} ctx
   * @param {string|null} [ctx.conversationId] chat the user is currently in
   * @param {boolean} [ctx.bypass] user pressed "Ask anyway"
   * @param {boolean} [ctx.temporaryChat]
   * @param {boolean} [ctx.hasAttachments]
   * @param {(norm: string, convId: string) => boolean} [ctx.isSnoozed]
   * @param {{search: Function}} index a HistoryIndex
   * @param {object} settings
   * @returns {{intercept: boolean, reason: string, explanation: string, matches: Array}}
   */
  function evaluate(prompt, ctx, index, settings = {}) {
    ctx = ctx || {};
    const here = ctx.conversationId || null;
    const norm = text.normalize(prompt);
    const threshold = settings.threshold ?? 0.7;
    const notSnoozed = (m) => !(ctx.isSnoozed && ctx.isSnoozed(norm, m.conversationId));

    const pre = precheck(prompt, ctx, settings);
    let all;
    if (pre) {
      // Exact copies of something asked in *another* chat override the
      // content rules. (In the same chat, repeating "make it shorter" is a
      // normal follow-up, so no override there.)
      if (!EXACT_OVERRIDES.has(pre) || !index) return decision(pre);
      all = index.search(prompt, { topK: 6, minScore: 1 }).filter((m) => m.exact && m.conversationId !== here);
      if (!all.length) return decision(pre);
    }

    all = all || (index ? index.search(prompt, { topK: 6, minScore: threshold }) : []);

    // Repeating a question that is already in the open chat: point at the
    // earlier answer right here instead of generating it again.
    if (here && !pre) {
      const sameChat = all.filter((m) => m.conversationId === here);
      for (const p of ctx.visiblePrompts || []) {
        const score = p && similarity.score(p, prompt);
        if (score >= threshold) sameChat.push({ conversationId: here, prompt: p, score, title: '', createdAt: 0, sameChat: true });
      }
      const live = sameChat.filter(notSnoozed).sort((a, b) => b.score - a.score);
      if (live.length) return decision(REASONS.REPEAT_IN_THIS_CHAT, [{ ...live[0], sameChat: true }]);
    }

    const others = all.filter((m) => m.conversationId !== here);
    if (!others.length) return decision(REASONS.NO_MATCH);

    const live = others.filter(notSnoozed);
    if (!live.length) return decision(REASONS.SNOOZED);

    return decision(REASONS.MATCH, live.slice(0, settings.maxSuggestions ?? 3));
  }

  function decision(reason, matches = []) {
    const intercept = reason === REASONS.MATCH || reason === REASONS.REPEAT_IN_THIS_CHAT;
    return { intercept, reason, explanation: HUMAN[reason], matches };
  }

  return { REASONS, HUMAN, GENERIC_RE, WANTS_NEW_RE, FRESH_RE, CONTEXTUAL_RE, precheck, evaluate };
});
