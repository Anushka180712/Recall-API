/*
 * Background service worker. Deliberately tiny: Recall does its work in the
 * page (content script) and the popup. This only seeds default settings on
 * install so the popup and the page start from the same values.
 */
importScripts('../lib/umd.js', '../lib/text.js', '../lib/similarity.js', '../lib/historyIndex.js', '../lib/settings.js', '../lib/store.js');

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const store = globalThis.Recall.store.createStore();
  if (reason === 'install') await store.saveSettings({});
});
