const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, precheck, REASONS, HUMAN } = require('../../src/lib/policy.js');
const { HistoryIndex } = require('../../src/lib/historyIndex.js');
const { DEFAULTS } = require('../../src/lib/settings.js');

function makeIndex() {
  const idx = new HistoryIndex();
  const day = 86400000;
  idx.add({ conversationId: 'c-linked-list', title: 'Reverse linked list', prompt: 'How do I reverse a linked list in Python?', createdAt: Date.now() - 30 * day });
  idx.add({ conversationId: 'c-tcp', title: 'TCP vs UDP', prompt: 'Explain the difference between TCP and UDP', createdAt: Date.now() - 10 * day });
  idx.add({ conversationId: 'c-cookies', title: 'Cookie recipe', prompt: 'recipe for chocolate chip cookies', createdAt: Date.now() - 3 * day });
  idx.add({ conversationId: 'c-poem', title: 'Ocean poem', prompt: 'write a poem about the ocean at night', createdAt: Date.now() - 5 * day });
  idx.add({ conversationId: 'c-iphone', title: 'iPhone price', prompt: 'what is the price of the iphone 15 pro', createdAt: Date.now() - 200 * day });
  return idx;
}

const S = { ...DEFAULTS };
const idx = makeIndex();
const run = (prompt, ctx = {}, settings = S) => evaluate(prompt, ctx, idx, settings);

// ---------------------------------------------------------------- SHOULD redirect
test('REDIRECTS: same question re-phrased, asked from a new chat', () => {
  const d = run('reverse a linked list in python');
  assert.equal(d.reason, REASONS.MATCH);
  assert.equal(d.intercept, true);
  assert.equal(d.matches[0].conversationId, 'c-linked-list');
  assert.equal(d.matches[0].title, 'Reverse linked list');
});

test('REDIRECTS: same question asked from a *different* existing chat', () => {
  const d = run('what is the difference between udp and tcp?', { conversationId: 'c-cookies' });
  assert.equal(d.reason, REASONS.MATCH);
  assert.equal(d.matches[0].conversationId, 'c-tcp');
});

test('REDIRECTS: word order and small typos do not matter', () => {
  assert.equal(run('chocolate chip cookie recipe').reason, REASONS.MATCH);
  assert.equal(run('recipe for chocolate chip cookeis').reason, REASONS.MATCH);
});

// ------------------------------------------------------------ should NOT redirect
const NOT = [
  // Explicit request for something new: the user's word is final.
  ['generate a new poem about the ocean at night', REASONS.WANTS_NEW_ANSWER],
  ['write another poem about the ocean at night', REASONS.WANTS_NEW_ANSWER],
  ['give me a different recipe for chocolate chip cookies', REASONS.WANTS_NEW_ANSWER],
  ['explain the difference between TCP and UDP again', REASONS.WANTS_NEW_ANSWER],
  ['answer again: how do I reverse a linked list in python', REASONS.WANTS_NEW_ANSWER],
  ['fresh take on reversing a linked list in python', REASONS.WANTS_NEW_ANSWER],
  ['regenerate the cookie recipe', REASONS.WANTS_NEW_ANSWER],
  ['reverse a linked list in python, from scratch', REASONS.WANTS_NEW_ANSWER],
  ["don't redirect me, how do I reverse a linked list in python", REASONS.WANTS_NEW_ANSWER],
  ['new answer please: tcp vs udp differences', REASONS.WANTS_NEW_ANSWER],
  ['ask anyway reverse linked list python', REASONS.WANTS_NEW_ANSWER],
  // Small talk and chat commands.
  ['hi', REASONS.GENERIC],
  ['Hello there!', REASONS.GENERIC],
  ['thanks so much', REASONS.GENERIC],
  ['continue', REASONS.GENERIC],
  ['explain it again', REASONS.WANTS_NEW_ANSWER],
  ['tl;dr', REASONS.GENERIC],
  // Too short / too little meaning.
  ['python?', REASONS.TOO_SHORT],
  ['what is this thing', REASONS.TOO_SHORT],
  // Time-sensitive: an old answer would be stale.
  ['what is the latest price of the iphone 15 pro', REASONS.NEEDS_FRESH_INFO],
  ['what is the price of the iphone 15 pro today', REASONS.NEEDS_FRESH_INFO],
  ['current difference between TCP and UDP adoption', REASONS.NEEDS_FRESH_INFO],
  ['best laptops to buy in 2026', REASONS.NEEDS_FRESH_INFO],
  // Follow-ups that only make sense in the open conversation.
  ['what about reversing it in java instead', REASONS.CONTEXTUAL_FOLLOWUP],
  ['make it shorter and more formal', REASONS.CONTEXTUAL_FOLLOWUP],
  ['rewrite the code you gave using recursion', REASONS.CONTEXTUAL_FOLLOWUP],
  // Unique pasted input.
  ['reverse a linked list in python\n```\nclass Node: pass\n```', REASONS.PASTED_CONTENT],
  // Nothing similar.
  ['how do I file my taxes as a freelancer in germany', REASONS.NO_MATCH],
  ['recipe for banana bread with walnuts', REASONS.NO_MATCH],
];

for (const [prompt, reason] of NOT) {
  test(`does NOT redirect (${reason}): ${JSON.stringify(prompt)}`, () => {
    const d = run(prompt);
    assert.equal(d.reason, reason);
    assert.equal(d.intercept, false);
    assert.deepEqual(d.matches, []);
  });
}

test('does NOT redirect when the only match is the chat you are already in', () => {
  const d = run('reverse a linked list in python', { conversationId: 'c-linked-list' });
  assert.equal(d.reason, REASONS.SAME_CONVERSATION);
});

test('does NOT redirect right after "Ask anyway" (bypass)', () => {
  assert.equal(run('reverse a linked list in python', { bypass: true }).reason, REASONS.USER_OVERRIDE);
});

test('does NOT redirect in temporary chats', () => {
  assert.equal(run('reverse a linked list in python', { temporaryChat: true }).reason, REASONS.TEMPORARY_CHAT);
});

test('does NOT redirect when a file or image is attached', () => {
  assert.equal(run('reverse a linked list in python', { hasAttachments: true }).reason, REASONS.HAS_ATTACHMENTS);
});

test('does NOT redirect when switched off', () => {
  assert.equal(run('reverse a linked list in python', {}, { ...S, enabled: false }).reason, REASONS.DISABLED);
});

test('does NOT redirect to a chat the user marked "Not the same"', () => {
  const d = run('reverse a linked list in python', { isSnoozed: (_n, id) => id === 'c-linked-list' });
  assert.equal(d.reason, REASONS.SNOOZED);
});

test('a snoozed chat is skipped but other matches are still offered', () => {
  const i2 = makeIndex();
  i2.add({ conversationId: 'c-ll-2', title: 'Linked lists again', prompt: 'how to reverse a linked list in python', createdAt: Date.now() });
  const d = evaluate('reverse a linked list in python', { isSnoozed: (_n, id) => id === 'c-ll-2' }, i2, S);
  assert.equal(d.reason, REASONS.MATCH);
  assert.deepEqual(d.matches.map((m) => m.conversationId), ['c-linked-list']);
});

test('freshness guard can be turned off', () => {
  const d = run('what is the latest price of the iphone 15 pro', {}, { ...S, freshnessGuard: false });
  assert.equal(d.reason, REASONS.MATCH);
});

test('a stricter threshold turns a loose match into no-match', () => {
  assert.equal(run('explain javascript closures plus tcp').reason, REASONS.NO_MATCH);
  assert.equal(run('reverse linked list python', {}, { ...S, threshold: 0.98 }).reason, REASONS.NO_MATCH);
});

test('"wants new answer" beats every other rule, even an exact duplicate', () => {
  assert.equal(run('recipe for chocolate chip cookies, give me a new one').reason, REASONS.WANTS_NEW_ANSWER);
});

test('never suggests more than maxSuggestions chats', () => {
  const i3 = new HistoryIndex();
  for (let n = 0; n < 6; n++) i3.add({ conversationId: `c${n}`, prompt: 'how do I reverse a linked list in python' });
  const d = evaluate('reverse a linked list in python', {}, i3, { ...S, maxSuggestions: 2 });
  assert.equal(d.matches.length, 2);
});

test('works with an empty index', () => {
  assert.equal(evaluate('how do I reverse a linked list in python', {}, new HistoryIndex(), S).reason, REASONS.NO_MATCH);
});

test('every reason has a human explanation', () => {
  for (const r of Object.values(REASONS)) assert.ok(HUMAN[r], r);
});

test('precheck returns null for a normal standalone question', () => {
  assert.equal(precheck('How do I reverse a linked list in Python?', {}, S), null);
});
