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
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetch]
   * @param {string} [opts.origin] e.g. "https://chatgpt.com"
   * @param {number} [opts.delayMs] pause between sequential requests (be polite)
   */
  function createClient({ fetch: fetchImpl = globalThis.fetch, origin = '', delayMs = 350 } = {}) {
    let token = null;

    async function request(path, init = {}, retry = true) {
      if (!token) token = await getAccessToken();
      const res = await fetchImpl(origin + path, {
        credentials: 'include',
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
      });
      if (res.status === 401 && retry) {
        token = null; // token expired: fetch a fresh one once
        return request(path, init, false);
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
    async function listConversations({ limit = 300, pageSize = 50, onProgress } = {}) {
      const out = [];
      for (let offset = 0; out.length < limit; offset += pageSize) {
        const page = await request(`/backend-api/conversations?offset=${offset}&limit=${pageSize}&order=updated`);
        const items = (page && page.items) || [];
        for (const it of items) out.push(normalizeConversation(it));
        if (onProgress) onProgress(out.length, Math.min(limit, page.total ?? out.length));
        if (items.length < pageSize || (page.total != null && out.length >= page.total)) break;
        await sleep(delayMs);
      }
      return out.slice(0, limit);
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
     * Deletes sequentially and reports per-chat results; one failure never
     * aborts the rest.
     */
    async function deleteMany(ids, { onProgress } = {}) {
      const results = { deleted: [], failed: [] };
      for (let i = 0; i < ids.length; i++) {
        try {
          await deleteConversation(ids[i]);
          results.deleted.push(ids[i]);
        } catch (err) {
          results.failed.push({ id: ids[i], error: err.message });
        }
        if (onProgress) onProgress(i + 1, ids.length);
        if (i < ids.length - 1) await sleep(delayMs);
      }
      return results;
    }

    return { listConversations, getConversation, deleteConversation, deleteMany, getAccessToken };
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

  return { createClient, ChatGPTApiError, extractUserPrompts, normalizeConversation, toMs };
});
