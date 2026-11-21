/*
 * Popup (and, opened with ?options=1, the full settings page): stats, settings,
 * pause, a live "would Recall step in?" tester, the last decision, a health
 * warning, and quick actions that run in the open ChatGPT tab.
 */
(async function () {
  'use strict';

  const { settings: settingsMod, store: storeMod, policy, i18n } = globalThis.Recall;
  const { t } = i18n;
  const store = storeMod.createStore();
  const $ = (sel) => document.querySelector(sel);

  i18n.translatePage();
  const isPage = new URLSearchParams(location.search).has('options');
  if (isPage) {
    document.body.classList.add('page');
    $('#settings-box').open = true;
  }

  let settings = await store.getSettings();
  let index = await store.loadIndex();

  // -------------------------------------------------------------- stats
  async function renderStats() {
    const stats = await store.getStats();
    const s = index.stats();
    $('#stat-prompts').textContent = s.prompts.toLocaleString();
    $('#stat-conversations').textContent = s.conversations.toLocaleString();
    $('#stat-redirects').textContent = stats.redirects.toLocaleString();
    $('#stat-deleted').textContent = stats.deleted.toLocaleString();
  }

  async function renderLastCheck() {
    const d = await store.getLastDecision();
    if (!d) return;
    const el = $('#last-check');
    const mins = Math.round((Date.now() - d.at) / 60000);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    const when = mins < 60 ? rtf.format(-mins, 'minute') : new Date(d.at).toLocaleString();
    const offered = d.reason === 'match' || d.reason === 'repeat-in-this-chat';
    el.textContent = offered
      ? t('lastMatch', '“{0}” ({1}): Recall offered an earlier chat.', [d.prompt, when])
      : t('lastSent', '“{0}” ({1}): sent normally. {2}', [d.prompt, when, d.explanation]);
    el.className = offered ? 'result yes' : 'result no';
  }

  // ------------------------------------------------- pause & health
  async function renderPause() {
    const until = await store.getPausedUntil();
    $('#paused').hidden = !until;
    $('#pause').disabled = !!until;
    if (until) {
      const time = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      $('#paused-text').textContent = t('pausedUntil', 'Recall is paused until {0}.', time);
    }
  }
  $('#pause').addEventListener('click', async () => {
    await store.pause(60 * 60 * 1000);
    renderPause();
  });
  $('#resume').addEventListener('click', async () => {
    await store.resume();
    renderPause();
  });

  async function renderHealth() {
    const { health } = await store.getMeta();
    // Only warn about a recent check: an old failure may already be fixed.
    $('#health').hidden = !(health && health.composer === false && Date.now() - health.at < 24 * 3600 * 1000);
  }

  async function renderShortcut() {
    try {
      const cmds = await chrome.commands.getAll();
      const c = cmds.find((x) => x.name === 'toggle-recall');
      if (c && c.shortcut) $('#shortcut').textContent = `${t('shortcutDesc', 'Turn Recall on or off')}. ${t('shortcutHint', 'Shortcut: {0}', c.shortcut)}`;
    } catch {
      /* commands API unavailable (e.g. some browsers): nothing to show */
    }
  }

  // ----------------------------------------------------------- settings
  function renderSettings() {
    for (const el of document.querySelectorAll('[data-setting]')) {
      const key = el.dataset.setting;
      if (el.type === 'checkbox') el.checked = !!settings[key];
      else el.value = settings[key];
    }
    const active = settingsMod.presetFor(settings.threshold);
    const wrap = $('#presets');
    wrap.replaceChildren(
      ...settingsMod.PRESETS.map((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.role = 'radio';
        b.textContent = t('preset' + p.label, p.label);
        b.setAttribute('aria-checked', String(p.id === active.id));
        b.addEventListener('click', () => save({ threshold: p.threshold }));
        return b;
      })
    );
    $('#preset-hint').textContent = `${active.hint} (needs ${Math.round(active.threshold * 100)}% similarity)`;
  }

  async function save(patch) {
    settings = await store.saveSettings(patch);
    renderSettings();
    runTester();
  }

  for (const el of document.querySelectorAll('[data-setting]')) {
    el.addEventListener('change', () => {
      const key = el.dataset.setting;
      save({ [key]: el.type === 'checkbox' ? el.checked : Number(el.value) });
    });
  }

  // ------------------------------------------------------------- tester
  function runTester() {
    const prompt = $('#test-input').value;
    const out = $('#test-result');
    if (!prompt.trim()) {
      out.textContent = t('testerIdle', 'See exactly why Recall would or wouldn’t interrupt.');
      out.className = 'result no';
      return;
    }
    const d = policy.evaluate(prompt, {}, index, settings);
    if (d.intercept) {
      const m = d.matches[0];
      out.textContent = t('testerYes', 'Yes: {0}% match with “{1}”.', [Math.round(m.score * 100), m.title || m.prompt]);
      out.className = 'result yes';
    } else {
      out.textContent = t('testerNo', 'No: {0}', d.explanation);
      out.className = 'result no';
    }
  }
  $('#test-input').addEventListener('input', runTester);

  // ------------------------------------------------------------ actions
  async function chatgptTab() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(active.url || '')) return active;
    if (!isPage) return null;
    // On the full settings page, use any open ChatGPT tab and bring it forward.
    const [other] = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
    if (other) await chrome.tabs.update(other.id, { active: true });
    return other || null;
  }

  async function sendToTab(type, busyText) {
    const status = $('#action-status');
    const tab = await chatgptTab();
    if (!tab) {
      status.textContent = t('needChatgpt', 'Opening ChatGPT… run this again from there.');
      await chrome.tabs.create({ url: 'https://chatgpt.com/' });
      return;
    }
    status.textContent = busyText;
    try {
      await chrome.tabs.sendMessage(tab.id, { type });
      if (!isPage) window.close();
    } catch {
      status.textContent = t('needReload', 'Reload the ChatGPT tab once so Recall can connect, then try again.');
    }
  }

  $('#import').addEventListener('click', () => sendToTab('recall:import', 'Importing in your ChatGPT tab…'));
  $('#cleanup').addEventListener('click', () => sendToTab('recall:cleanup', 'Opening cleanup…'));

  $('#export').addEventListener('click', async () => {
    const data = await store.exportAll();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `recall-export-${Date.now()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  let clearArmed = false;
  $('#clear').addEventListener('click', async (e) => {
    if (!clearArmed) {
      clearArmed = true;
      e.target.textContent = t('confirmAgain', 'Click again to confirm');
      setTimeout(() => {
        clearArmed = false;
        e.target.textContent = t('btnForget', 'Forget everything');
      }, 4000);
      return;
    }
    index = await store.clearIndex();
    e.target.textContent = 'Forgotten';
    renderStats();
    runTester();
  });

  $('#open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  renderSettings();
  renderStats();
  renderLastCheck();
  renderPause();
  renderHealth();
  renderShortcut();
  runTester();
})();
