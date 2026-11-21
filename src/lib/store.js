/*
 * Persistence on top of chrome.storage.
 *
 *   chrome.storage.sync  -> settings only (small, follows your Chrome profile)
 *   chrome.storage.local -> the prompt index, snoozes, stats (never leaves the device)
 *
 * The storage areas are injectable so the module is unit-testable in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./settings.js'), require('./historyIndex.js'), require('./text.js'));
  } else {
    root.RecallDefine('store', ['settings', 'historyIndex', 'text'], factory);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (settingsMod, indexMod, text) {
  'use strict';

  const KEYS = Object.freeze({
    settings: 'recall.settings',
    index: 'recall.index',
    snoozes: 'recall.snoozes',
    stats: 'recall.stats',
    meta: 'recall.meta',
    protected: 'recall.protected',
    last: 'recall.lastDecision',
  });

  const EMPTY_STATS = Object.freeze({ checks: 0, suggestions: 0, redirects: 0, overrides: 0, deleted: 0 });
  const DAY = 24 * 60 * 60 * 1000;

  function createStore({ sync, local } = {}) {
    const chromeStorage = globalThis.chrome && globalThis.chrome.storage;
    sync = sync || (chromeStorage && (chromeStorage.sync || chromeStorage.local));
    local = local || (chromeStorage && chromeStorage.local);
    if (!sync || !local) throw new Error('chrome.storage is not available');

    async function getOne(area, key, fallback) {
      const res = await area.get(key);
      return res && res[key] !== undefined ? res[key] : fallback;
    }

    return {
      KEYS,

      async getSettings() {
        return settingsMod.sanitize(await getOne(sync, KEYS.settings, {}));
      },
      async saveSettings(patch) {
        const next = settingsMod.sanitize({ ...(await this.getSettings()), ...patch });
        await sync.set({ [KEYS.settings]: next });
        return next;
      },

      async loadIndex() {
        return indexMod.HistoryIndex.fromJSON(await getOne(local, KEYS.index, null));
      },
      /**
       * Merge-then-write so two open ChatGPT tabs never clobber each other's
       * newly learned prompts. Deletions are applied after the merge.
       */
      async saveIndex(index, { removedConversations = [] } = {}) {
        const stored = await getOne(local, KEYS.index, null);
        if (stored) index.merge(stored);
        for (const id of removedConversations) index.removeConversation(id);
        await local.set({ [KEYS.index]: index.toJSON() });
        return index;
      },
      async clearIndex(now = Date.now()) {
        const empty = new indexMod.HistoryIndex();
        empty.clear(now);
        await local.set({ [KEYS.index]: empty.toJSON() });
        return empty;
      },

      snoozeKey(prompt, conversationId) {
        return `${text.hash(text.normalize(prompt))}:${conversationId}`;
      },
      async getSnoozes(now = Date.now()) {
        const all = await getOne(local, KEYS.snoozes, {});
        const live = {};
        for (const [k, exp] of Object.entries(all)) if (exp > now) live[k] = exp;
        return live;
      },
      async snooze(prompt, conversationId, days, now = Date.now()) {
        const all = await this.getSnoozes(now);
        all[this.snoozeKey(prompt, conversationId)] = now + days * DAY;
        await local.set({ [KEYS.snoozes]: all });
        return all;
      },

      async getStats() {
        return { ...EMPTY_STATS, ...(await getOne(local, KEYS.stats, {})) };
      },
      async bumpStat(name, by = 1) {
        const stats = await this.getStats();
        stats[name] = (stats[name] || 0) + by;
        await local.set({ [KEYS.stats]: stats });
        return stats;
      },

      async getMeta() {
        return { lastNudgeAt: 0, nudgeNever: false, lastImportAt: 0, ...(await getOne(local, KEYS.meta, {})) };
      },
      async setMeta(patch) {
        const next = { ...(await this.getMeta()), ...patch };
        await local.set({ [KEYS.meta]: next });
        return next;
      },

      async getProtected() {
        return new Set(await getOne(local, KEYS.protected, []));
      },
      async protect(ids) {
        const set = await this.getProtected();
        for (const id of ids) set.add(id);
        await local.set({ [KEYS.protected]: [...set] });
        return set;
      },

      async setLastDecision(d) {
        await local.set({ [KEYS.last]: d });
      },
      async getLastDecision() {
        return getOne(local, KEYS.last, null);
      },

      /** Everything Recall stores, for the "Export my data" button. */
      async exportAll() {
        const [l, s] = await Promise.all([local.get(null), sync.get(KEYS.settings)]);
        const out = { exportedAt: new Date().toISOString(), ...s };
        for (const k of Object.values(KEYS)) if (l[k] !== undefined) out[k] = l[k];
        return out;
      },
    };
  }

  /** In-memory chrome.storage area, used by tests and as a safe fallback. */
  function memoryArea(initial = {}) {
    let data = JSON.parse(JSON.stringify(initial));
    return {
      async get(keys) {
        if (keys == null) return JSON.parse(JSON.stringify(data));
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
        return out;
      },
      async set(obj) {
        data = { ...data, ...JSON.parse(JSON.stringify(obj)) };
      },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
      },
      dump: () => data,
    };
  }

  return { createStore, memoryArea, KEYS, EMPTY_STATS };
});
