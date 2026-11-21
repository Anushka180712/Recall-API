/*
 * End-to-end harness: launches Chromium with the unpacked extension loaded and
 * serves a mock chat app on https://chatgpt.com via Playwright request
 * routing. No real network traffic and no real account are involved.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'mock-chat.html'), 'utf8');
const ORIGIN = 'https://chatgpt.com';
const DAY = 86400000;

/**
 * Extensions need full Chromium (not the headless shell). Use CHROMIUM_PATH
 * when set, otherwise Playwright's bundled Chromium via channel "chromium".
 */
function browserOptions() {
  const exe = process.env.CHROMIUM_PATH;
  return exe && fs.existsSync(exe) ? { executablePath: exe } : { channel: 'chromium' };
}

/** In-memory "server" holding conversations. */
class MockServer {
  constructor(seed = [], { latencyMs = 0 } = {}) {
    this.latencyMs = latencyMs; // simulated server delay for /backend-api calls
    this.inFlight = 0;
    this.peakInFlight = 0;
    this.conversations = new Map();
    this.sends = [];
    this.deleted = [];
    this.restored = [];
    this.hidden = new Map();
    this.nextId = 1;
    for (const c of seed) this.addConversation(c);
  }

  addConversation({ id, title, prompts = [], updatedDaysAgo = 1 }) {
    const t = Date.now() - updatedDaysAgo * DAY;
    this.conversations.set(id, { id, title, created: t, updated: t, messages: prompts.flatMap((p, i) => [
      { role: 'user', text: p, t: t + i * 2 },
      { role: 'assistant', text: `Answer to: ${p}`, t: t + i * 2 + 1 },
    ]) });
  }

  async handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname === '/api/auth/session') return json({ accessToken: 'mock-token' });

    if (this.latencyMs && url.pathname.startsWith('/backend-api/')) {
      this.inFlight++;
      this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
      await new Promise((r) => setTimeout(r, this.latencyMs));
      this.inFlight--;
    }

    if (url.pathname === '/backend-api/conversations') {
      const off = Number(url.searchParams.get('offset') || 0);
      const lim = Number(url.searchParams.get('limit') || 28);
      const all = [...this.conversations.values()].sort((a, b) => b.updated - a.updated);
      return json({
        items: all.slice(off, off + lim).map((c) => ({ id: c.id, title: c.title, create_time: c.created / 1000, update_time: new Date(c.updated).toISOString() })),
        total: all.length,
      });
    }

    const m = url.pathname.match(/^\/backend-api\/conversation\/([\w-]+)$/);
    if (m) {
      const c = this.conversations.get(m[1]);
      if (req.method() === 'PATCH') {
        // Like ChatGPT, "delete" only hides a chat, so it can be restored.
        if (this.refuseDelete && this.refuseDelete.has(m[1])) return json({ detail: 'forbidden' }, 403);
        const visible = JSON.parse(req.postData() || '{}').is_visible;
        if (visible === false) {
          if (!c) return json({}, 404);
          this.conversations.delete(m[1]);
          this.hidden.set(m[1], c);
          this.deleted.push(m[1]);
        } else if (visible === true) {
          const h = this.hidden.get(m[1]);
          if (!h) return json({}, 404);
          this.hidden.delete(m[1]);
          this.conversations.set(m[1], h);
          this.restored.push(m[1]);
        }
        return json({ success: true });
      }
      if (!c) return json({ detail: 'not found' }, 404);
      const mapping = {};
      c.messages.forEach((msg, i) => {
        mapping[`n${i}`] = { message: { id: `${c.id}-m${i}`, author: { role: msg.role }, content: { parts: [msg.text] }, create_time: msg.t / 1000 } };
      });
      return json({ title: c.title, mapping });
    }

    if (url.pathname === '/backend-api/conversation' && req.method() === 'POST') {
      const body = JSON.parse(req.postData());
      const conversationId = body.conversation_id;
      const text = body.messages[0].content.parts.join('\n');
      let id = conversationId;
      if (!id || !this.conversations.has(id)) {
        id = `mock-${String(this.nextId++).padStart(4, '0')}-chat`;
        this.addConversation({ id, title: text.slice(0, 40), prompts: [], updatedDaysAgo: 0 });
      }
      const c = this.conversations.get(id);
      c.messages.push({ role: 'user', text, t: Date.now() }, { role: 'assistant', text: `Answer to: ${text}`, t: Date.now() + 1 });
      c.updated = Date.now();
      this.sends.push({ conversationId: id, text });
      return json({ conversationId: id, answer: `Answer to: ${text}` });
    }

    if (req.resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE });
    return route.fulfill({ status: 404, body: '' });
  }
}

async function launch(seed, { deviceScaleFactor = 1, viewport = { width: 1280, height: 800 }, latencyMs = 0 } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-e2e-'));
  const server = new MockServer(seed, { latencyMs });
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...browserOptions(),
    headless: true,
    viewport,
    deviceScaleFactor,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-sandbox'],
  });
  await context.route(`${ORIGIN}/**`, (route) => server.handle(route));

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extensionId = new URL(worker.url()).host;
  const page = context.pages()[0] || (await context.newPage());

  async function close() {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  return { context, page, server, extensionId, worker, close };
}

/** Type into the mock composer like a user would. */
async function typePrompt(page, text) {
  const box = page.locator('#prompt-textarea');
  await box.click();
  await box.evaluate((el) => (el.textContent = ''));
  await page.keyboard.type(text);
}

/** Recall's UI lives in a shadow root; Playwright's locators pierce it. */
const recall = (page, testid) => page.locator(`recall-overlay [data-testid="${testid}"]`);

async function waitForRecall(page) {
  await page.locator('recall-overlay').waitFor({ state: 'attached', timeout: 10000 });
}

module.exports = { launch, typePrompt, recall, waitForRecall, ORIGIN, ROOT, DAY };
