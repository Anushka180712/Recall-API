/*
 * Recall content script: wires the pure libraries (src/lib) to chatgpt.com.
 *
 *   1. Intercepts "send" (Enter key, send button, form submit) in the capture
 *      phase, *before* ChatGPT sees it, and runs the redirect policy.
 *   2. Learns prompts: the ones you send, the ones in chats you open, and
 *      (on request) your existing history via ChatGPT's own endpoints.
 *   3. Hosts the cleanup panel and the occasional "tidy up?" nudge.
 */
(function () {
  'use strict';
  // No "already loaded" early exit on purpose: when Recall is updated, the
  // fresh copy injected into this tab can share globals with the old one, and
  // an early exit would leave the tab with no working copy until a reload.
  // Instead the newest copy always starts and older copies step aside.

  const { policy, historyIndex, routes, cleanup, chatgptApi, store: storeMod } = globalThis.Recall;
  const dom = globalThis.RecallDom;
  // Levelled logs (src/lib/log.js): warnings only, unless "Debug logging" is on.
  const log = globalThis.Recall.log.create('content');

  const t = (key, fallback, subs) => globalThis.Recall.i18n.t(key, fallback, subs);
  const UNTITLED_RE = /^(?:new chat|untitled|new conversation)$/i;

  // ------------------------------------------------------- lifecycle guard
  // When the extension is updated, reloaded or disabled, this script keeps
  // running in already-open tabs but every chrome.* API stops working
  // ("Extension context invalidated"). We detect that, step aside cleanly so
  // ChatGPT keeps working normally, and either hand over to the freshly
  // injected copy or ask for a page reload.
  const INSTANCE = Math.random().toString(36).slice(2);
  document.documentElement.dataset.recallInstance = INSTANCE;
  globalThis.__recallInstance = INSTANCE;
  const cleanups = [];
  let retired = false;

  // Tell an older copy sharing this script world to step aside right away.
  const previousRetire = globalThis.__recallRetire;
  globalThis.__recallRetire = () => retire({ quiet: true });

  /** A newer copy of Recall started in this tab (after an update or re-injection). */
  function superseded() {
    return globalThis.__recallInstance !== INSTANCE && globalThis.__recallInstance !== undefined;
  }

  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  /** Register a window listener that is removed when this copy retires. */
  function on(type, fn, capture) {
    const wrapped = (e) => {
      if (retired) return;
      if (superseded()) return retire({ quiet: true });
      if (!contextAlive()) return retire();
      try {
        fn(e);
      } catch (err) {
        // Fail open: a bug in Recall must never stop you from sending.
        log.error(`${type} handler failed`, { error: err && err.message });
      }
    };
    window.addEventListener(type, wrapped, capture);
    cleanups.push(() => window.removeEventListener(type, wrapped, capture));
  }

  function retire({ quiet = false } = {}) {
    if (retired) return;
    retired = true;
    log.info(quiet ? 'a newer copy took over' : 'stepping aside', { instance: INSTANCE });
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    overlay.closeModal();
    overlay.setLauncher(false);
    if (quiet) {
      overlay.dead = true;
      return overlay.host.remove();
    }
    // Give a freshly injected copy a moment to take over before asking for a reload.
    setTimeout(() => {
      if (document.documentElement.dataset.recallInstance !== INSTANCE || superseded()) {
        overlay.host.remove(); // a newer copy is running: disappear quietly
        return;
      }
      log.info('extension context gone; asking for a reload');
      overlay.toast(
        t('reloadMsg', 'Recall was updated or restarted. Reload this page to switch it back on. ChatGPT works normally in the meantime.'),
        [{ label: t('later', 'Later') }, { label: t('reloadBtn', 'Reload page'), primary: true, onClick: () => location.reload() }],
        { testid: 'recall-reload' }
      );
    }, 1500);
  }

  if (typeof previousRetire === 'function') {
    try {
      previousRetire();
    } catch {
      /* the old copy is gone already */
    }
  }

  const store = storeMod.createStore();
  const api = chatgptApi.createClient({ origin: location.origin });
  const overlay = new globalThis.RecallOverlay();

  const state = {
    settings: null,
    index: new historyIndex.HistoryIndex(),
    snoozes: {},
    bypassUntil: 0, // set by "Ask anyway": the next send goes straight through
    lastHandled: { text: '', at: 0, type: '' },
    pending: null, // prompt sent from the "new chat" page, waiting for its conversation id
    href: location.href,
    saveTimer: 0,
    removed: [],
    importing: false,
    dirty: false,
    pausedUntil: 0, // "Pause for 1 hour": no checks until this time
    allowed: null, // last prompt the keyboard/button check let through, for the network check
  };

  // ------------------------------------------------------------------ boot
  async function init() {
    try {
      const [settings, index, snoozes, pausedUntil] = await Promise.all([
        store.getSettings(),
        store.loadIndex(),
        store.getSnoozes(),
        store.getPausedUntil(),
      ]);
      state.settings = settings;
      state.index = index;
      state.snoozes = snoozes;
      state.pausedUntil = pausedUntil;
    } catch (err) {
      log.warn('could not load saved data, starting fresh', { error: err.message });
      state.settings = globalThis.Recall.settings.sanitize({});
    }
    if (retired) return; // a newer copy took over while we were loading
    globalThis.Recall.log.configure(state.settings);
    overlay.mount();
    overlay.setLauncher(state.settings.enabled && state.settings.showLauncher, openCleanup);
    observeConversation();
    const timer = setInterval(() => {
      if (superseded()) retire({ quiet: true });
      else if (!contextAlive()) retire();
      else checkUrl();
    }, 400);
    cleanups.push(() => clearInterval(timer));
    setTimeout(firstRunAndNudges, 1500);
    jumpToTarget(); // arrived here via "Take me there" (full page load)
    setTimeout(checkHealth, 4000);
    log.info('ready', state.index.stats());
  }

  /**
   * ChatGPT changes its page from time to time. If Recall can't find the
   * message box, it records that so the popup can say so plainly, instead of
   * silently doing nothing. Recall never blocks sending when this happens.
   */
  function checkHealth() {
    if (retired || !contextAlive()) return;
    const composer = !!dom.composer();
    if (!composer) log.warn('message box not found; ChatGPT may have changed its page', { selectors: dom.SELECTORS.composer });
    store.setHealth({ composer, url: location.pathname.startsWith('/c/') ? '/c/…' : location.pathname }).catch(() => {});
  }

  // ------------------------------------------------------- send interception
  function currentContext() {
    const s = state.snoozes;
    return {
      conversationId: routes.conversationId(location.href),
      temporaryChat: routes.isTemporaryChat(location.href),
      paused: state.pausedUntil > Date.now(),
      hasAttachments: dom.hasAttachments(),
      visiblePrompts: routes.conversationId(location.href) ? currentChatPrompts() : [],
      isSnoozed: (norm, convId) => (s[`${globalThis.Recall.text.hash(norm)}:${convId}`] || 0) > Date.now(),
    };
  }

  /**
   * Shared entry point for every way of sending. Must stay synchronous: once
   * we return, ChatGPT's own handler runs and the message is gone.
   */
  function handleSend(event) {
    if (!state.settings) return log.warn('send not checked: settings not loaded yet');
    if (overlay.isOpen) return;
    const prompt = dom.composerText().trim();
    if (!prompt) return;

    const now = Date.now();
    // One physical send can surface as keydown + click + submit within a few
    // milliseconds; handle it once. Kept short and limited to *different*
    // event types, so sending the same text again a moment later is checked.
    const last = state.lastHandled;
    if (last.text === prompt && last.type !== event.type && now - last.at < 800) return;

    if (state.bypassUntil > now) {
      state.bypassUntil = 0; // "Ask anyway" covers exactly one send
      log.debug('send let through once (Ask anyway)', { via: event.type });
      letThrough(prompt);
      return;
    }
    state.bypassUntil = 0;

    const decision = decide(prompt, event.type);
    if (!decision.intercept) {
      letThrough(prompt);
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    store.bumpStat('suggestions').catch(() => {});

    overlay.showRedirect({
      prompt,
      matches: decision.matches,
      onOpen: (m) => {
        store.bumpStat('redirects').catch(() => {});
        openAndJump(m, prompt);
      },
      onAskAnyway: () => {
        store.bumpStat('overrides').catch(() => {});
        resend();
      },
      onNotHelpful: async (m) => {
        state.snoozes = await store.snooze(prompt, m.conversationId, state.settings.snoozeDays);
        resend({ bypass: false }); // re-check: other matches may remain, else it sends
      },
      onCancel: () => {
        const c = dom.composer();
        if (c) c.focus();
      },
      onPause: async () => {
        state.pausedUntil = await store.pause(60 * 60 * 1000);
        log.info('paused for 1 hour');
        const until = new Date(state.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        overlay.toast(t('pausedUntil', 'Recall is paused until {0}.', until), [
          { label: t('resume', 'Resume now'), onClick: () => store.resume() },
        ], { timeout: 8000, testid: 'recall-paused' });
        resend(); // send the message you were about to send
      },
    });
  }

  /** Run the rules for a prompt, log the outcome and record it for the popup. */
  function decide(prompt, via, extra = {}) {
    const ctx = { ...currentContext(), ...extra, hasAttachments: currentContext().hasAttachments || !!extra.hasAttachments };
    const decision = policy.evaluate(prompt, ctx, state.index, state.settings);
    log.debug('decision', {
      via,
      reason: decision.reason,
      prompt: log.text(prompt),
      matches: decision.matches.map((m) => ({ chat: m.conversationId, score: Math.round(m.score * 100) / 100, exact: !!m.exact })),
    });
    // Shown in the popup as "Last check", so you can always see why Recall did
    // or didn't step in for the message you just sent.
    store.setLastDecision({
      at: Date.now(),
      reason: decision.reason,
      explanation: decision.explanation,
      prompt: globalThis.Recall.text.truncate(prompt, 80),
      known: state.index.stats().prompts,
    }).catch(() => {});
    return decision;
  }

  /** The prompt is going to ChatGPT: learn it, and tell the network check it was already approved. */
  function letThrough(prompt) {
    remember(prompt);
    state.allowed = { norm: globalThis.Recall.text.normalize(prompt), at: Date.now() };
  }

  function recentlyAllowed(prompt) {
    const a = state.allowed;
    return !!a && a.norm === globalThis.Recall.text.normalize(prompt) && Date.now() - a.at < 20000;
  }

  // ------------------------------------------------ network-level safety net
  // src/content/page-hook.js (running in the page's own world) holds ChatGPT's
  // "send message" request and asks us here. Anything the keyboard/button
  // check above already approved goes straight through; anything it never saw
  // (ChatGPT changed its page, a shortcut we don't know, a voice send...) is
  // checked now, so every single send is checked.
  function onNetworkSend(e) {
    if (retired || superseded()) return;
    if (!contextAlive()) return retire();
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch {
      return;
    }
    const reply = (v) => document.dispatchEvent(new CustomEvent('recall:verdict', { detail: JSON.stringify({ id: req.id, ...v }) }));
    try {
      if (!state.settings || overlay.isOpen || recentlyAllowed(req.text)) return reply({ allow: true });
      const decision = decide(req.text, 'network', { hasAttachments: req.hasAttachments });
      log.warn('a send reached ChatGPT without passing the keyboard/button check; checked it at the network level', { reason: decision.reason });
      if (!decision.intercept) {
        letThrough(req.text);
        return reply({ allow: true });
      }
      reply({ hold: true });
      store.bumpStat('suggestions').catch(() => {});
      const send = () => {
        letThrough(req.text);
        reply({ allow: true });
      };
      overlay.showRedirect({
        prompt: req.text,
        matches: decision.matches,
        onOpen: (m) => {
          reply({ allow: false });
          store.bumpStat('redirects').catch(() => {});
          openAndJump(m, req.text);
        },
        onAskAnyway: () => {
          store.bumpStat('overrides').catch(() => {});
          send();
        },
        onNotHelpful: async (m) => {
          state.snoozes = await store.snooze(req.text, m.conversationId, state.settings.snoozeDays);
          send();
        },
        onCancel: () => {
          reply({ allow: false });
          restoreComposer(req.text);
        },
        onPause: async () => {
          state.pausedUntil = await store.pause(60 * 60 * 1000);
          send();
        },
      });
    } catch (err) {
      log.error('network check failed; letting the message through', { error: err && err.message });
      reply({ allow: true });
    }
  }
  document.addEventListener('recall:send', onNetworkSend);
  cleanups.push(() => document.removeEventListener('recall:send', onNetworkSend));

  /** Put a held-back message back in the message box so you can edit it. */
  function restoreComposer(prompt) {
    setTimeout(() => {
      const c = dom.composer();
      if (!c) return;
      c.focus();
      if ('value' in c && typeof c.value === 'string') {
        c.value = prompt;
      } else {
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, prompt);
      }
      c.dispatchEvent(new Event('input', { bubbles: true }));
    }, 300);
  }

  function resend({ bypass = true } = {}) {
    state.lastHandled = { text: '', at: 0, type: '' };
    if (bypass) state.bypassUntil = Date.now() + 3000;
    const btn = dom.sendButton();
    if (btn && !btn.disabled) {
      btn.click();
      return;
    }
    const c = dom.composer();
    if (c) {
      c.focus();
      c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  on(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      if (!dom.isInComposer(e.target)) return;
      handleSend(e);
      markHandled(e);
    },
    true
  );

  on(
    'click',
    (e) => {
      if (!dom.isSendButton(e.target)) return;
      handleSend(e);
      markHandled(e);
    },
    true
  );

  on(
    'submit',
    (e) => {
      if (!e.target || !e.target.contains(dom.composer())) return;
      handleSend(e);
      markHandled(e);
    },
    true
  );

  function markHandled(e) {
    if (e.defaultPrevented && overlay.isOpen) return; // intercepted: not sent yet
    const prompt = dom.composerText().trim();
    if (prompt) state.lastHandled = { text: prompt, at: Date.now(), type: e.type };
  }

  // --------------------------------------------------------------- learning
  function remember(prompt) {
    if (routes.isTemporaryChat(location.href)) return; // never store temporary chats
    const conversationId = routes.conversationId(location.href);
    if (conversationId) {
      addPrompt(conversationId, prompt, Date.now(), 'sent');
    } else {
      state.pending = { prompt, at: Date.now() }; // id appears once ChatGPT creates the chat
    }
  }

  function addPrompt(conversationId, prompt, createdAt, source) {
    const title = dom.titleFor(conversationId, routes.conversationId);
    if (state.index.add({ conversationId, prompt, createdAt, source, title })) scheduleSave();
    else if (title) state.index.touchConversation(conversationId, title, createdAt || 0);
  }

  /**
   * Messages of the chat we just left. ChatGPT keeps them on screen for a
   * moment after the URL changes; they must not be learned (or matched) as
   * belonging to the new chat.
   */
  let leftoverMessages = new WeakSet();

  /** User messages on screen that really belong to the open chat. */
  function currentChatPrompts() {
    return userMessageEls()
      .filter((el) => !leftoverMessages.has(el))
      .map((el) => (el.innerText || el.textContent || '').trim())
      .filter(Boolean);
  }

  function checkUrl() {
    if (location.href === state.href) return;
    const from = routes.conversationId(state.href);
    state.href = location.href;
    const id = routes.conversationId(location.href);
    // Switching between two existing chats: what's on screen is the old one.
    // (From the new-chat page to its new id, the messages are the new chat's.)
    leftoverMessages = from && from !== id ? new WeakSet(userMessageEls()) : new WeakSet();
    log.debug('chat changed', { from, to: id });
    if (state.pending && id && Date.now() - state.pending.at < 60000 && !routes.isTemporaryChat(location.href)) {
      addPrompt(id, state.pending.prompt, state.pending.at, 'sent');
      state.pending = null;
    }
    scheduleScrape();
    jumpToTarget();
  }

  // ------------------------------------------------- "Take me there" jump
  const JUMP_KEY = 'recall.jump';
  const jumpLog = globalThis.Recall.log.create('jump');
  const { jump: jumpMod } = globalThis.Recall;

  /** Message elements of the chat that was open before we navigated away (still on screen for a moment). */
  let staleMessages = new WeakSet();

  function saveJump(target) {
    try {
      sessionStorage.setItem(JUMP_KEY, JSON.stringify(target));
    } catch {
      /* storage blocked: we still open the chat */
    }
  }

  function loadJump() {
    try {
      return JSON.parse(sessionStorage.getItem(JUMP_KEY) || 'null');
    } catch {
      return null;
    }
  }

  /**
   * Open the earlier chat and remember which message to scroll to. The target
   * lives in sessionStorage so it survives a full page load as well as
   * ChatGPT's in-app navigation.
   *
   * @param {object} m the chosen match ({conversationId, prompt, source, sameChat})
   * @param {string} query what you had just typed
   */
  function openAndJump(m, query) {
    const target = {
      id: m.conversationId,
      prompt: m.prompt,
      query,
      fromTitle: m.source === 'title',
      at: Date.now(),
    };
    jumpLog.info('take me there', { chat: m.conversationId, fromTitle: target.fromTitle, sameChat: !!m.sameChat });
    if (m.sameChat) {
      // Already here: clear the repeated draft and scroll up to the earlier answer.
      clearComposer();
      staleMessages = new WeakSet();
      saveJump(target);
      jumpToTarget();
      return;
    }
    // Everything on screen now belongs to the chat we're leaving.
    staleMessages = new WeakSet(userMessageEls());
    saveJump(target);
    lookUpMessage(target);

    const link = document.querySelector(`nav a[href$="/c/${CSS.escape(m.conversationId)}"], aside a[href$="/c/${CSS.escape(m.conversationId)}"]`);
    if (link) link.click(); // in-app navigation: no full reload, much faster
    else location.assign(routes.conversationUrl(m.conversationId, location.origin));
    // If the click didn't navigate (e.g. the sidebar link is inert), fall back.
    setTimeout(() => {
      if (routes.conversationId(location.href) !== m.conversationId) location.assign(routes.conversationUrl(m.conversationId, location.origin));
    }, 1500);
  }

  /**
   * Ask ChatGPT (in the background) for that chat's messages, to learn the
   * exact message's id and full text. The page renders the id as
   * data-message-id, which is the most reliable anchor there is. If this
   * fails, text matching still works.
   */
  let lookupInFlight = 0;
  async function lookUpMessage(target) {
    lookupInFlight = target.at;
    try {
      const conv = await api.getConversation(target.id);
      const hit = jumpMod.resolve(conv.messages || [], target);
      const current = loadJump();
      if (current && current.at === target.at) {
        current.lookedUp = true;
        saveJump(current);
      }
      if (!hit || !current || current.at !== target.at) return jumpLog.debug('message lookup: no confident match', { messages: (conv.messages || []).length });
      const msg = conv.messages[hit.index];
      Object.assign(current, { messageId: msg.id, text: msg.text });
      saveJump(current);
      jumpLog.debug('message lookup', { messageId: msg.id, position: hit.index + 1, of: conv.messages.length, score: Math.round(hit.score * 100) / 100 });
    } catch (err) {
      if (err.status === 404) {
        // Deleted since Recall learned it (e.g. from ChatGPT's sidebar).
        clearInterval(jumpTimer);
        try {
          sessionStorage.removeItem(JUMP_KEY);
        } catch {
          /* ignore */
        }
        forgetChats([target.id], 'opened a deleted chat');
        overlay.toast(t('chatGone', 'That chat was deleted, so Recall has forgotten it.'), [], { timeout: 6000, testid: 'recall-chat-gone' });
        return;
      }
      jumpLog.debug('message lookup failed; using text matching', { error: err.message });
    }
  }

  function clearComposer() {
    const c = dom.composer();
    if (!c) return;
    c.focus();
    if ('value' in c && typeof c.value === 'string') c.value = '';
    else {
      // Select all + delete keeps ProseMirror's own state in sync.
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
    }
    c.dispatchEvent(new Event('input', { bubbles: true }));
  }

  let jumpTimer = 0;
  /**
   * Scroll to the remembered message once the chat has rendered.
   *
   * ChatGPT keeps the previous chat on screen for a moment, renders the new one
   * in several passes, and then scrolls itself to the newest message, which
   * would undo a naive scroll. So we:
   *   1. ignore messages left over from the previous chat,
   *   2. look for ChatGPT's own message id first (instant and exact), else wait
   *      until the messages stop changing and match by text,
   *   3. if it isn't rendered yet, scroll the chat to the top so older turns
   *      load, and keep going while new ones appear,
   *   4. scroll it to the middle of the view (clear of the sticky header),
   *      outline it, and keep it there for a few seconds unless you scroll.
   */
  function jumpToTarget() {
    const first = loadJump();
    if (!first || Date.now() - first.at > 60000) return;
    if (routes.conversationId(location.href) !== first.id) return;
    clearInterval(jumpTimer);
    if (!first.lookedUp && lookupInFlight !== first.at) {
      // Arrived by a full page load before the lookup finished: do it here.
      lookUpMessage(first);
    }

    const started = Date.now();
    let lastCount = -1;
    let stableSince = Date.now();
    let loadAttempts = 0;
    let noGrowth = 0;
    let countAtLastLoad = 0;
    let lastReport = 0;
    jumpTimer = setInterval(() => {
      if (retired) return clearInterval(jumpTimer);
      const target = loadJump() || first; // picks up the id/text once the lookup returns
      const els = userMessageEls().filter((el) => !staleMessages.has(el));
      const rendered = els.map((el) => ({ id: messageIdOf(el), text: el.innerText || el.textContent || '' }));
      const timedOut = Date.now() - started > 20000;

      // Fast path: ChatGPT's own message id is on the page.
      if (target.messageId) {
        const hit = jumpMod.locate(rendered, { messageId: target.messageId });
        if (hit) return finish(target, els[hit.index], hit, els.length);
      }

      if (els.length !== lastCount) {
        lastCount = els.length;
        stableSince = Date.now();
        if (!timedOut) return;
      }
      if (!timedOut && (!els.length || Date.now() - stableSince < 700)) return; // still rendering

      const hit = els.length ? jumpMod.locate(rendered, target) : null;
      if (!hit && !timedOut && loadAttempts < 15 && noGrowth < 3) {
        // Not rendered yet: scroll the chat to the top so older turns load,
        // and keep going while new (older) messages keep appearing.
        if (els.length <= countAtLastLoad) noGrowth++;
        else noGrowth = 0;
        countAtLastLoad = els.length;
        const box = scrollParent(els[0]);
        if (box) box.scrollTop = 0;
        els[0].scrollIntoView({ block: 'start' });
        loadAttempts++;
        stableSince = Date.now();
        if (Date.now() - lastReport > 2000) {
          lastReport = Date.now();
          jumpLog.debug('not on screen yet, loading older messages', { rendered: els.length, attempt: loadAttempts });
        }
        return;
      }
      finish(target, hit ? els[hit.index] : null, hit, els.length);
    }, 200);

    function finish(target, el, hit, count) {
      clearInterval(jumpTimer);
      try {
        sessionStorage.removeItem(JUMP_KEY);
      } catch {
        /* ignore */
      }
      staleMessages = new WeakSet();
      highlightSidebar(target.id);
      if (el) {
        jumpLog.info('found the message', { via: hit.via, score: Math.round(hit.score * 100) / 100, position: hit.index + 1, of: count, ms: Date.now() - started });
        reveal(el);
      } else {
        jumpLog.warn('could not find the message on the page', {
          rendered: count,
          hadMessageId: !!target.messageId,
          selectors: dom.SELECTORS.userMessage,
          ms: Date.now() - started,
        });
        overlay.toast(t('jumpMissed', 'Opened the chat, but couldn’t find that exact message on the page. Scroll to look for it.'), [], { timeout: 6000, testid: 'recall-jump-missed' });
      }
    }
  }

  function userMessageEls() {
    return dom.userMessages ? dom.userMessages() : [...document.querySelectorAll(dom.SELECTORS.userMessage.join(','))];
  }

  /** ChatGPT's message id for a rendered message, if it has one. */
  function messageIdOf(el) {
    const holder = el.closest('[data-message-id]') || el.querySelector('[data-message-id]');
    return holder ? holder.getAttribute('data-message-id') : null;
  }

  function scrollParent(el) {
    for (let n = el && el.parentElement; n; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement;
  }

  /** In view, and not hidden behind a sticky header at the top. */
  function inView(el) {
    const r = el.getBoundingClientRect();
    return r.top >= 64 && r.top < window.innerHeight - 40;
  }

  /** Scroll a message to the middle of the view, highlight it, and hold it there briefly. */
  function reveal(el) {
    let userScrolled = false;
    const stop = () => (userScrolled = true);
    const opts = { passive: true, capture: true, once: true };
    const events = ['wheel', 'touchmove', 'keydown'];
    for (const type of events) window.addEventListener(type, stop, opts);
    // The whole turn when there is one, so the message isn't cut off.
    const box = el.closest('article, [data-testid^="conversation-turn"]') || el;
    const tall = box.getBoundingClientRect().height > window.innerHeight * 0.6;
    const go = () => !userScrolled && el.isConnected && box.scrollIntoView({ block: tall ? 'start' : 'center', behavior: 'auto' });
    go();
    flash(el, 'recall-jump-target', 4500);
    overlay.pin(el, t('jumpBadge', 'You asked this here'), 4500);
    // ChatGPT scrolls to the newest message after loading; put ours back.
    for (const ms of [150, 400, 800, 1300, 2000, 3000, 4000]) setTimeout(() => !inView(el) && go(), ms);
    setTimeout(() => {
      for (const type of events) window.removeEventListener(type, stop, opts);
    }, 4500);
  }

  function highlightSidebar(id) {
    const link = document.querySelector(`nav a[href$="/c/${CSS.escape(id)}"], aside a[href$="/c/${CSS.escape(id)}"]`);
    if (!link) return;
    link.scrollIntoView({ block: 'nearest' });
    flash(link, 'recall-jump-link');
  }

  /** Briefly outline an element of the page (inline styles, restored afterwards). */
  function flash(el, marker, ms = 2800) {
    const prev = { outline: el.style.outline, outlineOffset: el.style.outlineOffset, transition: el.style.transition, boxShadow: el.style.boxShadow };
    el.setAttribute('data-recall-highlight', marker);
    Object.assign(el.style, {
      transition: 'outline-color .6s ease, box-shadow .6s ease',
      outline: '3px solid #6366f1',
      outlineOffset: '4px',
      boxShadow: '0 0 0 8px rgba(99, 102, 241, .18)',
    });
    setTimeout(() => {
      Object.assign(el.style, prev);
      el.removeAttribute('data-recall-highlight');
    }, ms);
  }

  let scrapeTimer = 0;
  function scheduleScrape() {
    clearTimeout(scrapeTimer);
    scrapeTimer = setTimeout(scrapeOpenConversation, 1000);
  }

  /** Learn from the chat on screen, so old chats become searchable just by opening them. */
  function scrapeOpenConversation() {
    if (retired || !state.settings || !state.settings.passiveIndexing) return;
    if (routes.isTemporaryChat(location.href)) return;
    const id = routes.conversationId(location.href);
    if (!id) return;
    let added = 0;
    for (const p of currentChatPrompts()) {
      if (state.index.add({ conversationId: id, prompt: p, createdAt: 0, source: 'opened', title: dom.titleFor(id, routes.conversationId) })) added++;
    }
    if (added) scheduleSave();
  }

  function observeConversation() {
    const target = document.querySelector('main') || document.body;
    if (!target) return;
    const mo = new MutationObserver(() => scheduleScrape());
    mo.observe(target, { childList: true, subtree: true });
    cleanups.push(() => mo.disconnect());
    scheduleScrape();
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.dirty = true;
    state.saveTimer = setTimeout(flush, 800);
  }

  async function flush() {
    clearTimeout(state.saveTimer);
    if (!state.dirty || retired || !contextAlive()) return;
    state.dirty = false;
    try {
      const removed = state.removed.splice(0);
      await store.saveIndex(state.index, { removedConversations: removed });
    } catch (err) {
      state.dirty = true;
      log.warn('could not save index', { error: err.message });
    }
  }

  // Don't lose freshly learned prompts when the tab is hidden or closed.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  window.addEventListener('pagehide', () => {
    scrapeOpenConversation();
    flush();
  });

  // ----------------------------------------------------------------- import
  /**
   * Learn from existing history. Built to feel instant:
   *   1. one quick call lists recent chats and their titles are indexed at once,
   *      so Recall is useful within a second or two;
   *   2. the prompts inside each chat are then fetched several at a time in the
   *      background (you can hide the progress and keep chatting);
   *   3. it's incremental: chats already learned and unchanged are skipped, and
   *      progress is saved as it goes, so a closed tab resumes where it stopped.
   */
  async function importHistory({ limit = 200 } = {}) {
    if (state.importing) return { skipped: true };
    state.importing = true;
    log.info('import started');
    const ui = overlay.progress(t('importReading', 'Reading your chat list…'), { testid: 'recall-import' });
    try {
      const convs = await listConversationsCached({ limit, fresh: true });

      // Phase 1: titles, instantly.
      const todo = [];
      for (const c of convs) {
        const known = state.index.conversations.get(c.id);
        const hasPrompts = state.index.promptsFor(c.id).length > 0;
        state.index.touchConversation(c.id, c.title, c.updatedAt);
        if (c.title && !UNTITLED_RE.test(c.title)) {
          state.index.add({ conversationId: c.id, prompt: c.title, createdAt: c.createdAt, title: c.title, source: 'title' });
        }
        if (!hasPrompts || !known || (known.updatedAt || 0) < c.updatedAt) todo.push(c);
      }
      scheduleSave();

      // Phase 2: prompts, in parallel, indexed as each chat arrives.
      let added = 0;
      let failed = 0;
      let lastPaint = 0;
      const meta = new Map(todo.map((c) => [c.id, c]));
      if (todo.length) {
        ui.update(`Recall can already spot repeats. Reading ${todo.length} chats for more detail… (you can keep chatting)`, 0.05);
        await api.getConversations(todo.map((c) => c.id), {
          onResult: (full) => {
            if (full.error) {
              failed++;
              return log.debug('import: skipped a chat', { chat: full.id, error: full.error });
            }
            const c = meta.get(full.id);
            for (const p of full.prompts) {
              if (state.index.add({ conversationId: c.id, prompt: p, createdAt: c.createdAt, title: c.title, source: 'imported' })) added++;
            }
          },
          onProgress: (done, total) => {
            const now = Date.now();
            if (now - lastPaint > 300 || done === total) {
              lastPaint = now;
              ui.update(t('importProgress', 'Learning from your chats… {0} of {1} (you can keep chatting)', [done, total]), 0.05 + 0.95 * (done / total));
            }
            if (done % 25 === 0) scheduleSave();
          },
        });
      }
      await store.saveIndex(state.index);
      await store.setMeta({ lastImportAt: Date.now() });
      const s = state.index.stats();
      const skipped = failed ? ` ${failed} chat${failed === 1 ? '' : 's'} couldn’t be read; open them once and Recall will learn them.` : '';
      ui.done(t('importDone', 'Done. Recall now knows {0} prompts from {1} chats ({2} new).', [s.prompts, s.conversations, added]) + skipped, failed ? 10000 : 6000);
      log.info('import done', { ...s, added, failed });
      return { added, ...s };
    } catch (err) {
      log.warn('import failed', { error: err.message });
      ui.done(`Import didn’t work (${err.message}). Recall still learns from chats you send and open.`, 8000);
      return { error: err.message };
    } finally {
      state.importing = false;
    }
  }

  // ------------------------------------------------- deleted chats
  // Chats can be deleted three ways, and Recall forgets them in all three:
  //   1. with Recall's cleanup (see openCleanup below),
  //   2. with ChatGPT's own sidebar menu or "Delete all chats" (page-hook.js
  //      reports the request as it happens),
  //   3. anywhere else (another device, the mobile app): caught when you open
  //      the chat (404) and by a quiet sync with your chat list.

  /** Forget chats that no longer exist in ChatGPT. */
  function forgetChats(ids, why) {
    const known = ids.filter((id) => state.index.conversations.has(id) || state.index.promptsFor(id, { includeTitles: true }).length);
    for (const id of ids) state.index.removeConversation(id);
    state.removed.push(...ids);
    listCache.data = null;
    state.dirty = true;
    flush(); // save now: a deleted chat must never come back
    if (known.length) log.info('forgot deleted chats', { count: known.length, why });
  }

  function onPageDelete(e) {
    if (retired || superseded()) return;
    let d;
    try {
      d = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (d.all) {
      log.info('all chats were deleted in ChatGPT; clearing Recall’s memory of them');
      listCache.data = null;
      store.clearIndex().then((fresh) => (state.index = fresh)).catch(() => {});
    } else if (d.id) {
      forgetChats([d.id], 'deleted in ChatGPT');
    }
  }
  document.addEventListener('recall:deleted', onPageDelete);
  cleanups.push(() => document.removeEventListener('recall:deleted', onPageDelete));

  /**
   * Compare what Recall knows with your chat list. When the list came back
   * complete, any known chat missing from it was deleted or archived; each is
   * double-checked (a 404 means deleted) so archived chats are kept.
   */
  async function syncDeletedChats(list, limit) {
    if (!list || list.length >= limit) return; // partial list: can't tell
    const present = new Set(list.map((c) => c.id));
    const known = new Set([...state.index.conversations.keys(), ...state.index.byConversation.keys()]);
    const missing = [...known].filter((id) => !present.has(id)).slice(0, 30);
    if (!missing.length) return;
    const gone = [];
    await chatgptApi.mapPool(missing, 3, async (id) => {
      try {
        await api.getConversation(id);
      } catch (err) {
        if (err.status === 404) gone.push(id);
      }
    });
    if (gone.length) forgetChats(gone, 'missing from your chat list');
  }

  // ---------------------------------------------------------------- cleanup
  /** The chat list is reused for 2 minutes (nudge -> cleanup panel -> reopen). */
  const listCache = { at: 0, limit: 0, data: null };
  async function listConversationsCached({ limit, fresh = false }) {
    if (!fresh && listCache.data && listCache.limit >= limit && Date.now() - listCache.at < 120000) {
      return listCache.data.slice(0, limit);
    }
    const data = await api.listConversations({ limit });
    Object.assign(listCache, { at: Date.now(), limit, data });
    syncDeletedChats(data, limit).catch((err) => log.debug('deleted-chat sync skipped', { error: err.message }));
    return data;
  }

  async function loadCleanup() {
    const [protectedIds, settings] = [await store.getProtected(), state.settings];
    let conversations;
    let canDelete = true;
    let note = '';
    try {
      conversations = await listConversationsCached({ limit: 300 });
    } catch (err) {
      conversations = dom.sidebarConversations(routes.conversationId);
      canDelete = false;
      note = `Couldn’t reach your full chat list (${err.message}), so only chats visible in the sidebar are shown and deleting must be done by hand.`;
    }
    const enriched = conversations.map((c) => ({ ...c, prompts: state.index.promptsFor(c.id) }));
    const suggestions = cleanup.suggest(enriched, {
      staleDays: settings.staleDays,
      protectedIds,
      currentConversationId: routes.conversationId(location.href),
    });
    return { suggestions, canDelete, note };
  }

  function openCleanup() {
    if (!contextAlive()) return retire();
    overlay.showCleanup({
      load: loadCleanup,
      urlFor: (id) => routes.conversationUrl(id, location.origin),
      onKeep: (ids) => store.protect(ids),
      onDelete: async (ids, onProgress) => {
        const res = await api.deleteMany(ids, { onProgress });
        listCache.data = null; // the list changed
        for (const id of res.deleted) state.index.removeConversation(id);
        state.removed.push(...res.deleted);
        // Bookkeeping must never turn a successful delete into an error.
        try {
          await store.saveIndex(state.index, { removedConversations: state.removed.splice(0) });
          if (res.deleted.length) await store.bumpStat('deleted', res.deleted.length);
        } catch (err) {
          log.warn('could not save after delete', { error: err.message });
        }
        log.info('deleted chats', { deleted: res.deleted.length, failed: res.failed.length });
        return res;
      },
      onUndo: async (ids) => {
        const back = await api.restoreMany(ids);
        listCache.data = null;
        // Let restored chats be learned again, and learn them now.
        for (const id of back.restored) state.index.restoreConversation(id);
        state.removed = state.removed.filter((id) => !back.restored.includes(id));
        api.getConversations(back.restored, {
          onResult: (full) => {
            for (const p of full.prompts || []) state.index.add({ conversationId: full.id, prompt: p, createdAt: 0, title: full.title, source: 'imported' });
          },
        })
          .then(() => store.saveIndex(state.index, { restoredConversations: back.restored }))
          .catch((err) => log.warn('could not re-learn restored chats', { error: err.message }));
        try {
          if (back.restored.length) await store.bumpStat('deleted', -back.restored.length);
        } catch {
          /* stats are cosmetic */
        }
        log.info('restored chats', { restored: back.restored.length, failed: back.failed.length });
        return back;
      },
      onFinished: (res) => {
        // ChatGPT's sidebar doesn't know about API deletions until it reloads.
        const here = routes.conversationId(location.href);
        if (here && res.deleted.includes(here)) location.assign(location.origin + '/');
        else location.reload();
      },
    });
  }

  async function firstRunAndNudges() {
    if (retired || !contextAlive() || !state.settings || !state.settings.enabled) return;
    const meta = await store.getMeta();
    const now = Date.now();

    if (!meta.importOffered) {
      await store.setMeta({ importOffered: true, lastNudgeAt: now });
      overlay.toast(
        t('welcome', 'Recall can learn from your existing chats so it spots questions you’ve already asked. It takes a few seconds, runs in the background, and everything stays on this device.'),
        [
          { label: t('notNow', 'Not now') },
          { label: t('welcomeYes', 'Learn from my chats'), primary: true, onClick: () => importHistory() },
        ],
        { testid: 'recall-welcome' }
      );
      return;
    }

    // A quiet check for chats deleted elsewhere, at most every 6 hours.
    if (now - (meta.lastSyncAt || 0) > 6 * 3600 * 1000) {
      await store.setMeta({ lastSyncAt: now });
      listConversationsCached({ limit: 300, fresh: true }).catch((err) => log.debug('chat list sync skipped', { error: err.message }));
    }

    const s = state.settings;
    if (!s.cleanupNudge || meta.nudgeNever) return;
    if (now - (meta.lastNudgeAt || 0) < s.nudgeIntervalDays * cleanup.DAY) return;
    await store.setMeta({ lastNudgeAt: now });
    try {
      const { suggestions } = await loadCleanup();
      if (suggestions.length < s.nudgeMinSuggestions) return;
      overlay.toast(
        t('nudge', 'You have {0} chats that look stale (untitled, duplicates or untouched for months). Clear them out in a few clicks?', suggestions.length),
        [
          { label: t('dontAskAgain', 'Don’t ask again'), onClick: () => store.setMeta({ nudgeNever: true }) },
          { label: t('later', 'Later') },
          { label: t('review', 'Review'), primary: true, onClick: openCleanup },
        ],
        { testid: 'recall-nudge' }
      );
    } catch (err) {
      log.debug('nudge skipped', { error: err.message });
    }
  }

  // ------------------------------------------------------- popup & sync
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (retired || superseded() || !msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'recall:cleanup') {
      openCleanup();
      reply({ ok: true });
    } else if (msg.type === 'recall:import') {
      importHistory().then(reply);
      return true; // async reply
    } else if (msg.type === 'recall:status') {
      reply({ ok: true, ...state.index.stats() });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (retired) return;
    const k = storeMod.KEYS;
    if (changes[k.settings]) {
      state.settings = globalThis.Recall.settings.sanitize(changes[k.settings].newValue);
      globalThis.Recall.log.configure(state.settings);
      overlay.setLauncher(state.settings.enabled && state.settings.showLauncher, openCleanup);
    }
    if (changes[k.index] && changes[k.index].newValue) state.index.merge(changes[k.index].newValue);
    if (changes[k.snoozes]) state.snoozes = changes[k.snoozes].newValue || {};
    if (changes[k.meta]) state.pausedUntil = (changes[k.meta].newValue || {}).pausedUntil || 0;
  });

  init();
})();
