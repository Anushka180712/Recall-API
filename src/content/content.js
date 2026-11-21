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
  if (globalThis.__recallLoaded) return;
  globalThis.__recallLoaded = true;

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
  const cleanups = [];
  let retired = false;

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
      if (!contextAlive()) return retire();
      fn(e);
    };
    window.addEventListener(type, wrapped, capture);
    cleanups.push(() => window.removeEventListener(type, wrapped, capture));
  }

  function retire() {
    if (retired) return;
    retired = true;
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    overlay.closeModal();
    overlay.setLauncher(false);
    // Give a freshly injected copy a moment to take over before asking for a reload.
    setTimeout(() => {
      if (document.documentElement.dataset.recallInstance !== INSTANCE) {
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

  const store = storeMod.createStore();
  const api = chatgptApi.createClient({ origin: location.origin });
  const overlay = new globalThis.RecallOverlay();

  const state = {
    settings: null,
    index: new historyIndex.HistoryIndex(),
    snoozes: {},
    bypassUntil: 0, // set by "Ask anyway": the next send goes straight through
    lastHandled: { text: '', at: 0 },
    pending: null, // prompt sent from the "new chat" page, waiting for its conversation id
    href: location.href,
    saveTimer: 0,
    removed: [],
    importing: false,
    dirty: false,
    pausedUntil: 0, // "Pause for 1 hour": no checks until this time
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
    globalThis.Recall.log.configure(state.settings);
    overlay.mount();
    overlay.setLauncher(state.settings.enabled && state.settings.showLauncher, openCleanup);
    observeConversation();
    const timer = setInterval(() => (contextAlive() ? checkUrl() : retire()), 400);
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
      visiblePrompts: routes.conversationId(location.href) ? dom.visibleUserPrompts() : [],
      isSnoozed: (norm, convId) => (s[`${globalThis.Recall.text.hash(norm)}:${convId}`] || 0) > Date.now(),
    };
  }

  /**
   * Shared entry point for every way of sending. Must stay synchronous: once
   * we return, ChatGPT's own handler runs and the message is gone.
   */
  function handleSend(event) {
    if (!state.settings || overlay.isOpen) return;
    const prompt = dom.composerText().trim();
    if (!prompt) return;

    const now = Date.now();
    // One physical send can surface as keydown + click + submit; handle it once.
    if (state.lastHandled.text === prompt && now - state.lastHandled.at < 1500) return;

    if (state.bypassUntil > now) {
      state.bypassUntil = 0;
      remember(prompt);
      return;
    }

    const decision = policy.evaluate(prompt, currentContext(), state.index, state.settings);
    log.debug('decision', {
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

    if (!decision.intercept) {
      remember(prompt);
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
        openAndJump(m);
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

  function resend({ bypass = true } = {}) {
    state.lastHandled = { text: '', at: 0 };
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
    if (prompt) state.lastHandled = { text: prompt, at: Date.now() };
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

  function checkUrl() {
    if (location.href === state.href) return;
    state.href = location.href;
    const id = routes.conversationId(location.href);
    if (state.pending && id && Date.now() - state.pending.at < 60000 && !routes.isTemporaryChat(location.href)) {
      addPrompt(id, state.pending.prompt, state.pending.at, 'sent');
      state.pending = null;
    }
    scheduleScrape();
    jumpToTarget();
  }

  // ------------------------------------------------- "Take me there" jump
  const JUMP_KEY = 'recall.jump';

  /**
   * Open the earlier chat and remember which message to scroll to. The target
   * lives in sessionStorage so it survives a full page load as well as
   * ChatGPT's in-app navigation.
   */
  function openAndJump(m) {
    if (m.sameChat) {
      // Already here: clear the repeated draft and scroll up to the earlier answer.
      clearComposer();
      try {
        sessionStorage.setItem(JUMP_KEY, JSON.stringify({ id: m.conversationId, prompt: m.prompt, at: Date.now() }));
      } catch {
        /* ignore */
      }
      jumpToTarget();
      return;
    }
    try {
      sessionStorage.setItem(JUMP_KEY, JSON.stringify({ id: m.conversationId, prompt: m.prompt, title: m.source === 'title', at: Date.now() }));
    } catch {
      /* storage blocked: we still open the chat */
    }
    const link = document.querySelector(`nav a[href$="/c/${CSS.escape(m.conversationId)}"], aside a[href$="/c/${CSS.escape(m.conversationId)}"]`);
    if (link) link.click(); // in-app navigation: no full reload, much faster
    else location.assign(routes.conversationUrl(m.conversationId, location.origin));
    // If the click didn't navigate (e.g. the sidebar link is inert), fall back.
    setTimeout(() => {
      if (routes.conversationId(location.href) !== m.conversationId) location.assign(routes.conversationUrl(m.conversationId, location.origin));
    }, 1500);
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
   * ChatGPT renders a chat in several passes and then scrolls itself to the
   * newest message, which would undo a naive scroll. So we:
   *   1. wait until the list of messages stops changing,
   *   2. find the best match (exact text first), scrolling the chat to the top
   *      to make older turns render if it isn't there yet,
   *   3. scroll to it and keep it in view for a few seconds, unless you start
   *      scrolling yourself.
   */
  function jumpToTarget() {
    let target;
    try {
      target = JSON.parse(sessionStorage.getItem(JUMP_KEY) || 'null');
    } catch {
      return;
    }
    if (!target || Date.now() - target.at > 30000) return;
    if (routes.conversationId(location.href) !== target.id) return;
    clearInterval(jumpTimer);

    const started = Date.now();
    let lastCount = -1;
    let stableSince = Date.now();
    let loadAttempts = 0;
    let noGrowth = 0;
    let countAtLastLoad = 0;
    jumpTimer = setInterval(() => {
      const els = userMessageEls();
      const timedOut = Date.now() - started > 15000;
      if (els.length !== lastCount) {
        lastCount = els.length;
        stableSince = Date.now();
        if (!timedOut) return;
      }
      if (!timedOut && (!els.length || Date.now() - stableSince < 700)) return; // still rendering

      const match = els.length && !target.title ? bestMessage(els, target.prompt) : null;
      if (match && match.score < 0.6 && !timedOut && loadAttempts < 12 && noGrowth < 2) {
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
        return;
      }
      clearInterval(jumpTimer);
      try {
        sessionStorage.removeItem(JUMP_KEY);
      } catch {
        /* ignore */
      }
      highlightSidebar(target.id);
      if (match) reveal(match.el);
    }, 200);
  }

  function userMessageEls() {
    return [...document.querySelectorAll(dom.SELECTORS.userMessage.join(','))];
  }

  /** The rendered user message that best matches a prompt: {el, score}. */
  function bestMessage(els, prompt) {
    const { normalize } = globalThis.Recall.text;
    const want = normalize(prompt);
    let best = { el: els[0], score: -1 };
    for (const el of els) {
      const got = normalize(el.innerText || el.textContent || '');
      const score = got === want || (want.length > 20 && got.startsWith(want)) ? 2 : globalThis.Recall.similarity.score(got.slice(0, 400), want);
      // Prefer the earliest message on ties: that's where it was first answered.
      if (score > best.score) best = { el, score };
    }
    return best;
  }

  function scrollParent(el) {
    for (let n = el && el.parentElement; n; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement;
  }

  function inView(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight && r.top > -r.height / 2;
  }

  /** Scroll a message to the top of the view, highlight it, and hold it there briefly. */
  function reveal(el) {
    let userScrolled = false;
    const stop = () => (userScrolled = true);
    const opts = { passive: true, capture: true, once: true };
    for (const type of ['wheel', 'touchmove', 'mousedown']) window.addEventListener(type, stop, opts);
    const go = () => !userScrolled && el.isConnected && el.scrollIntoView({ block: 'start', behavior: 'auto' });
    go();
    flash(el, 'recall-jump-target', 4000);
    overlay.pin(el, t('jumpBadge', 'You asked this here'), 4000);
    // ChatGPT scrolls to the newest message after loading; put ours back.
    for (const ms of [250, 600, 1200, 2000, 3000]) setTimeout(() => !inView(el) && go(), ms);
    setTimeout(() => {
      for (const type of ['wheel', 'touchmove', 'mousedown']) window.removeEventListener(type, stop, opts);
    }, 3500);
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
    for (const p of dom.visibleUserPrompts()) {
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

  // ---------------------------------------------------------------- cleanup
  /** The chat list is reused for 2 minutes (nudge -> cleanup panel -> reopen). */
  const listCache = { at: 0, limit: 0, data: null };
  async function listConversationsCached({ limit, fresh = false }) {
    if (!fresh && listCache.data && listCache.limit >= limit && Date.now() - listCache.at < 120000) {
      return listCache.data.slice(0, limit);
    }
    const data = await api.listConversations({ limit });
    Object.assign(listCache, { at: Date.now(), limit, data });
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
        try {
          if (back.restored.length) await store.bumpStat('deleted', -back.restored.length);
        } catch {
          /* stats are cosmetic */
        }
        log.info('restored chats', { restored: back.restored.length, failed: back.failed.length });
        // Restored chats are re-learned the next time you open them or import.
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
    if (!msg || typeof msg.type !== 'string') return false;
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
