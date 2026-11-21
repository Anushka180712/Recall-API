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
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extraHeaders(), ...(init.headers || {}) },
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
      if (!res.ok) throw new ChatGPTApiError(friendlyError(res.status), res.status);
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
      const messages = extractUserMessages(data);
      return { id, title: data.title || '', prompts: messages.map((m) => m.text), messages };
    }

    /** Hides the chat exactly like the web app's own "Delete" menu item does. */
    async function deleteConversation(id) {
      try {
        await setVisible(id, false);
      } catch (err) {
        if (err.status === 404) return true; // already gone: that's what we wanted
        throw err;
      }
      return true;
    }

    /**
     * Undo for a delete. ChatGPT's "delete" only hides a chat (is_visible:false),
     * so setting it visible again brings it back, for as long as ChatGPT keeps
     * hidden chats around. Recall only offers this right after a delete.
     */
    async function restoreConversation(id) {
      await setVisible(id, true);
      return true;
    }

    function setVisible(id, visible) {
      return request(`/backend-api/conversation/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_visible: visible }),
      });
    }

    /** Runs `fn` over ids a few at a time; one failure never aborts the rest. */
    async function each(ids, fn, onProgress) {
      const ok = [];
      const failed = [];
      let done = 0;
      const outcomes = await mapPool(ids, Math.min(concurrency, 3), async (id) => {
        let res;
        try {
          await fn(id);
          res = true;
        } catch (err) {
          res = err.message;
        }
        if (onProgress) onProgress(++done, ids.length);
        return res;
      });
      outcomes.forEach((res, i) => (res === true ? ok.push(ids[i]) : failed.push({ id: ids[i], error: res })));
      return { ok, failed };
    }

    /** @returns {Promise<{deleted: string[], failed: {id: string, error: string}[]}>} */
    async function deleteMany(ids, { onProgress } = {}) {
      const { ok, failed } = await each(ids, deleteConversation, onProgress);
      return { deleted: ok, failed };
    }

    /** @returns {Promise<{restored: string[], failed: {id: string, error: string}[]}>} */
    async function restoreMany(ids, { onProgress } = {}) {
      const { ok, failed } = await each(ids, restoreConversation, onProgress);
      return { restored: ok, failed };
    }

    return { listConversations, getConversation, getConversations, deleteConversation, deleteMany, restoreConversation, restoreMany, getAccessToken };
  }

  /** Headers the ChatGPT web app itself sends; some endpoints reject requests without them. */
  function extraHeaders() {
    const out = {};
    try {
      const m = typeof document !== 'undefined' && document.cookie.match(/(?:^|;\s*)oai-did=([^;]+)/);
      if (m) out['oai-device-id'] = decodeURIComponent(m[1]);
      if (typeof navigator !== 'undefined' && navigator.language) out['oai-language'] = navigator.language;
    } catch {
      /* not in a page */
    }
    return out;
  }

  function friendlyError(status) {
    if (status === 401) return 'You seem to be signed out of ChatGPT (401). Sign in and try again.';
    if (status === 403) return 'ChatGPT refused the request (403). Reload the ChatGPT page and try again.';
    if (status === 404) return 'Not found (404); it may already be deleted.';
    if (status === 429) return 'ChatGPT is rate-limiting requests (429). Wait a minute and try again.';
    if (status >= 500) return `ChatGPT had a server error (${status}). Try again shortly.`;
    return `Request failed (${status}).`;
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

  /**
   * User-authored text messages from a conversation payload, oldest first,
   * with ChatGPT's own message ids (the page renders them as data-message-id,
   * which is how "Take me there" finds the exact message).
   * @returns {{id: string|null, text: string}[]}
   */
  function extractUserMessages(data) {
    const nodes = Object.entries((data && data.mapping) || {});
    return nodes
      .map(([key, n]) => n && n.message && { ...n.message, id: n.message.id || key })
      .filter((m) => m && m.author && m.author.role === 'user' && m.content)
      .filter((m) => !m.metadata || !m.metadata.is_visually_hidden_from_conversation)
      .sort((a, b) => (a.create_time || 0) - (b.create_time || 0))
      .map((m) => ({ id: m.id || null, text: (m.content.parts || []).filter((p) => typeof p === 'string').join('\n').trim() }))
      .filter((m) => m.text);
  }

  /** Just the text of the user's messages, oldest first. */
  function extractUserPrompts(data) {
    return extractUserMessages(data).map((m) => m.text);
  }

  return { createClient, mapPool, ChatGPTApiError, extractUserPrompts, extractUserMessages, normalizeConversation, toMs };
});
