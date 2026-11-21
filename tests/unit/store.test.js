const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, memoryArea, KEYS } = require('../../src/lib/store.js');
const { HistoryIndex } = require('../../src/lib/historyIndex.js');

const fresh = () => {
  const local = memoryArea();
  const sync = memoryArea();
  return { local, sync, store: createStore({ local, sync }) };
};

test('settings default, save and sanitise', async () => {
  const { store, sync } = fresh();
  assert.equal((await store.getSettings()).enabled, true);
  await store.saveSettings({ enabled: false, threshold: 99 });
  const s = await store.getSettings();
  assert.equal(s.enabled, false);
  assert.equal(s.threshold, 0.98);
  assert.ok(sync.dump()[KEYS.settings], 'settings live in sync storage');
});

test('index is saved locally and merged across tabs', async () => {
  const { store, local } = fresh();
  const tabA = await store.loadIndex();
  const tabB = await store.loadIndex();
  tabA.add({ conversationId: 'a', prompt: 'question from tab A about rust' });
  await store.saveIndex(tabA);
  tabB.add({ conversationId: 'b', prompt: 'question from tab B about go' });
  await store.saveIndex(tabB);
  const loaded = await store.loadIndex();
  assert.deepEqual(loaded.stats(), { prompts: 2, conversations: 2 });
  assert.ok(local.dump()[KEYS.index]);
});

test('saveIndex applies deletions after merging', async () => {
  const { store } = fresh();
  const idx = await store.loadIndex();
  idx.add({ conversationId: 'gone', prompt: 'this chat will be deleted soon' });
  await store.saveIndex(idx);
  const other = await store.loadIndex();
  await store.saveIndex(other, { removedConversations: ['gone'] });
  assert.equal((await store.loadIndex()).size, 0);
});

test('clearIndex wipes data in every tab on next merge', async () => {
  const { store } = fresh();
  const idx = await store.loadIndex();
  idx.add({ conversationId: 'a', prompt: 'something to forget later' });
  await store.saveIndex(idx);
  await store.clearIndex(Date.now() + 10);
  await store.saveIndex(idx); // stale tab saves afterwards
  assert.equal((await store.loadIndex()).size, 0);
  assert.equal(idx.size, 0);
});

test('snoozes expire', async () => {
  const { store } = fresh();
  const t0 = 1_000_000;
  await store.snooze('Reverse a linked list', 'c1', 1, t0);
  const key = store.snoozeKey('reverse a linked list', 'c1');
  assert.ok((await store.getSnoozes(t0 + 1000))[key]);
  assert.equal((await store.getSnoozes(t0 + 2 * 86400000))[key], undefined);
});

test('stats, meta and protected chats', async () => {
  const { store } = fresh();
  await store.bumpStat('redirects');
  await store.bumpStat('deleted', 4);
  const stats = await store.getStats();
  assert.equal(stats.redirects, 1);
  assert.equal(stats.deleted, 4);
  assert.equal(stats.checks, 0);
  await store.setMeta({ nudgeNever: true });
  assert.equal((await store.getMeta()).nudgeNever, true);
  await store.protect(['x', 'y']);
  assert.deepEqual([...(await store.getProtected())].sort(), ['x', 'y']);
});

test('exportAll includes everything Recall stores', async () => {
  const { store } = fresh();
  await store.saveSettings({ staleDays: 30 });
  await store.saveIndex(new HistoryIndex());
  const out = await store.exportAll();
  assert.ok(out.exportedAt);
  assert.ok(out[KEYS.settings]);
  assert.ok(out[KEYS.index]);
});

test('createStore without chrome.storage fails loudly', () => {
  assert.throws(() => createStore(), /chrome.storage is not available/);
});

test('pause for a while, then resume', async () => {
  const { store } = fresh();
  assert.equal(await store.getPausedUntil(), 0);
  const until = await store.pause(3600000, 1000);
  assert.equal(until, 3601000);
  assert.equal(await store.getPausedUntil(2000), 3601000);
  assert.equal(await store.getPausedUntil(3601001), 0, 'a pause ends by itself');
  await store.resume();
  assert.equal(await store.getPausedUntil(2000), 0);
});

test('health is recorded with a timestamp', async () => {
  const { store } = fresh();
  await store.setHealth({ composer: false });
  const { health } = await store.getMeta();
  assert.equal(health.composer, false);
  assert.ok(health.at > 0);
});
