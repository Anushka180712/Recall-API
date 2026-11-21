const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { t, fill } = require('../../src/lib/i18n.js');

const LOCALES = path.join(__dirname, '..', '..', '_locales');

test('falls back to the English text when no translation is available', () => {
  assert.equal(t('anything', 'Ask anyway'), 'Ask anyway');
  assert.equal(t('n', 'Delete {0} chats', [3]), 'Delete 3 chats');
});

test('fill leaves unknown placeholders alone', () => {
  assert.equal(fill('{0} of {1}', [1]), '1 of {1}');
});

test('every locale has every key of the English file, with the same placeholders', () => {
  const en = JSON.parse(fs.readFileSync(path.join(LOCALES, 'en', 'messages.json'), 'utf8'));
  const holes = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');
  for (const lang of fs.readdirSync(LOCALES)) {
    const msgs = JSON.parse(fs.readFileSync(path.join(LOCALES, lang, 'messages.json'), 'utf8'));
    for (const key of Object.keys(en)) {
      assert.ok(msgs[key] && msgs[key].message, `${lang} is missing "${key}"`);
      assert.equal(holes(msgs[key].message), holes(en[key].message), `${lang}/${key} placeholders`);
    }
  }
});

test('the extension name and description fit the Chrome Web Store limits in every language', () => {
  for (const lang of fs.readdirSync(LOCALES)) {
    const msgs = JSON.parse(fs.readFileSync(path.join(LOCALES, lang, 'messages.json'), 'utf8'));
    assert.ok(msgs.extName.message.length <= 75, `${lang} name too long`);
    assert.ok(msgs.extDescription.message.length <= 132, `${lang} description too long`);
  }
});
