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
  const DEBUG = false;
  const log = (...a) => DEBUG && console.debug('[Recall]', ...a);

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
      overlay.toast(
        'Recall was updated or restarted. Reload this page to switch it back on. ChatGPT works normally in the meantime.',
        [{ label: 'Later' }, { label: 'Reload page', primary: true, onClick: () => location.reload() }],
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
  };

  // ------------------------------------------------------------------ boot
  async function init() {
    try {
      const [settings, index, snoozes] = await Promise.all([store.getSettings(), store.loadIndex(), store.getSnoozes()]);
      state.settings = settings;
      state.index = index;
      state.snoozes = snoozes;
    } catch (err) {
      console.warn('[Recall] could not load saved data, starting fresh', err);
      state.settings = globalThis.Recall.settings.sanitize({});
    }
    overlay.mount();
    overlay.setLauncher(state.settings.enabled && state.settings.showLauncher, openCleanup);
    observeConversation();
    const timer = setInterval(() => (contextAlive() ? checkUrl() : retire()), 400);
    cleanups.push(() => clearInterval(timer));
    setTimeout(firstRunAndNudges, 1500);
    jumpToTarget(); // arrived here via "Take me there" (full page load)
    log('ready', state.index.stats());
  }

  // ------------------------------------------------------- send interception
  function currentContext() {
    const s = state.snoozes;
    return {
      conversationId: routes.conversationId(location.href),
      temporaryChat: routes.isTemporaryChat(location.href),
      hasAttachments: dom.hasAttachments(),
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
    log('decision', decision.reason, decision.matches);
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

  let jumpTimer = 0;
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
    jumpTimer = setInterval(() => {
      const els = [...document.querySelectorAll(dom.SELECTORS.userMessage.join(','))];
      if (!els.length && Date.now() - started < 12000) return; // chat still loading
      clearInterval(jumpTimer);
      sessionStorage.removeItem(JUMP_KEY);
      highlightSidebar(target.id);
      if (!els.length || target.title) return;
      const el = bestMessage(els, target.prompt);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flash(el, 'recall-jump-target');
    }, 250);
  }

  /** The rendered user message that best matches the remembered prompt. */
  function bestMessage(els, prompt) {
    const { normalize } = globalThis.Recall.text;
    const want = normalize(prompt);
    let best = els[0];
    let bestScore = -1;
    for (const el of els) {
      const got = normalize(el.innerText || el.textContent || '');
      const score = got === want || got.startsWith(want) ? 2 : globalThis.Recall.similarity.score(got.slice(0, 400), want);
      if (score > bestScore) [best, bestScore] = [el, score];
    }
    return best;
  }

  function highlightSidebar(id) {
    const link = document.querySelector(`nav a[href$="/c/${CSS.escape(id)}"], aside a[href$="/c/${CSS.escape(id)}"]`);
    if (!link) return;
    link.scrollIntoView({ block: 'nearest' });
    flash(link, 'recall-jump-link');
  }

  /** Briefly outline an element of the page (inline styles, restored afterwards). */
  function flash(el, marker) {
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
    }, 2800);
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
      console.warn('[Recall] could not save index', err);
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
    const ui = overlay.progress('Reading your chat list…', { testid: 'recall-import' });
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
              return log('skip', full.id, full.error);
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
              ui.update(`Learning from your chats… ${done} of ${total} (you can keep chatting)`, 0.05 + 0.95 * (done / total));
            }
            if (done % 25 === 0) scheduleSave();
          },
        });
      }
      await store.saveIndex(state.index);
      await store.setMeta({ lastImportAt: Date.now() });
      const s = state.index.stats();
      const skipped = failed ? ` ${failed} chat${failed === 1 ? '' : 's'} couldn’t be read; open them once and Recall will learn them.` : '';
      ui.done(`Done. Recall now knows ${s.prompts} prompts from ${s.conversations} chats (${added} new).${skipped}`, failed ? 10000 : 6000);
      return { added, ...s };
    } catch (err) {
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
          log('could not save after delete', err.message);
        }
        return res;
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
        'Recall can learn from your existing chats so it spots questions you’ve already asked. It takes a few seconds, runs in the background, and everything stays on this device.',
        [
          { label: 'Not now' },
          { label: 'Learn from my chats', primary: true, onClick: () => importHistory() },
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
        `You have ${suggestions.length} chats that look stale (untitled, duplicates or untouched for months). Clear them out in a few clicks?`,
        [
          { label: 'Don’t ask again', onClick: () => store.setMeta({ nudgeNever: true }) },
          { label: 'Later' },
          { label: 'Review', primary: true, onClick: openCleanup },
        ],
        { testid: 'recall-nudge' }
      );
    } catch (err) {
      log('nudge skipped', err.message);
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
      overlay.setLauncher(state.settings.enabled && state.settings.showLauncher, openCleanup);
    }
    if (changes[k.index] && changes[k.index].newValue) state.index.merge(changes[k.index].newValue);
    if (changes[k.snoozes]) state.snoozes = changes[k.snoozes].newValue || {};
  });

  init();
})();
