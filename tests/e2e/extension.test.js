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

test('does not interrupt: explicit "new answer", small talk, fresh info, "again" in the same chat', async (t) => {
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

  // Explicitly asking for a new answer inside the original chat goes straight through.
  const original = server.sends[0].conversationId;
  await page.goto(`${ORIGIN}/c/${original}`);
  await waitForRecall(page);
  await settle(page, 1500);
  const before = server.sends.length;
  await typePrompt(page, 'write a poem about the ocean at night again');
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

test('exact copy of an earlier chat’s opening prompt is redirected, and the popup explains the last check', async (t) => {
  const opening =
    'So I am preparing for a software engineering interview at a fintech company next month. Can you help me build a study plan ' +
    'that covers data structures, algorithms, system design basics and behavioural questions, with a daily schedule for four ' +
    'weeks, recommended practice problems for each topic, and tips on explaining my thinking out loud? I have about two hours ' +
    'every weekday and five hours on weekends, and I still struggle with dynamic programming.';
  const env = await launch([{ id: 'interview-plan', title: 'Interview study plan', prompts: [opening, 'add mock interviews'], updatedDaysAgo: 15 }]);
  t.after(env.close);
  const { page, server, context, extensionId } = env;

  await page.goto(`${ORIGIN}/`);
  await waitForRecall(page);
  await recall(page, 'recall-welcome').locator('button', { hasText: 'Learn from my chats' }).click();
  await recall(page, 'recall-import').filter({ hasText: 'Done' }).waitFor({ timeout: 15000 });

  // Paste the exact same text into a new chat and press Enter.
  await page.locator('#prompt-textarea').click();
  await page.keyboard.insertText(opening);
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  assert.equal(server.sends.length, 0);
  assert.match(await recall(page, 'recall-match').first().innerText(), /Interview study plan[\s\S]*100% match/);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.locator('[data-testid="last-check"]', { hasText: 'Recall offered an earlier chat' }).waitFor();
});

test('after the extension is reloaded/updated, the old copy steps aside: ChatGPT keeps sending and a reload prompt appears', async (t) => {
  const env = await launch([{ id: 'tcp-chat', title: 'TCP vs UDP', prompts: ['Explain the difference between TCP and UDP'], updatedDaysAgo: 3 }]);
  t.after(env.close);
  const { page, server, worker } = env;
  await page.goto(`${ORIGIN}/c/tcp-chat`);
  await waitForRecall(page);
  await settle(page, 2500);
  await page.goto(`${ORIGIN}/`);
  await waitForRecall(page);

  // What clicking reload on chrome://extensions (or an update) does. In this
  // automated browser the extension doesn't come back afterwards, which is the
  // worst case: the old copy in the tab can no longer reach Chrome's APIs.
  await worker.evaluate(() => globalThis.chrome.runtime.reload()).catch(() => {});
  await page.waitForTimeout(1000);

  // A repeat question is NOT blocked by a broken copy: it is sent normally.
  await typePrompt(page, 'what is the difference between udp and tcp');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/c\//);
  assert.equal(server.sends.length, 1);
  assert.equal(await recall(page, 'recall-dialog').count(), 0);

  // ...and a clear prompt explains what to do.
  await recall(page, 'recall-reload').waitFor({ timeout: 5000 });
  assert.match(await recall(page, 'recall-reload').innerText(), /Reload this page/);
  assert.equal(await recall(page, 'recall-launcher').count(), 0, 'dead cleanup button is removed');
});

test('"Take me there" opens the chat, scrolls to the matching message and highlights it', async (t) => {
  const filler = Array.from({ length: 12 }, (_, i) => `follow-up question number ${i} about something else entirely`);
  const env = await launch([
    { id: 'long-chat', title: 'Big learning session', prompts: [...filler.slice(0, 8), 'How do I reverse a linked list in Python?', ...filler.slice(8)], updatedDaysAgo: 4 },
  ]);
  t.after(env.close);
  const { page } = env;
  await page.goto(`${ORIGIN}/c/long-chat`);
  await waitForRecall(page);
  await settle(page, 2500);

  await freshChat(page);
  await typePrompt(page, 'reverse a linked list in python');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-open-top').click();
  await page.waitForURL(/\/c\/long-chat/);

  const target = page.locator('[data-recall-highlight="recall-jump-target"]');
  await target.waitFor({ timeout: 10000 });
  assert.match(await target.innerText(), /reverse a linked list in Python/);
  // The stand-in page, like ChatGPT, renders older turns late and jumps to the
  // bottom after loading; the message must still end up (and stay) in view.
  await page.waitForTimeout(1800);
  assert.ok(await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  }), 'the matching message is scrolled into view');
  await page.locator('[data-recall-highlight="recall-jump-link"]').waitFor({ timeout: 3000 });
});

test('cleanup shows a clear reason and a link for chats ChatGPT refuses to delete', async (t) => {
  const env = await launch([
    { id: 'untitled-a', title: 'New chat', prompts: ['hi'], updatedDaysAgo: 5 },
    { id: 'untitled-b', title: 'New chat', prompts: ['test'], updatedDaysAgo: 6 },
  ]);
  t.after(env.close);
  const { page, server } = env;
  server.refuseDelete = new Set(['untitled-b']);
  await page.goto(`${ORIGIN}/`);
  await waitForRecall(page);
  await recall(page, 'recall-launcher').click();
  await recall(page, 'recall-suggestion').first().waitFor();
  await recall(page, 'recall-select-all').click();
  await recall(page, 'recall-delete').click();
  await recall(page, 'recall-confirm-delete').click();
  await recall(page, 'recall-delete-result').waitFor({ timeout: 10000 });
  assert.match(await recall(page, 'recall-delete-result').innerText(), /Deleted 1 chat\./);
  assert.match(await recall(page, 'recall-delete-errors').innerText(), /1 couldn’t be deleted: ChatGPT refused the request \(403\)/);
  assert.deepEqual(server.deleted, ['untitled-a']);
});

test('repeating a question inside the same chat is stopped and scrolls to the earlier answer', async (t) => {
  const filler = Array.from({ length: 10 }, (_, i) => `another question number ${i} about unrelated things`);
  const env = await launch([
    { id: 'study-chat', title: 'Study session', prompts: ['How do I center a div in CSS?', ...filler], updatedDaysAgo: 2 },
  ]);
  t.after(env.close);
  const { page, server } = env;
  await page.goto(`${ORIGIN}/c/study-chat`);
  await waitForRecall(page);
  await settle(page, 2000);

  await typePrompt(page, 'how can I center a div using css');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  assert.match(await recall(page, 'recall-dialog').innerText(), /already asked this in this chat/);
  assert.equal(server.sends.length, 0, 'not generated again');

  await recall(page, 'recall-open-top').click(); // "Show me the answer"
  const target = page.locator('[data-recall-highlight="recall-jump-target"]');
  await target.waitFor({ timeout: 5000 });
  assert.match(await target.innerText(), /center a div in CSS/);
  await page.waitForTimeout(800);
  assert.ok(await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  }), 'scrolled to the earlier question and its answer');
  assert.equal((await page.locator('#prompt-textarea').innerText()).trim(), '', 'repeated draft cleared');
  assert.equal(server.sends.length, 0);
});

test('undo right after a bulk delete brings the chats back', async (t) => {
  const env = await launch([
    { id: 'untitled-1', title: 'New chat', prompts: ['hi'], updatedDaysAgo: 5 },
    { id: 'greeting-2', title: 'Greeting', prompts: ['hello', 'thanks'], updatedDaysAgo: 3 },
  ]);
  t.after(env.close);
  const { page, server } = env;
  await freshChat(page);
  await recall(page, 'recall-launcher').click();
  await recall(page, 'recall-suggestion').first().waitFor();
  await recall(page, 'recall-select-all').click();
  await recall(page, 'recall-delete').click();
  await recall(page, 'recall-confirm-delete').click();
  await recall(page, 'recall-undo').waitFor({ timeout: 10000 });
  assert.equal(server.deleted.length, 2);

  await recall(page, 'recall-undo').click();
  await recall(page, 'recall-undo-result').waitFor();
  assert.match(await recall(page, 'recall-undo-result').innerText(), /Restored 2 chats/);
  assert.deepEqual(server.restored.sort(), ['greeting-2', 'untitled-1']);
  assert.ok(server.conversations.has('untitled-1'));
});

test('"Pause Recall for 1 hour" sends the message, stops checks, and can be resumed from the popup', async (t) => {
  const env = await launch();
  t.after(env.close);
  const { page, server, context, extensionId } = env;
  await askInNewChat(env, 'How do I reverse a linked list in Python?');

  await freshChat(page);
  await typePrompt(page, 'reverse a linked list in python');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  await recall(page, 'recall-pause').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-message-author-role="assistant"]').length === 1);
  assert.equal(server.sends.length, 2, 'the message was sent');
  await recall(page, 'recall-paused').waitFor();

  // While paused, a repeat goes straight through.
  await freshChat(page);
  await typePrompt(page, 'how to reverse a linked list in python');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-message-author-role="assistant"]').length === 1);
  assert.equal(server.sends.length, 3);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.locator('[data-testid="paused-banner"]').waitFor();
  assert.match(await popup.locator('#paused-text').innerText(), /paused until/);
  await popup.click('#resume');
  await popup.locator('[data-testid="paused-banner"]').waitFor({ state: 'hidden' });

  // Checks are back on.
  await page.bringToFront();
  await freshChat(page);
  await typePrompt(page, 'reverse a linked list in python');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  assert.equal(server.sends.length, 3);
});

test('keyboard focus stays inside the dialog', async (t) => {
  const env = await launch();
  t.after(env.close);
  const { page } = env;
  await askInNewChat(env, 'Explain the difference between TCP and UDP');
  await freshChat(page);
  await typePrompt(page, 'what is the difference between udp and tcp');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i % 3 ? 'Tab' : 'Shift+Tab');
    const inside = await page.evaluate(() => document.activeElement && document.activeElement.tagName === 'RECALL-OVERLAY');
    assert.ok(inside, `focus left the dialog after ${i + 1} Tab presses`);
  }
});

test('full settings page opens with settings visible and saves the debug switch', async (t) => {
  const env = await launch();
  t.after(env.close);
  const { context, extensionId, worker } = env;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html?options=1`);
  assert.ok(await page.evaluate(() => document.body.classList.contains('page') && document.querySelector('#settings-box').open));
  await page.check('[data-testid="debug"]');
  await page.waitForTimeout(200);
  const saved = await worker.evaluate(() => globalThis.chrome.storage.sync.get('recall.settings'));
  assert.equal(saved['recall.settings'].debug, true);
});

test('several similar chats are listed; picking any one opens it at that prompt (not only exact copies)', async (t) => {
  const env = await launch([
    { id: 'chat-a', title: 'Linked lists A', prompts: ['How do I reverse a linked list in Python?'], updatedDaysAgo: 30 },
    { id: 'chat-b', title: 'Linked lists B', prompts: ['intro question about sorting', 'reverse linked list python'], updatedDaysAgo: 20 },
    { id: 'chat-c', title: 'Linked lists C', prompts: ['what is a stack', 'python: reversing a linked list?', 'thanks that helps'], updatedDaysAgo: 10 },
    { id: 'chat-d', title: 'Linked lists D', prompts: ['reversing a linked list in python, how?'], updatedDaysAgo: 5 },
  ]);
  t.after(env.close);
  const { page, server } = env;
  await freshChat(page);
  await recall(page, 'recall-welcome').waitFor();
  // Learn the history once (new chats you send are learned automatically).
  await recall(page, 'recall-welcome').getByText('Learn from my chats').click();
  await page.waitForTimeout(2500);

  await typePrompt(page, 'how can I reverse a linked list using python');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  const items = recall(page, 'recall-match');
  assert.equal(await items.count(), 4, 'all four similar chats are offered');
  assert.equal(server.sends.length, 0);

  // Pick the chat-c entry, whose prompt is worded differently from what was typed.
  const pick = items.filter({ hasText: 'Linked lists C' });
  await pick.getByRole('button', { name: /Open chat/ }).click();
  await page.waitForURL(/\/c\/chat-c/);
  const target = page.locator('[data-recall-highlight="recall-jump-target"]');
  await target.waitFor({ timeout: 10000 });
  assert.equal((await target.innerText()).trim(), 'python: reversing a linked list?');
  assert.equal(server.sends.length, 0, 'nothing was sent');
});

test('"Take me there" from inside another chat lands on the right message (old chat lingers while the new one loads)', async (t) => {
  const filler = Array.from({ length: 10 }, (_, i) => `side question ${i} about gardening tomatoes in pots`);
  const env = await launch([
    { id: 'here-chat', title: 'Gardening', prompts: ['how often should I water basil', 'what soil for tomatoes in pots', 'best fertilizer for tomato plants'], updatedDaysAgo: 1 },
    { id: 'there-chat', title: 'Python help', prompts: [...filler.slice(0, 1), 'How do I reverse a linked list in Python?', ...filler.slice(1)], updatedDaysAgo: 9 },
  ]);
  t.after(env.close);
  const { page, server } = env;
  await page.goto(`${ORIGIN}/c/there-chat`);
  await waitForRecall(page);
  await settle(page, 2500);

  await page.goto(`${ORIGIN}/c/here-chat`);
  await waitForRecall(page);
  await settle(page, 1500);
  await typePrompt(page, 'reverse a linked list in python');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-open-top').click();
  await page.waitForURL(/\/c\/there-chat/);

  const target = page.locator('[data-recall-highlight="recall-jump-target"]');
  await target.waitFor({ timeout: 15000 });
  assert.equal((await target.innerText()).trim(), 'How do I reverse a linked list in Python?');
  assert.equal(await target.getAttribute('data-message-id'), 'there-chat-m2', 'found by ChatGPT’s own message id');
  await page.waitForTimeout(1800);
  // Visible, and not hidden under the sticky header.
  assert.ok(await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 56 && r.bottom <= window.innerHeight;
  }), 'the message is fully in view below the header');
  assert.equal(server.sends.length, 0);

  // The old chat's messages, still on screen during the switch, were not learned as the new chat's.
  await page.waitForTimeout(1500);
  const { 'recall.index': idx } = await env.worker.evaluate(() => globalThis.chrome.storage.local.get('recall.index'));
  const wrong = idx.e.filter(([conv, prompt]) => conv === 'there-chat' && /water basil|soil for tomatoes|fertilizer/.test(prompt));
  assert.deepEqual(wrong, [], 'no prompts attributed to the wrong chat');
});

test('"Take me there" lands on the prompt even when only the chat TITLE matched (after importing history)', async (t) => {
  const filler = Array.from({ length: 9 }, (_, i) => `unrelated question ${i} about baking sourdough bread at home`);
  const env = await launch([
    { id: 'titled-chat', title: 'Reverse a linked list in Python', prompts: [...filler.slice(0, 3), 'python: flip the order of nodes in a singly linked list', ...filler.slice(3)], updatedDaysAgo: 12 },
  ]);
  t.after(env.close);
  const { page } = env;
  await freshChat(page);
  await recall(page, 'recall-welcome').getByText('Learn from my chats').click();
  await page.waitForTimeout(2500);

  await typePrompt(page, 'reverse a linked list in python');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  await recall(page, 'recall-open-top').click();
  await page.waitForURL(/\/c\/titled-chat/);
  const target = page.locator('[data-recall-highlight="recall-jump-target"]');
  await target.waitFor({ timeout: 15000 });
  assert.equal((await target.innerText()).trim(), 'python: flip the order of nodes in a singly linked list');
});

test('repeat checks keep working, again and again, without reloading the page', async (t) => {
  const env = await launch([
    { id: 'chat-sql', title: 'SQL joins', prompts: ['Explain the difference between inner join and left join in SQL'], updatedDaysAgo: 6 },
  ]);
  t.after(env.close);
  const { page, server } = env;
  await askInNewChat(env, 'How do I reverse a linked list in Python?');
  const pythonChat = page.url();
  const dialogs = () => page.locator('recall-overlay [data-testid="recall-dialog"]').count();
  const assistantCount = () => page.locator('[data-message-author-role="assistant"]').count();

  // 1. Stopped, dismissed with Esc, then Enter again: stopped again.
  await freshChat(page);
  await typePrompt(page, 'reverse a linked list in python');
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Enter');
    await recall(page, 'recall-dialog').waitFor();
    assert.equal(await dialogs(), 1, 'exactly one dialog');
    await page.keyboard.press('Escape');
    await recall(page, 'recall-dialog').waitFor({ state: 'detached' });
  }
  // ...and with the send button.
  await page.locator('[data-testid="send-button"]').click();
  await recall(page, 'recall-dialog').waitFor();
  assert.equal(server.sends.length, 1, 'nothing extra was sent');

  // 2. "Ask anyway" lets exactly one send through.
  await recall(page, 'recall-ask-anyway').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-message-author-role="assistant"]').length === 1);
  assert.equal(server.sends.length, 2);
  await page.waitForTimeout(400);
  await typePrompt(page, 'how to reverse a linked list in python?');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  assert.equal(server.sends.length, 2, 'the next repeat is stopped again');
  assert.equal(await assistantCount(), 1);

  // 3. Switch chats in-app (no reload), Take me there, then repeat it inside that chat: stopped (same-chat).
  await recall(page, 'recall-cancel').click();
  await page.locator('nav a[href="/c/chat-sql"]').click();
  await page.waitForURL(/\/c\/chat-sql/);
  await page.waitForTimeout(2500); // opened chats are learned
  await typePrompt(page, 'reverse a linked list in python');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  const other = recall(page, 'recall-match').filter({ hasText: /How do I reverse/ }).first();
  await other.getByRole('button', { name: /Open chat/ }).click();
  await page.waitForURL(pythonChat);
  await page.waitForTimeout(2500);
  await typePrompt(page, 'How do I reverse a linked list in Python?');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  assert.match(await recall(page, 'recall-dialog').innerText(), /in this chat/);
  await page.keyboard.press('Escape');

  // 4. Still in the same page: a repeat of a different chat is stopped too.
  await typePrompt(page, 'difference between left join and inner join in sql');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  assert.match(await recall(page, 'recall-match').first().innerText(), /SQL joins/);
  assert.equal(server.sends.length, 2, 'no repeat was ever generated');
});

test('when Recall is injected again (update), the newest copy takes over: one dialog, one send', async (t) => {
  const env = await launch();
  t.after(env.close);
  const { page, server, worker } = env;
  await askInNewChat(env, 'Explain the difference between TCP and UDP');
  await freshChat(page);

  // What the service worker does after an update: inject the scripts again, twice for good measure.
  for (let i = 0; i < 2; i++) {
    await worker.evaluate(async () => {
      const [tab] = await globalThis.chrome.tabs.query({ url: 'https://chatgpt.com/*' });
      const files = globalThis.chrome.runtime.getManifest().content_scripts[0].js;
      await globalThis.chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
    });
  }
  await page.waitForTimeout(800);
  assert.equal(await page.locator('recall-overlay').count(), 1, 'old copies removed their UI');

  await typePrompt(page, 'what is the difference between udp and tcp');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  assert.equal(await page.locator('recall-overlay [data-testid="recall-dialog"]').count(), 1);
  await recall(page, 'recall-ask-anyway').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-message-author-role="assistant"]').length === 1);
  await page.waitForTimeout(500);
  assert.equal(server.sends.length, 2, 'sent exactly once');

  await typePrompt(page, 'udp vs tcp difference');
  await page.keyboard.press('Enter');
  await recall(page, 'recall-dialog').waitFor();
  assert.equal(server.sends.length, 2);
});

test('safety net: a send that skips the keyboard and the send button is still checked at the network level', async (t) => {
  const env = await launch();
  t.after(env.close);
  const { page, server } = env;
  await askInNewChat(env, 'How do I reverse a linked list in Python?');
  const firstUrl = page.url();

  // 1. Held back, "Keep editing": nothing is sent and the text is back in the box.
  await freshChat(page);
  page.evaluate(() => window.mockSendDirect('reverse a linked list in python'));
  await recall(page, 'recall-dialog').waitFor();
  assert.equal(server.sends.length, 1, 'held at the network level');
  await recall(page, 'recall-cancel').click();
  await page.waitForFunction(() => window.lastSendError === 'AbortError');
  await page.waitForFunction(() => document.querySelector('#prompt-textarea').innerText.includes('reverse a linked list'));
  assert.equal(server.sends.length, 1);

  // 2. "Ask anyway" releases exactly that request.
  await page.evaluate(() => (document.querySelector('#prompt-textarea').textContent = ''));
  page.evaluate(() => window.mockSendDirect('python reverse a linked list'));
  await recall(page, 'recall-dialog').waitFor();
  await recall(page, 'recall-ask-anyway').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-message-author-role="assistant"]').length === 1);
  assert.equal(server.sends.length, 2);

  // 3. "Take me there" stops the request and opens the earlier chat.
  await freshChat(page);
  page.evaluate(() => window.mockSendDirect('how do i reverse a linked list in python'));
  await recall(page, 'recall-dialog').waitFor();
  await recall(page, 'recall-open-top').click();
  await page.waitForURL(firstUrl);
  assert.equal(server.sends.length, 2);

  // 4. Normal sends through the keyboard are not checked twice (no second dialog, sent once).
  await freshChat(page);
  await typePrompt(page, 'what is a good name for a goldfish');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-message-author-role="assistant"]').length === 1);
  assert.equal(server.sends.length, 3);
  assert.equal(await recall(page, 'recall-dialog').count(), 0);
});
