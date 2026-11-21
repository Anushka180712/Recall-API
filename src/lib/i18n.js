/*
 * Translations. UI text lives in _locales/<lang>/messages.json (Chrome's
 * standard i18n system) and follows the browser's language automatically.
 * `t(key, fallback, subs)` falls back to the English text passed in, so a
 * missing translation never shows a blank or a key name. Placeholders are
 * written {0}, {1}... and filled from `subs`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecallDefine('i18n', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function lookup(key) {
    try {
      const api = globalThis.chrome && globalThis.chrome.i18n;
      return (api && api.getMessage(key)) || '';
    } catch {
      return ''; // extension context gone, or not running in an extension
    }
  }

  function fill(str, subs) {
    if (subs == null) return str;
    const list = Array.isArray(subs) ? subs : [subs];
    return str.replace(/\{(\d+)\}/g, (m, i) => (list[i] != null ? String(list[i]) : m));
  }

  function t(key, fallback = key, subs) {
    return fill(lookup(key) || fallback, subs);
  }

  /** Translate static HTML: <el data-i18n="key">English</el>, data-i18n-placeholder for inputs. */
  function translatePage(doc = document) {
    for (const el of doc.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n, el.textContent);
    for (const el of doc.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder, el.placeholder);
    for (const el of doc.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle, el.title);
    const lang = lookup('@@ui_locale');
    if (lang) doc.documentElement.lang = lang.replace('_', '-');
  }

  return { t, fill, translatePage };
});
