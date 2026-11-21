const test = require('node:test');
const assert = require('node:assert/strict');
const { suggest, DAY } = require('../../src/lib/cleanup.js');

const NOW = Date.UTC(2026, 10, 21);
const ago = (d) => NOW - d * DAY;
const ids = (list) => list.map((s) => s.id);

test('flags untitled chats and pre-selects them', () => {
  const [s] = suggest([{ id: 'u', title: 'New chat', updatedAt: ago(1) }], { now: NOW });
  assert.equal(s.id, 'u');
  assert.ok(s.reasons.some((r) => r.id === 'untitled'));
  assert.equal(s.preselected, true);
});

test('flags chats that were only small talk', () => {
  const out = suggest([{ id: 'g', title: 'Greeting', updatedAt: ago(1), prompts: ['hi', 'thanks'] }], { now: NOW });
  assert.deepEqual(ids(out), ['g']);
  assert.ok(out[0].reasons.some((r) => r.id === 'greeting-only'));
});

test('flags inactive chats with the age in the reason', () => {
  const [s] = suggest([{ id: 'old', title: 'Trip ideas for Lisbon', updatedAt: ago(90) }], { now: NOW, staleDays: 60 });
  const r = s.reasons.find((x) => x.id === 'inactive');
  assert.equal(r.detail, '90 days ago');
  assert.equal(s.preselected, false); // stale alone is a suggestion, not a pre-tick
});

test('very old one-shot chats score higher than merely inactive ones', () => {
  const out = suggest(
    [
      { id: 'a', title: 'Old question one', updatedAt: ago(70), prompts: ['how do vaccines work', 'and boosters'] },
      { id: 'b', title: 'Ancient question', updatedAt: ago(400), prompts: ['how does a jet engine work'] },
    ],
    { now: NOW, staleDays: 60 }
  );
  assert.deepEqual(ids(out), ['b', 'a']);
});

test('flags the older of two duplicate chats only', () => {
  const out = suggest(
    [
      { id: 'old', title: 'Linked list reversal', updatedAt: ago(20), prompts: ['how do I reverse a linked list in python'] },
      { id: 'new', title: 'Reverse a linked list', updatedAt: ago(2), prompts: ['how to reverse a linked list in python?'] },
    ],
    { now: NOW }
  );
  assert.deepEqual(ids(out), ['old']);
  assert.match(out[0].reasons.find((r) => r.id === 'duplicate').detail, /Reverse a linked list/);
});

test('leaves healthy, recent, titled chats alone', () => {
  const out = suggest(
    [
      { id: 'ok1', title: 'Thesis outline', updatedAt: ago(3), prompts: ['help me outline my thesis on solar panels', 'add a methods section'] },
      { id: 'ok2', title: 'Budget spreadsheet', updatedAt: ago(10) },
    ],
    { now: NOW }
  );
  assert.deepEqual(out, []);
});

test('never suggests protected chats or the chat that is open', () => {
  const convs = [
    { id: 'p', title: 'New chat', updatedAt: ago(1) },
    { id: 'open', title: 'New chat', updatedAt: ago(1) },
    { id: 'x', title: 'New chat', updatedAt: ago(1) },
  ];
  assert.deepEqual(ids(suggest(convs, { now: NOW, protectedIds: ['p'], currentConversationId: 'open' })), ['x']);
});

test('handles empty and malformed input', () => {
  assert.deepEqual(suggest([], { now: NOW }), []);
  assert.deepEqual(suggest(null, { now: NOW }), []);
  assert.deepEqual(suggest([null, { title: 'no id' }], { now: NOW }), []);
});

test('a greeting *title* counts as small talk when prompts are unknown', () => {
  const out = suggest([{ id: 'h', title: 'Hello', updatedAt: ago(1) }], { now: NOW });
  assert.deepEqual(ids(out), ['h']);
});

test('recognises ChatGPT-style greeting titles', () => {
  const out = suggest(
    [
      { id: 'g1', title: 'Friendly Greeting', updatedAt: ago(1) },
      { id: 'g2', title: 'Casual greeting exchange', updatedAt: ago(1) },
      { id: 'n', title: 'Hello World in Rust', updatedAt: ago(1) },
    ],
    { now: NOW }
  );
  assert.deepEqual(ids(out).sort(), ['g1', 'g2']);
});
