/*
 * Regenerates the README screenshots in docs/images using the same mock chat
 * app and real extension build as the end-to-end tests.
 *
 * Usage: npm run screenshots
 */
const path = require('node:path');
const { launch, typePrompt, recall, waitForRecall, ORIGIN, ROOT } = require('../tests/e2e/harness.js');

const OUT = path.join(ROOT, 'docs', 'images');
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, name), ...opts });

const SEED = [
  { id: 'chat-linked-list', title: 'Reverse a linked list', prompts: ['How do I reverse a linked list in Python?', 'Can you also do it recursively?'], updatedDaysAgo: 21 },
  { id: 'chat-linked-list-2', title: 'Linked list reversal', prompts: ['how to reverse a singly linked list in python'], updatedDaysAgo: 64 },
  { id: 'chat-tcp', title: 'TCP vs UDP', prompts: ['Explain the difference between TCP and UDP'], updatedDaysAgo: 9 },
  { id: 'chat-cover', title: 'Internship cover letter', prompts: ['Write a cover letter for a software engineering internship'], updatedDaysAgo: 4 },
  { id: 'chat-new', title: 'New chat', prompts: ['hi'], updatedDaysAgo: 2 },
  { id: 'chat-greet', title: 'Friendly Greeting', prompts: ['hello', 'thanks'], updatedDaysAgo: 30 },
  { id: 'chat-test', title: 'Test message', prompts: ['test'], updatedDaysAgo: 120 },
  { id: 'chat-lisbon', title: 'Lisbon weekend itinerary', prompts: ['3 day itinerary for Lisbon'], updatedDaysAgo: 210 },
  { id: 'chat-css', title: 'Center a div', prompts: ['how to center a div in css'], updatedDaysAgo: 150 },
];

(async () => {
  const env = await launch(SEED, { deviceScaleFactor: 2, viewport: { width: 1200, height: 760 } });
  const { page, context, extensionId } = env;
  try {
    // Teach Recall by opening a few chats (passive indexing).
    for (const id of ['chat-linked-list', 'chat-linked-list-2', 'chat-tcp', 'chat-cover']) {
      await page.goto(`${ORIGIN}/c/${id}`);
      await waitForRecall(page);
      await page.waitForTimeout(3000);
    }

    // 1. The redirect dialog.
    await page.goto(`${ORIGIN}/`);
    await waitForRecall(page);
    await recall(page, 'recall-welcome').waitFor({ timeout: 8000 }).catch(() => {});
    await shot(page, 'welcome-toast.png');
    await recall(page, 'recall-welcome').locator('button', { hasText: 'Not now' }).click().catch(() => {});
    await typePrompt(page, 'reverse a linked list in python');
    await page.keyboard.press('Enter');
    await recall(page, 'recall-dialog').waitFor();
    await page.waitForTimeout(300);
    await shot(page, 'redirect-dialog.png');
    await page.keyboard.press('Escape');

    // 2. Cleanup panel and its confirmation step.
    await recall(page, 'recall-launcher').click();
    await recall(page, 'recall-suggestion').first().waitFor();
    await page.waitForTimeout(300);
    await shot(page, 'cleanup-panel.png');
    await recall(page, 'recall-delete').click();
    await recall(page, 'recall-confirm').waitFor();
    await page.waitForTimeout(200);
    await shot(page, 'cleanup-confirm.png');
    await recall(page, 'recall-confirm-cancel').click();
    await page.keyboard.press('Escape');

    // 3. The popup, with the live tester filled in.
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 480 });
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await popup.fill('#test-input', 'difference between udp and tcp?');
    await popup.waitForTimeout(300);
    await popup.screenshot({ path: path.join(OUT, 'popup.png'), fullPage: true });

    console.log('Screenshots written to', OUT);
  } finally {
    await env.close();
  }
})();
