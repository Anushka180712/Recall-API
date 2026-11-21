/*
 * Everything that knows about ChatGPT's page structure lives here.
 *
 * ChatGPT's markup changes often, so every lookup tries several selectors,
 * from most to least specific, and callers handle `null` gracefully.
 */
(function (root) {
  'use strict';

  const SELECTORS = {
    composer: [
      '#prompt-textarea',
      'div[contenteditable="true"].ProseMirror',
      'form textarea',
      'main [contenteditable="true"]',
    ],
    sendButton: [
      'button[data-testid="send-button"]',
      'button#composer-submit-button',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
    ],
    userMessage: ['[data-message-author-role="user"]'],
    sidebarLink: ['nav a[href*="/c/"]', 'aside a[href*="/c/"]'],
    attachment: [
      '[data-testid*="attachment"]',
      'form [data-testid="file-thumbnail"]',
      'form img[alt*="upload" i]',
      'form button[aria-label*="Remove file" i]',
    ],
  };

  function first(list, scope = document) {
    for (const sel of list) {
      const el = scope.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function all(list, scope = document) {
    const seen = new Set();
    for (const sel of list) for (const el of scope.querySelectorAll(sel)) seen.add(el);
    return [...seen];
  }

  function composer() {
    return first(SELECTORS.composer);
  }

  function sendButton() {
    return first(SELECTORS.sendButton);
  }

  function isInComposer(node) {
    const c = composer();
    return !!(c && node && (c === node || c.contains(node)));
  }

  function isSendButton(node) {
    const btn = node && node.closest && node.closest('button');
    if (!btn) return false;
    return SELECTORS.sendButton.some((sel) => btn.matches(sel));
  }

  function composerText() {
    const c = composer();
    if (!c) return '';
    if ('value' in c && typeof c.value === 'string') return c.value;
    return c.innerText || c.textContent || '';
  }

  function hasAttachments() {
    const form = composer() && composer().closest('form');
    return !!(form && first(SELECTORS.attachment, form));
  }

  /** User messages rendered in the open conversation, top to bottom. */
  function visibleUserPrompts() {
    return all(SELECTORS.userMessage)
      .map((el) => (el.innerText || el.textContent || '').trim())
      .filter(Boolean);
  }

  /** Conversations listed in the sidebar: [{id, title}] (dates aren't shown there). */
  function sidebarConversations(conversationIdFromHref) {
    const out = new Map();
    for (const a of all(SELECTORS.sidebarLink)) {
      const id = conversationIdFromHref(a.getAttribute('href'));
      if (id && !out.has(id)) out.set(id, { id, title: (a.innerText || a.textContent || '').trim() });
    }
    return [...out.values()];
  }

  function titleFor(id, conversationIdFromHref) {
    const hit = sidebarConversations(conversationIdFromHref).find((c) => c.id === id);
    if (hit && hit.title) return hit.title;
    const t = (document.title || '').replace(/\s*[|-]\s*ChatGPT\s*$/i, '').trim();
    return /^chatgpt$/i.test(t) ? '' : t;
  }

  root.RecallDom = {
    SELECTORS,
    composer,
    sendButton,
    isInComposer,
    isSendButton,
    composerText,
    hasAttachments,
    visibleUserPrompts,
    sidebarConversations,
    titleFor,
  };
})(globalThis);
