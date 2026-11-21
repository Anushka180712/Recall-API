/*
 * Builds the store-ready zips in dist/, containing only what the browser needs
 * (manifest, _locales, src, icons):
 *
 *   dist/recall-<version>.zip          Chrome, Edge, Brave, Opera, Vivaldi
 *   dist/recall-<version>-firefox.zip  Firefox 115+ (experimental)
 *
 * Firefox does not run MV3 service workers, so its manifest lists the same
 * background files as plain scripts and adds the add-on id Firefox requires.
 *
 * Usage: npm run package
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const dist = path.join(ROOT, 'dist');
const FILES = ['manifest.json', '_locales', 'src', 'icons'];
const EXCLUDE = ['-x', 'icons/icon512.png'];

function zip(out, cwd) {
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-r', '-q', out, ...FILES, ...EXCLUDE], { cwd, stdio: 'inherit' });
  console.log(`Packaged ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
}

/** The Firefox flavour of the manifest. Exported for the unit tests. */
function firefoxManifest(m) {
  const ff = JSON.parse(JSON.stringify(m));
  const worker = ff.background.service_worker;
  ff.background = {
    scripts: ['src/lib/umd.js', 'src/lib/text.js', 'src/lib/similarity.js', 'src/lib/historyIndex.js', 'src/lib/settings.js', 'src/lib/store.js', worker],
  };
  ff.browser_specific_settings = { gecko: { id: 'recall@anushka180712.github.io', strict_min_version: '128.0' } };
  delete ff.minimum_chrome_version;
  return ff;
}

if (require.main === module) {
  fs.mkdirSync(dist, { recursive: true });
  zip(path.join(dist, `recall-${manifest.version}.zip`), ROOT);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-ff-'));
  for (const f of FILES.slice(1)) fs.cpSync(path.join(ROOT, f), path.join(tmp, f), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(firefoxManifest(manifest), null, 2));
  zip(path.join(dist, `recall-${manifest.version}-firefox.zip`), tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
}

module.exports = { firefoxManifest };
