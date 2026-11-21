/*
 * Builds dist/recall-<version>.zip containing only what the browser needs
 * (manifest, src, icons), ready for "Load unpacked" or the Chrome Web Store.
 *
 * Usage: npm run package
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const dist = path.join(ROOT, 'dist');
const out = path.join(dist, `recall-${version}.zip`);

fs.mkdirSync(dist, { recursive: true });
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', '-q', out, 'manifest.json', 'src', 'icons', '-x', 'icons/icon512.png'], { cwd: ROOT, stdio: 'inherit' });
console.log(`Packaged ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
