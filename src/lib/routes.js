/*
 * URL helpers for chatgpt.com (and the legacy chat.openai.com domain).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecallDefine('routes', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Matches /c/<id>, /g/<gpt>/c/<id> and /g/<gpt>/project/c/<id> style paths.
  const CONVERSATION_RE = /\/c\/([0-9a-zA-Z][0-9a-zA-Z-]{5,})(?:[/?#]|$)/;

  function toURL(href) {
    try {
      return new URL(href, 'https://chatgpt.com');
    } catch {
      return null;
    }
  }

  /** The conversation id in a URL, or null on the "new chat" page. */
  function conversationId(href) {
    const url = toURL(href);
    if (!url) return null;
    const m = url.pathname.match(CONVERSATION_RE);
    return m ? m[1] : null;
  }

  function isTemporaryChat(href) {
    const url = toURL(href);
    return !!url && (url.searchParams.get('temporary-chat') === 'true' || url.searchParams.has('temporary'));
  }

  function conversationUrl(id, origin = 'https://chatgpt.com') {
    return `${origin}/c/${encodeURIComponent(id)}`;
  }

  return { conversationId, isTemporaryChat, conversationUrl };
});
