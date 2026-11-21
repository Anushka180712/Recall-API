/*
 * Network-level safety net, running in the page's own JavaScript world.
 *
 * The keyboard/button check in content.js stops most repeats before ChatGPT
 * even sees them. But ChatGPT changes how its message box works from time to
 * time, and a send that reaches ChatGPT some other way would slip through.
 * Every message, however it is sent, ends up as one request:
 *
 *   POST /backend-api/conversation   (or /backend-api/f/conversation)
 *
 * This file wraps window.fetch, and for that request only:
 *   1. reads the user's message from the request body,
 *   2. asks Recall's content script (via DOM events) whether it may go,
 *   3. sends it on, or stops it (as if you pressed "Stop") when you chose
 *      "Take me there" or "Keep editing" in Recall's dialog.
 *
 * It fails open: if Recall doesn't answer within 400 ms (not running, or
 * switched off), the request goes through untouched. Regenerating an answer
 * ("variant"/"continue") is never held. Nothing is sent anywhere else.
 *
 * Messages between worlds are JSON strings, because object payloads don't
 * cross from the page world to the extension's isolated world.
 */
(function () {
  'use strict';
  if (window.__recallFetchHooked) return;
  window.__recallFetchHooked = true;

  const originalFetch = window.fetch;
  const SEND_PATH = /\/backend-api\/(?:f\/)?conversation\/?$/;
  const ANSWER_MS = 400; // Recall must at least acknowledge within this time
  const DECIDE_MS = 10 * 60 * 1000; // how long a held message may wait for you
  let seq = 0;

  /** The user's message in a ChatGPT "send" request body, or null. */
  function readMessage(body) {
    if (typeof body !== 'string') return null;
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return null;
    }
    if (!data || data.action === 'variant' || data.action === 'continue') return null; // regenerate / continue
    const msg = (data.messages || []).find((m) => m && m.author && m.author.role === 'user');
    if (!msg || !msg.content) return null;
    const parts = msg.content.parts || [];
    const text = parts.filter((p) => typeof p === 'string').join('\n').trim();
    if (!text) return null;
    const attachments = (msg.metadata && msg.metadata.attachments) || [];
    return {
      text,
      conversationId: data.conversation_id || null,
      hasAttachments: attachments.length > 0 || parts.some((p) => typeof p !== 'string'),
    };
  }

  /** Ask Recall; resolves true to send, false to stop. */
  function ask(info) {
    return new Promise((resolve) => {
      const id = `s${++seq}-${Math.random().toString(36).slice(2)}`;
      let timer = setTimeout(() => finish(true), ANSWER_MS);
      function finish(allow) {
        clearTimeout(timer);
        document.removeEventListener('recall:verdict', onVerdict);
        resolve(allow);
      }
      function onVerdict(e) {
        let v;
        try {
          v = JSON.parse(e.detail);
        } catch {
          return;
        }
        if (!v || v.id !== id) return;
        if (v.hold) {
          // Recall is showing its dialog: wait for your choice.
          clearTimeout(timer);
          timer = setTimeout(() => finish(true), DECIDE_MS);
          return;
        }
        finish(v.allow !== false);
      }
      document.addEventListener('recall:verdict', onVerdict);
      document.dispatchEvent(new CustomEvent('recall:send', { detail: JSON.stringify({ id, ...info }) }));
    });
  }

  function isSend(input, init) {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      return method === 'POST' && !!url && SEND_PATH.test(new URL(url, location.href).pathname);
    } catch {
      return false;
    }
  }

  window.fetch = async function recallFetch(input, init) {
    if (isSend(input, init)) {
      const info = readMessage(init && init.body);
      if (info && !(await ask(info))) {
        throw new DOMException('Recall held this message back', 'AbortError');
      }
    }
    return originalFetch.apply(this, arguments);
  };
})();
