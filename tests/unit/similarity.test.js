const test = require('node:test');
const assert = require('node:assert/strict');
const sim = require('../../src/lib/similarity.js');
const { DEFAULTS } = require('../../src/lib/settings.js');

const T = DEFAULTS.threshold;

// Re-phrasings of the same question: should clear the default threshold.
const SAME = [
  ['How do I reverse a linked list in Python?', 'reverse linked list python'],
  ['how to reverse a linked list in python', 'Can you show me how to reverse a linked-list using Python please'],
  ['Explain the difference between TCP and UDP', 'what is the difference between udp and tcp?'],
  ['Write a cover letter for a software engineer internship', 'write me a cover letter for software engineering internship'],
  ['What are the health benefits of green tea?', 'green tea health benefits'],
  ['how do closures work in javascript', 'explain javascript closures'],
  ['best way to center a div in css', 'how to center a div with CSS'],
  ['recipe for chocolate chip cookies', 'chocolate chip cookie recipe'],
  ['How to fix "permission denied (publickey)" git error', 'git permission denied publickey error fix'],
];

// Same template, different topic: must stay below the threshold.
const DIFFERENT = [
  ['How do I reverse a linked list in Python?', 'How do I reverse a string in JavaScript?'],
  ['Explain the difference between TCP and UDP', 'Explain the difference between HTTP and HTTPS'],
  ['Write a cover letter for a software engineer internship', 'Write a resignation letter to my manager'],
  ['What are the health benefits of green tea?', 'What are the side effects of coffee?'],
  ['how do closures work in javascript', 'how do decorators work in python'],
  ['recipe for chocolate chip cookies', 'recipe for banana bread'],
  ['best way to center a div in css', 'best way to learn css grid'],
  ['Summarize the plot of the book 1984 by George Orwell', 'Summarize the plot of Animal Farm by George Orwell'],
  ['python sort list of dicts by key', 'python sort list of tuples by second element'],
];

for (const [a, b] of SAME) {
  test(`matches re-phrasing: "${b}"`, () => {
    assert.ok(sim.score(a, b) >= T, `${sim.score(a, b)} < ${T}`);
  });
}

for (const [a, b] of DIFFERENT) {
  test(`does not match different topic: "${b}"`, () => {
    assert.ok(sim.score(a, b) < T, `${sim.score(a, b)} >= ${T}`);
  });
}

test('identical text (ignoring case/punctuation) scores exactly 1', () => {
  assert.equal(sim.score('What is Docker?', 'what is docker'), 1);
});

test('score is symmetric and bounded', () => {
  const a = 'deploy a node app to aws lambda';
  const b = 'how can I deploy node.js on lambda';
  assert.equal(sim.score(a, b), sim.score(b, a));
  for (const [x, y] of [...SAME, ...DIFFERENT]) {
    const s = sim.score(x, y);
    assert.ok(s >= 0 && s <= 1);
  }
});

test('empty input scores 0', () => {
  assert.equal(sim.score('', 'anything here'), 0);
});

test('tfidfCosine weights rare terms higher', () => {
  const idf = (t) => (t === 'kubernetes' ? 5 : 1);
  const rare = sim.tfidfCosine(['kubernetes', 'deploy'], ['kubernetes', 'pods'], idf);
  const common = sim.tfidfCosine(['kubernetes', 'deploy'], ['deploy', 'pods'], idf);
  assert.ok(rare > common);
});

test('jaccard basics', () => {
  assert.equal(sim.jaccard(new Set([1, 2]), new Set([2, 3])), 1 / 3);
  assert.equal(sim.jaccard(new Set(), new Set([1])), 0);
});
