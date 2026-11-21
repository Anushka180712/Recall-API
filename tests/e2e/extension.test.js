/*
 * Real-browser tests: Chromium + the unpacked extension + a mock chat app.
 * Run with `npm run test:e2e`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, typePrompt, recall, waitForRecall, ORIGIN } = require('./harness.js');

const settle = (page, ms = 2000) => page.waitForTimeout(ms); // URL poll (400 ms) + debounced save (800 ms)

async function freshChat(page) {
  await page.goto(`${ORIGIN}/`);
  await waitForRecall(page);
}

/** Send one prompt from a new chat and wait until it is stored. */
async function askInNewChat(env, text) {
  await freshChat(env.page);
  await typePrompt(env.page, text);
  await env.page.keyboard.press('Enter');
  await env.page.waitForURL(/\/c\//);
  await settle(env.page);
}

test('redirect flow: learns a sent prompt, then redirects a re-phrased repeat', async (t) => {
  const env = await launch();
  t.after(env.close);
  const { page, server } = env;

  await askInNewChat(env, 'How do I reverse a linked list in Python?');
  assert.equal(server.sends.length, 1);
  const firstUrl = page.url();

  await freshChat(page);
  await typePrompt(page, 'reverse a linked list in python');
  await page.keyboard.press('Enter');

  await recall(page, 'recall-dialog').waitFor();
  assert.equal(server.sends.length, 1, 'the repeat was NOT sent');
  assert.match(await recall(page, 'recall-match').first().innerText(), /reverse a linked list in Python/i);

  await recall(page, 'recall-open-top').click();
  await page.waitForURL(firstUrl);
  assert.equal(server.sends.length, 1);
});

test('"Ask anyway" sends the prompt; Esc keeps editing without sending', async (t) => {
  const env = await launch();
  t.after(env.close);
  const { page, server } = env;
  await askInNewChat(env, 'Explain the difference between TCP and UDP');

  await freshChat(page);
  await typePrompt(page, 'what is the difference between udp and tcp');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();

  await page.keyboard.press('Escape');
  await recall(page, 'recall-dialog').waitFor({ state: 'detached' });
  assert.equal(server.sends.length, 1);
  assert.match(await page.locator('#prompt-textarea').innerText(), /udp and tcp/);

  // Clicking the send button goes through the same check.
  await page.locator('[data-testid="send-button"]').click();
  await recall(page, 'recall-dialog').waitFor();
  await recall(page, 'recall-ask-anyway').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-message-author-role="assistant"]').length === 1);
  assert.equal(server.sends.length, 2);
  assert.equal(server.sends[1].text, 'what is the difference between udp and tcp');
});

test('does not interrupt: explicit "new answer", small talk, fresh info, follow-ups in the same chat', async (t) => {
  const env = await launch();
  t.after(env.close);
  const { page, server } = env;
  await askInNewChat(env, 'write a poem about the ocean at night');

  const cases = [
    'generate a new poem about the ocean at night',
    'hi',
    'what is the latest news about the ocean at night',
  ];
  for (const text of cases) {
    await freshChat(page);
    const before = server.sends.length;
    await typePrompt(page, text);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/c\//);
    assert.equal(server.sends.length, before + 1, `"${text}" should be sent straight away`);
    assert.equal(await recall(page, 'recall-dialog').count(), 0);
  }

  // Asking the same thing again *inside* the original chat is a follow-up, not a repeat.
  const original = server.sends[0].conversationId;
  await page.goto(`${ORIGIN}/c/${original}`);
  await waitForRecall(page);
  const before = server.sends.length;
  await typePrompt(page, 'write a poem about the ocean at night');
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('[data-message-author-role="user"]').length === n, 2);
  assert.equal(server.sends.length, before + 1);
});

test('"Not the same" sends the prompt and stops suggesting that chat for it', async (t) => {
  const env = await launch();
  t.after(env.close);
  const { page, server } = env;
  await askInNewChat(env, 'recipe for chocolate chip cookies');

  await freshChat(page);
  await typePrompt(page, 'chocolate chip cookie recipe');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-not-helpful').first().click();
  await page.waitForURL(/\/c\//);
  assert.equal(server.sends.length, 2);
  await settle(page);

  await freshChat(page);
  await typePrompt(page, 'chocolate chip cookie recipe');
  await page.keyboard.press('Enter');
  // The snoozed chat is never offered again for this question. The chat that
  // was just created (same wording) still is, because it's a different chat.
  await recall(page, 'recall-dialog').waitFor();
  const offered = await recall(page, 'recall-match').allInnerTexts();
  assert.equal(offered.length, 1);
  assert.match(offered[0], /You asked: “chocolate chip cookie recipe”/);
  assert.equal(server.sends.length, 2);
});

test('learns from existing history (import) and from chats you open', async (t) => {
  const env = await launch([
    { id: 'old-docker-chat', title: 'Docker volumes', prompts: ['How do Docker volumes work and when should I use bind mounts?'], updatedDaysAgo: 40 },
    { id: 'old-regex-chat', title: 'Email regex', prompts: ['Write a regex that validates email addresses'], updatedDaysAgo: 12 },
  ]);
  t.after(env.close);
  const { page, server } = env;

  // Passive: simply opening a chat teaches Recall its prompts.
  await page.goto(`${ORIGIN}/c/old-regex-chat`);
  await waitForRecall(page);
  await settle(page, 2600);

  // Import: the first-run toast offers to learn from all chats.
  await recall(page, 'recall-welcome').waitFor({ timeout: 8000 });
  await recall(page, 'recall-welcome').locator('button', { hasText: 'Learn from my chats' }).click();
  await recall(page, 'recall-import').filter({ hasText: 'Done' }).waitFor({ timeout: 15000 });

  for (const [text, target] of [
    ['docker volumes vs bind mounts, when to use which', 'Docker volumes'],
    ['regex to validate email addresses', 'Email regex'],
  ]) {
    await freshChat(page);
    await typePrompt(page, text);
    await page.keyboard.press('Enter');
    await recall(page, 'recall-dialog').waitFor();
    assert.match(await recall(page, 'recall-match').first().innerText(), new RegExp(target));
    await page.keyboard.press('Escape');
  }
  assert.equal(server.sends.length, 0);
});

test('cleanup: suggests stale chats, requires confirmation, deletes in bulk', async (t) => {
  const env = await launch([
    { id: 'keep-recent', title: 'Thesis outline', prompts: ['outline my thesis on solar panel efficiency', 'add a methods section'], updatedDaysAgo: 2 },
    { id: 'untitled-1', title: 'New chat', prompts: ['hi'], updatedDaysAgo: 5 },
    { id: 'greeting-2', title: 'Greeting', prompts: ['hello', 'thanks'], updatedDaysAgo: 3 },
    { id: 'stale-3', title: 'Trip to Lisbon', prompts: ['3 day itinerary for Lisbon'], updatedDaysAgo: 200 },
  ]);
  t.after(env.close);
  const { page, server } = env;
  await page.goto(`${ORIGIN}/`);
  await waitForRecall(page);

  await recall(page, 'recall-launcher').click();
  await recall(page, 'recall-suggestion').first().waitFor();
  const titles = await recall(page, 'recall-suggestion').allInnerTexts();
  assert.equal(titles.length, 3);
  assert.ok(!titles.some((x) => x.includes('Thesis outline')), 'healthy chats are not suggested');

  // First click only asks; cancelling deletes nothing.
  await recall(page, 'recall-select-all').click();
  await recall(page, 'recall-delete').click();
  await recall(page, 'recall-confirm').waitFor();
  await recall(page, 'recall-confirm-cancel').click();
  assert.deepEqual(server.deleted, []);

  await recall(page, 'recall-delete').click();
  await recall(page, 'recall-confirm-delete').click();
  await recall(page, 'recall-delete-result').waitFor({ timeout: 10000 });
  assert.match(await recall(page, 'recall-delete-result').innerText(), /Deleted 3 chats/);
  assert.deepEqual(server.deleted.sort(), ['greeting-2', 'stale-3', 'untitled-1']);
  assert.ok(server.conversations.has('keep-recent'));
});

test('popup renders stats and the live "would Recall step in?" tester', async (t) => {
  const env = await launch();
  t.after(env.close);
  const { page, context, extensionId } = env;
  await askInNewChat(env, 'How do I reverse a linked list in Python?');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForFunction(() => document.querySelector('#stat-prompts').textContent !== '0');
  await popup.fill('#test-input', 'reverse linked list python');
  assert.match(await popup.locator('#test-result').innerText(), /^Yes: \d+% match/);
  await popup.fill('#test-input', 'give me a new answer: reverse linked list python');
  assert.match(await popup.locator('#test-result').innerText(), /^No: You explicitly asked for a new/);

  // Turning Recall off from the popup takes effect in the page immediately.
  await popup.locator('.switch').click();
  await page.bringToFront();
  await freshChat(page);
  await typePrompt(page, 'reverse a linked list in python');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/c\//);
  assert.equal(await recall(page, 'recall-dialog').count(), 0);
});

test('import is fast: 200 chats with a slow server finish in seconds, in parallel', async (t) => {
  const seed = Array.from({ length: 200 }, (_, i) => ({
    id: `bulk-${String(i).padStart(3, '0')}`,
    title: `Topic number ${i}`,
    prompts: [`question about topic ${i} and subject ${i * 7}`],
    updatedDaysAgo: 1 + (i % 50),
  }));
  const env = await launch(seed, { latencyMs: 150 });
  t.after(env.close);
  const { page, server } = env;
  await page.goto(`${ORIGIN}/`);
  await waitForRecall(page);

  await recall(page, 'recall-welcome').waitFor({ timeout: 5000 });
  const started = Date.now();
  await recall(page, 'recall-welcome').locator('button', { hasText: 'Learn from my chats' }).click();
  await recall(page, 'recall-import').filter({ hasText: 'Done' }).waitFor({ timeout: 30000 });
  const seconds = (Date.now() - started) / 1000;

  if (process.env.RECALL_VERBOSE) console.log(`import: ${seconds.toFixed(1)} s, peak ${server.peakInFlight} parallel requests`);
  // One-at-a-time with a pause (the old behaviour) would take ~90 s here.
  assert.ok(seconds < 15, `import took ${seconds.toFixed(1)} s`);
  assert.ok(server.peakInFlight > 1, 'chats are fetched in parallel');
  assert.ok(server.peakInFlight <= 7, `stays polite (peak ${server.peakInFlight} requests)`);
  assert.match(await recall(page, 'recall-import').innerText(), /from 200 chats/);
});
