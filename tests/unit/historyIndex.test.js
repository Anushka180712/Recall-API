const test = require('node:test');
const assert = require('node:assert/strict');
const { HistoryIndex, MAX_PROMPT_CHARS, MAX_PER_CONVERSATION } = require('../../src/lib/historyIndex.js');

test('add stores prompts and de-duplicates within a conversation', () => {
  const idx = new HistoryIndex();
  assert.equal(idx.add({ conversationId: 'a', prompt: 'How do I bake bread?' }), true);
  assert.equal(idx.add({ conversationId: 'a', prompt: 'how do i bake bread' }), false);
  assert.equal(idx.add({ conversationId: 'b', prompt: 'How do I bake bread?' }), true);
  assert.deepEqual(idx.stats(), { prompts: 2, conversations: 2 });
});

test('add rejects empty or meaningless input', () => {
  const idx = new HistoryIndex();
  assert.equal(idx.add({ conversationId: 'a', prompt: '' }), false);
  assert.equal(idx.add({ conversationId: 'a', prompt: 'the and of' }), false);
  assert.equal(idx.add({ conversationId: '', prompt: 'real question here' }), false);
  assert.equal(idx.size, 0);
});

test('long prompts are truncated for storage', () => {
  const idx = new HistoryIndex();
  idx.add({ conversationId: 'a', prompt: 'word '.repeat(500) + 'end' });
  assert.ok([...idx.entries.values()][0].prompt.length <= MAX_PROMPT_CHARS);
});

test('search returns one best hit per conversation, ranked', () => {
  const idx = new HistoryIndex();
  idx.add({ conversationId: 'a', prompt: 'how to reverse a linked list in python', title: 'A' });
  idx.add({ conversationId: 'a', prompt: 'and what about a doubly linked list' });
  idx.add({ conversationId: 'b', prompt: 'reverse a linked list in python recursively', title: 'B' });
  idx.add({ conversationId: 'c', prompt: 'best pizza dough recipe' });
  const hits = idx.search('reverse linked list python', { topK: 5, minScore: 0.3 });
  assert.deepEqual(hits.map((h) => h.conversationId), ['a', 'b']);
  assert.equal(hits[0].title, 'A');
  assert.ok(hits[0].score >= hits[1].score);
});

test('search can exclude a conversation and respects minScore', () => {
  const idx = new HistoryIndex();
  idx.add({ conversationId: 'a', prompt: 'how to reverse a linked list in python' });
  assert.equal(idx.search('reverse linked list python', { excludeConversationId: 'a' }).length, 0);
  assert.equal(idx.search('reverse linked list python', { minScore: 0.999 }).length, 0);
});

test('IDF: words you use everywhere count less than rare ones', () => {
  const idx = new HistoryIndex();
  for (let i = 0; i < 20; i++) idx.add({ conversationId: `p${i}`, prompt: `python question number ${i} about lists` });
  idx.add({ conversationId: 'k', prompt: 'kubernetes ingress setup' });
  assert.ok(idx.idf('kubernet') > idx.idf('python'));
});

test('removeConversation forgets it and blocks re-adding via merge', () => {
  const idx = new HistoryIndex();
  idx.add({ conversationId: 'a', prompt: 'how to reverse a linked list in python' });
  const snapshot = idx.toJSON();
  assert.equal(idx.removeConversation('a'), 1);
  assert.equal(idx.size, 0);
  idx.merge(snapshot); // e.g. another tab still had it in memory
  assert.equal(idx.size, 0);
  assert.equal(idx.add({ conversationId: 'a', prompt: 'something else entirely now' }), false);
});

test('df bookkeeping stays consistent after removals', () => {
  const idx = new HistoryIndex();
  idx.add({ conversationId: 'a', prompt: 'alpha beta gamma' });
  idx.add({ conversationId: 'b', prompt: 'alpha delta' });
  idx.removeConversation('a');
  assert.equal(idx.docFreq('alpha'), 1);
  assert.equal(idx.postings.has('gamma'), false);
});

test('global cap evicts the oldest prompts', () => {
  const idx = new HistoryIndex({ maxEntries: 3 });
  for (let i = 0; i < 5; i++) idx.add({ conversationId: `c${i}`, prompt: `unique topic number ${i}`, createdAt: 1000 + i });
  assert.equal(idx.size, 3);
  assert.deepEqual([...idx.entries.values()].map((e) => e.conversationId).sort(), ['c2', 'c3', 'c4']);
});

test('per-conversation cap keeps the newest prompts', () => {
  const idx = new HistoryIndex();
  for (let i = 0; i < MAX_PER_CONVERSATION + 5; i++) idx.add({ conversationId: 'x', prompt: `message variant ${i} text`, createdAt: i + 1 });
  assert.equal(idx.size, MAX_PER_CONVERSATION);
  assert.ok(!idx.promptsFor('x').includes('message variant 0 text'));
});

test('unknown time (0) is replaced by a real time when learned later', () => {
  const idx = new HistoryIndex();
  idx.add({ conversationId: 'a', prompt: 'how to reverse a linked list', createdAt: 0 });
  idx.add({ conversationId: 'a', prompt: 'how to reverse a linked list', createdAt: 5000 });
  assert.equal([...idx.entries.values()][0].createdAt, 5000);
});

test('toJSON/fromJSON round-trips and merge unions two tabs', () => {
  const a = new HistoryIndex();
  a.add({ conversationId: 'x', prompt: 'first tab question about rust', title: 'Rust', createdAt: 1 });
  const b = HistoryIndex.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
  b.add({ conversationId: 'y', prompt: 'second tab question about go', createdAt: 2 });
  a.merge(b.toJSON());
  assert.deepEqual(a.stats(), { prompts: 2, conversations: 2 });
  assert.equal(a.conversations.get('x').title, 'Rust');
});

test('merge honours a newer "clear" from another tab', () => {
  const a = new HistoryIndex();
  a.add({ conversationId: 'x', prompt: 'some question about rust' });
  const wiped = new HistoryIndex();
  wiped.clear(Date.now() + 1000);
  a.merge(wiped.toJSON());
  assert.equal(a.size, 0);
});

test('fromJSON ignores unknown schema versions', () => {
  assert.equal(HistoryIndex.fromJSON({ v: 999, e: [['a', 'hello world there', 1, 'sent']] }).size, 0);
  assert.equal(HistoryIndex.fromJSON(null).size, 0);
});

test('chat titles are searchable but not counted as prompts', () => {
  const idx = new HistoryIndex();
  idx.add({ conversationId: 'a', prompt: 'Docker volumes vs bind mounts', source: 'title' });
  assert.deepEqual(idx.promptsFor('a'), []);
  assert.deepEqual(idx.promptsFor('a', { includeTitles: true }), ['Docker volumes vs bind mounts']);
  assert.equal(idx.search('docker volumes vs bind mounts', { minScore: 0.7 })[0].source, 'title');
});

test('long prompts keep their identity through save/load (no duplicates, exact match still works)', () => {
  const long = 'explain in depth '.repeat(60) + 'the end';
  const a = new HistoryIndex();
  a.add({ conversationId: 'x', prompt: long });
  const b = HistoryIndex.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
  b.merge(a.toJSON());
  assert.equal(b.size, 1);
  const [hit] = b.search(long, { minScore: 0.9 });
  assert.equal(hit.exact, true);
});
