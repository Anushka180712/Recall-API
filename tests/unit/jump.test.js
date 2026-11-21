const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve, locate, closeness } = require('../../src/lib/jump.js');

const chat = [
  { id: 'm1', text: 'how often should I water basil' },
  { id: 'm2', text: 'python: flip the order of nodes in a singly linked list' },
  { id: 'm3', text: 'and in Java?' },
  { id: 'm4', text: 'How do I reverse a linked list in Python?' },
];

test('exact text wins, even if it differs in case and punctuation', () => {
  assert.equal(closeness('How do I reverse a linked list in Python?', 'how do i reverse a linked list in python'), 2);
  assert.equal(locate(chat, { prompt: 'how do i reverse a linked list in python', query: 'x' }).index, 3);
});

test('ChatGPT’s own message id beats text matching', () => {
  const r = locate(chat, { prompt: 'How do I reverse a linked list in Python?', messageId: 'm2' });
  assert.deepEqual(r, { index: 1, score: 2, via: 'message-id' });
});

test('a match found through the chat TITLE still lands on the best message for what you typed', () => {
  const r = locate(chat.slice(0, 3), { prompt: 'Reverse Linked List Python', fromTitle: true, query: 'reverse a linked list in python' });
  assert.equal(r.index, 1);
});

test('a re-phrased match lands on the similar message, not only exact copies', () => {
  const r = locate(chat, { prompt: 'reversing a linked list in python, how?', query: 'reverse linked list python' });
  assert.equal(r.index, 3);
  assert.equal(r.via, 'similar');
});

test('long messages shown truncated still match by their start', () => {
  const long = 'Please review this long essay about climate policy and suggest improvements to structure and tone '.repeat(5);
  assert.equal(locate([{ id: 'a', text: long.slice(0, 120) }], { prompt: long }).index, 0);
});

test('nothing plausible: null instead of a wrong guess', () => {
  assert.equal(locate([{ id: 'a', text: 'what soil for tomatoes' }], { prompt: 'reverse a linked list in python' }), null);
  assert.equal(resolve([], { prompt: 'x' }), null);
});
