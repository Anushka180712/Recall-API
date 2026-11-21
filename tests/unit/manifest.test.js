/*
 * Guards against the mistakes that only show up once the extension is loaded:
 * a library missing from the content-script list, a translation key used in
 * code but missing from _locales, or a broken Firefox manifest.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { firefoxManifest } = require('../../scripts/package.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const en = JSON.parse(read('_locales/en/messages.json'));

test('every file the manifest points to exists', () => {
  const files = [
    ...manifest.content_scripts.flatMap((c) => c.js),
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page.split('?')[0],
    ...Object.values(manifest.icons),
  ];
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('content scripts load every library before the code that needs it', () => {
  const js = manifest.content_scripts[0].js;
  assert.equal(js[0], 'src/lib/umd.js');
  for (const file of js.filter((f) => f.startsWith('src/lib/') && f !== 'src/lib/umd.js')) {
    const deps = (read(file).match(/RecallDefine\('\w+', \[([^\]]*)\]/) || [])[1] || '';
    for (const dep of deps.match(/\w+/g) || []) {
      assert.ok(js.indexOf(`src/lib/${dep}.js`) < js.indexOf(file), `${dep} must load before ${file}`);
    }
  }
  for (const lib of ['i18n', 'log']) assert.ok(js.includes(`src/lib/${lib}.js`), lib);
  assert.equal(js[js.length - 1], 'src/content/content.js');
});

test('every __MSG_ key and every t("key") used in code exists in English', () => {
  for (const [, key] of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) assert.ok(en[key], key);
  const sources = ['src/content/content.js', 'src/content/overlay.js', 'src/popup/popup.js'].map(read).join('\n');
  for (const [, key] of sources.matchAll(/\bt\('(\w+)'\s*[,)]/g)) assert.ok(en[key], `missing translation key: ${key}`);
  for (const [, key] of read('src/popup/popup.html').matchAll(/data-i18n(?:-placeholder|-title)?="(\w+)"/g)) assert.ok(en[key], key);
});

test('the Firefox manifest uses background scripts and has an add-on id', () => {
  const ff = firefoxManifest(manifest);
  assert.equal(ff.background.service_worker, undefined);
  assert.equal(ff.background.scripts[ff.background.scripts.length - 1], manifest.background.service_worker);
  assert.match(ff.browser_specific_settings.gecko.id, /@/);
  for (const f of ff.background.scripts) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});
