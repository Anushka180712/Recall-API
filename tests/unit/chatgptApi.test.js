const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, extractUserPrompts, toMs, ChatGPTApiError } = require('../../src/lib/chatgptApi.js');

/** A tiny fake of the ChatGPT web endpoints. */
function fakeServer({ total = 3, failDelete = [], expireTokenOnce = false } = {}) {
  const calls = [];
  let tokenN = 0;
  let expired = expireTokenOnce;
  const items = Array.from({ length: total }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}`, create_time: 1700000000 + i, update_time: '2026-01-0' + ((i % 9) + 1) + 'T00:00:00Z' }));
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  async function fetch(url, init = {}) {
    calls.push({ url, method: init.method || 'GET', auth: init.headers && init.headers.Authorization, body: init.body });
    const u = new URL(url, 'https://chatgpt.com');
    if (u.pathname === '/api/auth/session') return json(200, { accessToken: `tok${++tokenN}` });
    if (expired) {
      expired = false;
      return json(401, {});
    }
    if (u.pathname === '/backend-api/conversations') {
      const off = Number(u.searchParams.get('offset'));
      const lim = Number(u.searchParams.get('limit'));
      return json(200, { items: items.slice(off, off + lim), total });
    }
    const m = u.pathname.match(/^\/backend-api\/conversation\/(.+)$/);
    if (m && (init.method || 'GET') === 'GET') {
      return json(200, {
        title: 'T',
        mapping: {
          a: { message: { author: { role: 'system' }, content: { parts: ['sys'] }, create_time: 1 } },
          b: { message: { author: { role: 'user' }, content: { parts: ['second'] }, create_time: 3 } },
          c: { message: { author: { role: 'user' }, content: { parts: ['first'] }, create_time: 2 } },
          d: { message: { author: { role: 'assistant' }, content: { parts: ['answer'] }, create_time: 4 } },
          e: null,
        },
      });
    }
    if (m && init.method === 'PATCH') {
      if (failDelete.includes(decodeURIComponent(m[1]))) return json(500, {});
      return json(200, { success: true });
    }
    return json(404, {});
  }
  return { fetch, calls };
}

test('listConversations pages until the end and normalises timestamps', async () => {
  const srv = fakeServer({ total: 5 });
  const api = createClient({ fetch: srv.fetch });
  const list = await api.listConversations({ pageSize: 2 });
  assert.equal(list.length, 5);
  assert.deepEqual(list[0], { id: 'c0', title: 'Chat 0', createdAt: 1700000000000, updatedAt: Date.parse('2026-01-01T00:00:00Z') });
  assert.equal(srv.calls.filter((c) => c.url.includes('/conversations')).length, 3);
  assert.equal(srv.calls.filter((c) => c.url.includes('/api/auth/session')).length, 1, 'token is cached');
});

test('listConversations respects the limit', async () => {
  const api = createClient({ fetch: fakeServer({ total: 50 }).fetch });
  assert.equal((await api.listConversations({ limit: 7, pageSize: 5 })).length, 7);
});

test('getConversation returns only user prompts, oldest first', async () => {
  const api = createClient({ fetch: fakeServer().fetch });
  assert.deepEqual((await api.getConversation('c1')).prompts, ['first', 'second']);
});

test('deleteMany sends PATCH is_visible:false and keeps going after a failure', async () => {
  const srv = fakeServer({ failDelete: ['c1'] });
  const api = createClient({ fetch: srv.fetch });
  const progress = [];
  const res = await api.deleteMany(['c0', 'c1', 'c2'], { onProgress: (d, t) => progress.push(`${d}/${t}`) });
  assert.deepEqual(res.deleted, ['c0', 'c2']);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].id, 'c1');
  assert.deepEqual(progress, ['1/3', '2/3', '3/3']);
  const patch = srv.calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.body), { is_visible: false });
  assert.match(patch.auth, /^Bearer tok/);
});

test('an expired token is refreshed once automatically', async () => {
  const srv = fakeServer({ expireTokenOnce: true });
  const api = createClient({ fetch: srv.fetch });
  await api.deleteConversation('c0');
  assert.equal(srv.calls.filter((c) => c.url.includes('/api/auth/session')).length, 2);
});

test('signed-out sessions raise a clear error', async () => {
  const api = createClient({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  await assert.rejects(api.listConversations(), (e) => e instanceof ChatGPTApiError && /Not signed in/.test(e.message));
});

test('HTTP errors raise ChatGPTApiError with the status', async () => {
  const fetch = async (url) =>
    url.includes('session') ? { ok: true, status: 200, json: async () => ({ accessToken: 't' }) } : { ok: false, status: 403, json: async () => ({}) };
  const api = createClient({ fetch });
  await assert.rejects(api.getConversation('x'), (e) => e.status === 403);
});

test('extractUserPrompts tolerates odd payloads', () => {
  assert.deepEqual(extractUserPrompts(null), []);
  assert.deepEqual(
    extractUserPrompts({ mapping: { a: { message: { author: { role: 'user' }, content: { parts: [{ image: 1 }, ' hi '] } } } } }),
    ['hi']
  );
  assert.deepEqual(
    extractUserPrompts({ mapping: { a: { message: { author: { role: 'user' }, metadata: { is_visually_hidden_from_conversation: true }, content: { parts: ['hidden'] } } } } }),
    []
  );
});

test('toMs handles seconds, milliseconds, ISO strings and junk', () => {
  assert.equal(toMs(1700000000), 1700000000000);
  assert.equal(toMs(1700000000000), 1700000000000);
  assert.equal(toMs('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(toMs('nope'), 0);
  assert.equal(toMs(null), 0);
});

test('mapPool keeps order and never exceeds the concurrency limit', async () => {
  const { mapPool } = require('../../src/lib/chatgptApi.js');
  let active = 0;
  let peak = 0;
  const out = await mapPool([5, 1, 4, 2, 3], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, n * 3));
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
});

test('rate-limited (429) requests back off and retry', async () => {
  let hits = 0;
  const fetch = async (url) => {
    if (url.includes('session')) return { ok: true, status: 200, json: async () => ({ accessToken: 't' }) };
    hits++;
    if (hits < 3) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  const api = createClient({ fetch, backoffMs: 1 });
  assert.equal(await api.deleteConversation('x'), true);
  assert.equal(hits, 3);
});

test('getConversations fetches in parallel and reports failures per chat', async () => {
  const srv = fakeServer();
  const fetch = async (url, init) => (url.includes('/conversation/bad') ? { ok: false, status: 404, json: async () => ({}) } : srv.fetch(url, init));
  const api = createClient({ fetch, concurrency: 3 });
  const progress = [];
  const res = await api.getConversations(['a', 'bad', 'c'], { onProgress: (d) => progress.push(d) });
  assert.deepEqual(res.map((r) => r.id), ['a', 'bad', 'c']);
  assert.deepEqual(res[0].prompts, ['first', 'second']);
  assert.match(res[1].error, /404/);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.equal(srv.calls.filter((c) => c.url.includes('/api/auth/session')).length, 1, 'one shared session lookup');
});
