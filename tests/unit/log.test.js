const test = require('node:test');
const assert = require('node:assert/strict');
const log = require('../../src/lib/log.js');

function capture() {
  const lines = [];
  const sink = {};
  for (const level of ['debug', 'info', 'warn', 'error', 'log']) sink[level] = (...a) => lines.push([level, ...a]);
  log.setSink(sink);
  return lines;
}

test('only warnings and errors are printed by default', () => {
  const lines = capture();
  log.configure({ debug: false });
  const l = log.create('test');
  l.debug('d');
  l.info('i');
  l.warn('w', { n: 1 });
  l.error('e');
  assert.deepEqual(lines.map((x) => x[0]), ['warn', 'error']);
  assert.deepEqual(lines[0], ['warn', '[Recall:test]', 'w', { n: 1 }]);
});

test('debug setting prints everything', () => {
  const lines = capture();
  log.configure({ debug: true });
  log.create('test').debug('d');
  assert.equal(lines.length, 1);
  log.configure({});
});

test('prompt text is redacted unless debugging', () => {
  log.configure({ debug: false });
  assert.equal(log.text('my secret question'), '<prompt: 18 chars>');
  log.configure({ debug: true });
  assert.equal(log.text('my secret question'), 'my secret question');
  log.configure({});
});

test('recent() keeps a bounded history even for hidden levels', () => {
  capture();
  log.configure({});
  const l = log.create('ring');
  for (let i = 0; i < 250; i++) l.debug('x' + i);
  const r = log.recent();
  assert.equal(r.length, 200);
  assert.equal(r[r.length - 1].msg, 'x249');
  assert.equal(r[r.length - 1].scope, 'ring');
});
