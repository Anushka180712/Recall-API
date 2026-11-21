/*
 * Background service worker. Deliberately tiny: Recall does its work in the
 * page (content script) and the popup. It only:
 *   - seeds default settings on first install, and
 *   - after an install or update, injects the fresh content scripts into
 *     ChatGPT tabs that are already open, so Recall keeps working without the
 *     user having to reload those tabs (the old copy steps aside by itself),
 *   - handles the keyboard shortcut (Alt+Shift+R by default) that turns Recall
 *     on or off, and shows "OFF" on the toolbar icon while it is off.
 *
 * In Firefox this file runs as a background script with the libraries listed
 * before it in the manifest, so importScripts is only used when it exists.
 */
if (typeof importScripts === 'function') {
  importScripts('../lib/umd.js', '../lib/text.js', '../lib/similarity.js', '../lib/historyIndex.js', '../lib/settings.js', '../lib/store.js');
}

const store = globalThis.Recall.store.createStore();

async function updateBadge() {
  const { enabled } = await store.getSettings();
  await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
}

async function injectIntoOpenTabs() {
  const scripts = chrome.runtime.getManifest().content_scripts || [];
  if (!scripts.length || !chrome.scripting) return;
  const tabs = await chrome.tabs.query({ url: scripts[0].matches });
  await Promise.all(
    tabs.flatMap((tab) =>
      // The page-world network hook first, then Recall itself.
      [...scripts].reverse().map((script) =>
        chrome.scripting
          .executeScript({ target: { tabId: tab.id }, files: script.js, world: script.world === 'MAIN' ? 'MAIN' : 'ISOLATED' })
          .catch(() => {}) // discarded or restricted tabs: the page will load Recall on its next reload
      )
    )
  );
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await store.saveSettings({});
  if (reason === 'update') {
    // 1.1: the dialog lists up to 4 earlier chats (was 3) unless you changed it.
    const s = await store.getSettings();
    if (s.maxSuggestions === 3) await store.saveSettings({ maxSuggestions: 4 });
  }
  if (reason === 'install' || reason === 'update') await injectIntoOpenTabs();
  await updateBadge();
});

chrome.runtime.onStartup.addListener(updateBadge);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recall') return;
  const { enabled } = await store.getSettings();
  await store.saveSettings({ enabled: !enabled });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes[store.KEYS.settings]) updateBadge().catch(() => {});
});
