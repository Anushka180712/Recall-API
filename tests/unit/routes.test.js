const test = require('node:test');
const assert = require('node:assert/strict');
const routes = require('../../src/lib/routes.js');

test('conversationId parses every ChatGPT URL shape', () => {
  assert.equal(routes.conversationId('https://chatgpt.com/c/6740a1b2-0c3d-8000-9a1b-123456789abc'), '6740a1b2-0c3d-8000-9a1b-123456789abc');
  assert.equal(routes.conversationId('https://chatgpt.com/g/g-abc123-coder/c/abcdef12-3456'), 'abcdef12-3456');
  assert.equal(routes.conversationId('https://chat.openai.com/c/abcdef123?model=gpt'), 'abcdef123');
  assert.equal(routes.conversationId('/c/abcdef123'), 'abcdef123');
});

test('conversationId is null on non-conversation pages', () => {
  assert.equal(routes.conversationId('https://chatgpt.com/'), null);
  assert.equal(routes.conversationId('https://chatgpt.com/gpts'), null);
  assert.equal(routes.conversationId('https://chatgpt.com/c/'), null);
  assert.equal(routes.conversationId('http://[bad'), null);
});

test('temporary chat detection', () => {
  assert.equal(routes.isTemporaryChat('https://chatgpt.com/?temporary-chat=true'), true);
  assert.equal(routes.isTemporaryChat('https://chatgpt.com/'), false);
});

test('conversationUrl encodes the id', () => {
  assert.equal(routes.conversationUrl('a b'), 'https://chatgpt.com/c/a%20b');
  assert.equal(routes.conversationUrl('x', 'https://chat.openai.com'), 'https://chat.openai.com/c/x');
});
