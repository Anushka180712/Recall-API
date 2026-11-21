/*
 * Background service worker. Deliberately tiny: Recall does its work in the
 * page (content script) and the popup. It only:
 *   - seeds default settings on first install, and
 *   - after an install or update, injects the fresh content scripts into
 *     ChatGPT tabs that are already open, so Recall keeps working without the
 *     user having to reload those tabs (the old copy steps aside by itself).
 */
importScripts('../lib/umd.js', '../lib/text.js', '../lib/similarity.js', '../lib/historyIndex.js', '../lib/settings.js', '../lib/store.js');

async function injectIntoOpenTabs() {
  const [script] = chrome.runtime.getManifest().content_scripts || [];
  if (!script || !chrome.scripting) return;
  const tabs = await chrome.tabs.query({ url: script.matches });
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: script.js })
        .catch(() => {}) // discarded or restricted tabs: the page will load Recall on its next reload
    )
  );
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await globalThis.Recall.store.createStore().saveSettings({});
  if (reason === 'install' || reason === 'update') await injectIntoOpenTabs();
});
