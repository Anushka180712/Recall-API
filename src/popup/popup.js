/* Popup: stats, settings, a live "would Recall step in?" tester and quick actions. */
(async function () {
  'use strict';

  const { settings: settingsMod, store: storeMod, policy } = globalThis.Recall;
  const store = storeMod.createStore();
  const $ = (sel) => document.querySelector(sel);

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
    const when = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : new Date(d.at).toLocaleString();
    el.textContent = d.reason === 'match'
      ? `“${d.prompt}” (${when}): Recall offered an earlier chat.`
      : `“${d.prompt}” (${when}): sent normally. ${d.explanation}`;
    el.className = d.reason === 'match' ? 'result yes' : 'result no';
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
        b.textContent = p.label;
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
      out.textContent = 'See exactly why Recall would or wouldn’t interrupt.';
      out.className = 'result no';
      return;
    }
    const d = policy.evaluate(prompt, {}, index, settings);
    if (d.intercept) {
      const m = d.matches[0];
      out.textContent = `Yes: ${Math.round(m.score * 100)}% match with “${m.title || m.prompt}”.`;
      out.className = 'result yes';
    } else {
      out.textContent = `No: ${d.explanation}`;
      out.className = 'result no';
    }
  }
  $('#test-input').addEventListener('input', runTester);

  // ------------------------------------------------------------ actions
  async function chatgptTab() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(active.url || '')) return active;
    return null;
  }

  async function sendToTab(type, busyText) {
    const status = $('#action-status');
    const tab = await chatgptTab();
    if (!tab) {
      status.textContent = 'Opening ChatGPT… run this again from there.';
      await chrome.tabs.create({ url: 'https://chatgpt.com/' });
      return;
    }
    status.textContent = busyText;
    try {
      await chrome.tabs.sendMessage(tab.id, { type });
      window.close();
    } catch {
      status.textContent = 'Reload the ChatGPT tab once so Recall can connect, then try again.';
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
      e.target.textContent = 'Click again to confirm';
      setTimeout(() => {
        clearArmed = false;
        e.target.textContent = 'Forget everything';
      }, 4000);
      return;
    }
    index = await store.clearIndex();
    e.target.textContent = 'Forgotten';
    renderStats();
    runTester();
  });

  renderSettings();
  renderStats();
  renderLastCheck();
  runTester();
})();
