const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, PRESETS, sanitize, presetFor } = require('../../src/lib/settings.js');

test('sanitize fills defaults', () => {
  assert.deepEqual(sanitize(undefined), { ...DEFAULTS });
  assert.deepEqual(sanitize('junk'), { ...DEFAULTS });
});

test('sanitize keeps valid values, clamps numbers, drops junk', () => {
  const s = sanitize({ enabled: false, threshold: 5, staleDays: '30', evil: '<script>', freshnessGuard: 'yes' });
  assert.equal(s.enabled, false);
  assert.equal(s.threshold, 0.98);
  assert.equal(s.staleDays, 30);
  assert.equal(s.freshnessGuard, true);
  assert.equal('evil' in s, false);
});

test('presets are ordered and presetFor picks the nearest', () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ['loose', 'balanced', 'strict']);
  assert.equal(presetFor(DEFAULTS.threshold).id, 'balanced');
  assert.equal(presetFor(0.55).id, 'loose');
  assert.equal(presetFor(0.9).id, 'strict');
});
