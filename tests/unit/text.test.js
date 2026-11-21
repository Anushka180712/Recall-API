const test = require('node:test');
const assert = require('node:assert/strict');
const text = require('../../src/lib/text.js');

test('normalize lower-cases, strips accents, punctuation and URLs', () => {
  assert.equal(text.normalize('  Café — RÉSUMÉ tips!!  '), 'cafe resume tips');
  assert.equal(text.normalize('see https://example.com/x?y=1 now'), 'see url now');
  assert.equal(text.normalize("what's C++ vs C#?"), 'whats c++ vs c#');
  assert.equal(text.normalize(null), '');
});

test('tokenize drops filler words and stems', () => {
  assert.deepEqual(text.tokenize('Can you please explain how closures work in JavaScript?'), ['closure', 'work', 'javascript']);
  assert.deepEqual(text.tokenize('sorting sorted sorts'), ['sort', 'sort', 'sort']);
  assert.deepEqual(text.tokenize('libraries'), ['library']);
});

test('tokenize maps common synonyms and abbreviations to one form', () => {
  assert.deepEqual(text.tokenize('summarize'), text.tokenize('summary'));
  assert.deepEqual(text.tokenize('JS'), ['javascript']);
  assert.deepEqual(text.tokenize('difference'), text.tokenize('compare'));
});

test('tokenize keeps numbers and short technical tokens', () => {
  assert.deepEqual(text.tokenize('the 1984 novel'), ['1984', 'novel']);
});

test('charTrigrams pads with spaces', () => {
  const g = text.charTrigrams('ab');
  assert.deepEqual([...g].sort(), [' ab', 'ab '].sort());
  assert.equal(text.charTrigrams('').size, 0);
});

test('hash is stable and 8 hex chars', () => {
  assert.equal(text.hash('hello'), text.hash('hello'));
  assert.notEqual(text.hash('hello'), text.hash('hellp'));
  assert.match(text.hash('x'), /^[0-9a-f]{8}$/);
});

test('truncate adds an ellipsis only when needed', () => {
  assert.equal(text.truncate('short', 10), 'short');
  assert.equal(text.truncate('a very long sentence', 8), 'a very…');
});
