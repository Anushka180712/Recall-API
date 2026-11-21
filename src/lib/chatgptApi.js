/*
 * Thin adapter over the endpoints the ChatGPT web app itself uses.
 *
 * These endpoints are not a public API and can change without notice, so:
 *   - every call goes through this one file (one place to fix),
 *   - every failure is surfaced as a ChatGPTApiError, never thrown silently,
 *   - the redirect feature never depends on it (it works from prompts you send
 *     and chats you open even if every call here fails).
 *
 * Requests are same-origin calls from the chatgpt.com tab using your existing
 * session. Nothing is sent anywhere else.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecallDefine('chatgptApi', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class ChatGPTApiError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = 'ChatGPTApiError';
      this.status = status;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Run `fn` over `items` with at most `concurrency` in flight, preserving order.
   * Much faster than one-at-a-time while staying gentle on the server.
   */
  async function mapPool(items, concurrency, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
    return results;
  }

  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetch]
   * @param {string} [opts.origin] e.g. "https://chatgpt.com"
   * @param {number} [opts.concurrency] parallel requests for bulk reads/deletes
   * @param {number} [opts.maxRetries] retries after HTTP 429 (rate limited)
   */
  function createClient({ fetch: fetchImpl = globalThis.fetch, origin = '', concurrency = 6, maxRetries = 3, backoffMs = 1000 } = {}) {
    let token = null;
    let tokenPromise = null;

    async function ensureToken() {
      if (token) return token;
      // Parallel requests share one session lookup.
      tokenPromise = tokenPromise || getAccessToken().finally(() => (tokenPromise = null));
      token = await tokenPromise;
      return token;
    }

    async function request(path, init = {}, retry = true, attempt = 0) {
      await ensureToken();
      const res = await fetchImpl(origin + path, {
        credentials: 'include',
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
      });
      if (res.status === 401 && retry) {
        token = null; // token expired: fetch a fresh one once
        return request(path, init, false, attempt);
      }
      if (res.status === 429 && attempt < maxRetries) {
        // Rate limited: back off (honouring Retry-After when present) and retry.
        const header = res.headers && res.headers.get && Number(res.headers.get('retry-after'));
        await sleep(header > 0 ? header * 1000 : backoffMs * 2 ** attempt);
        return request(path, init, retry, attempt + 1);
      }
      if (!res.ok) throw new ChatGPTApiError(`${init.method || 'GET'} ${path} failed (${res.status})`, res.status);
      return res.status === 204 ? null : res.json();
    }

    async function getAccessToken() {
      const res = await fetchImpl(origin + '/api/auth/session', { credentials: 'include' });
      if (!res.ok) throw new ChatGPTApiError('Could not read your ChatGPT session', res.status);
      const data = await res.json();
      if (!data || !data.accessToken) throw new ChatGPTApiError('Not signed in to ChatGPT', 401);
      return data.accessToken;
    }

    /** Pages through the chat list, newest first. */
    /**
     * The chat list, newest first. The first page tells us the total, then the
     * remaining pages are fetched in parallel.
     */
    async function listConversations({ limit = 300, pageSize = 100, onProgress } = {}) {
      const fetchPage = async (offset) => {
        const page = await request(`/backend-api/conversations?offset=${offset}&limit=${pageSize}&order=updated`);
        return { items: ((page && page.items) || []).map(normalizeConversation), total: page && page.total };
      };
      const first = await fetchPage(0);
      let out = first.items;
      if (onProgress) onProgress(out.length, Math.min(limit, first.total ?? out.length));
      if (first.items.length < pageSize || out.length >= limit) return out.slice(0, limit);

      if (first.total != null) {
        const offsets = [];
        for (let off = pageSize; off < Math.min(limit, first.total); off += pageSize) offsets.push(off);
        const pages = await mapPool(offsets, concurrency, fetchPage);
        for (const p of pages) out = out.concat(p.items);
      } else {
        // Total unknown: walk pages until a short one.
        for (let off = pageSize; out.length < limit; off += pageSize) {
          const p = await fetchPage(off);
          out = out.concat(p.items);
          if (p.items.length < pageSize) break;
        }
      }
      if (onProgress) onProgress(Math.min(out.length, limit), Math.min(out.length, limit));
      return out.slice(0, limit);
    }

    /** Fetch many conversations in parallel; failures are reported, not thrown. */
    async function getConversations(ids, { onProgress, onResult } = {}) {
      let done = 0;
      return mapPool(ids, concurrency, async (id) => {
        let result;
        try {
          result = await getConversation(id);
        } catch (err) {
          result = { id, error: err.message, prompts: [] };
        }
        if (onResult) onResult(result);
        if (onProgress) onProgress(++done, ids.length);
        return result;
      });
    }

    async function getConversation(id) {
      const data = await request(`/backend-api/conversation/${encodeURIComponent(id)}`);
      return { id, title: data.title || '', prompts: extractUserPrompts(data) };
    }

    /** Hides the chat exactly like the web app's own "Delete" menu item does. */
    async function deleteConversation(id) {
      await request(`/backend-api/conversation/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_visible: false }),
      });
      return true;
    }

    /**
     * Deletes a few at a time and reports per-chat results; one failure never
     * aborts the rest.
     */
    async function deleteMany(ids, { onProgress } = {}) {
      const results = { deleted: [], failed: [] };
      let done = 0;
      const outcomes = await mapPool(ids, Math.min(concurrency, 3), async (id) => {
        let ok;
        try {
          await deleteConversation(id);
          ok = true;
        } catch (err) {
          ok = err.message;
        }
        if (onProgress) onProgress(++done, ids.length);
        return ok;
      });
      outcomes.forEach((ok, i) => (ok === true ? results.deleted.push(ids[i]) : results.failed.push({ id: ids[i], error: ok })));
      return results;
    }

    return { listConversations, getConversation, getConversations, deleteConversation, deleteMany, getAccessToken };
  }

  function toMs(t) {
    if (t == null) return 0;
    if (typeof t === 'number') return t < 1e12 ? Math.round(t * 1000) : t;
    const n = Date.parse(t);
    return Number.isNaN(n) ? 0 : n;
  }

  function normalizeConversation(it) {
    return { id: it.id, title: it.title || '', createdAt: toMs(it.create_time), updatedAt: toMs(it.update_time) };
  }

  /** User-authored text messages from a conversation payload, oldest first. */
  function extractUserPrompts(data) {
    const nodes = Object.values((data && data.mapping) || {});
    return nodes
      .map((n) => n && n.message)
      .filter((m) => m && m.author && m.author.role === 'user' && m.content)
      .filter((m) => !m.metadata || !m.metadata.is_visually_hidden_from_conversation)
      .sort((a, b) => (a.create_time || 0) - (b.create_time || 0))
      .map((m) => (m.content.parts || []).filter((p) => typeof p === 'string').join('\n').trim())
      .filter(Boolean);
  }

  return { createClient, mapPool, ChatGPTApiError, extractUserPrompts, normalizeConversation, toMs };
});
