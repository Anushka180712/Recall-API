/*
 * Recall's on-page UI: the redirect dialog, the cleanup panel, toasts and the
 * floating launcher. Rendered inside a closed-over Shadow DOM so ChatGPT's CSS
 * can't break it and ours can't leak into the page.
 *
 * All text is inserted with textContent (never innerHTML), so prompts and chat
 * titles can't inject markup.
 */
(function (root) {
  'use strict';

  const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .layer { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;
    font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --bg: #ffffff; --fg: #18181b; --muted: #6b7280; --line: #e5e7eb; --soft: #f4f4f5;
    --accent: #4f46e5; --accent-fg: #ffffff; --accent-soft: #eef2ff; --danger: #dc2626; --ok: #059669;
    --shadow: 0 24px 60px rgba(15, 23, 42, .25); color: var(--fg); }
  @media (prefers-color-scheme: dark) {
    .layer { --bg: #1f1f23; --fg: #f4f4f5; --muted: #a1a1aa; --line: #34343a; --soft: #2a2a30;
      --accent: #818cf8; --accent-fg: #111827; --accent-soft: #2b2d4a; --danger: #f87171; --ok: #34d399;
      --shadow: 0 24px 60px rgba(0, 0, 0, .6); }
  }
  .backdrop { position: absolute; inset: 0; background: rgba(15, 23, 42, .45); pointer-events: auto;
    display: flex; align-items: center; justify-content: center; padding: 16px; animation: fade .12s ease-out; }
  .card { width: min(560px, 100%); max-height: min(86vh, 760px); overflow: auto; background: var(--bg);
    border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); padding: 20px 20px 16px;
    animation: pop .16s ease-out; outline: none; }
  .card.wide { width: min(720px, 100%); }
  .brand { display: flex; align-items: center; gap: 8px; color: var(--accent); font-weight: 700; font-size: 12px;
    letter-spacing: .06em; text-transform: uppercase; }
  .brand svg { width: 18px; height: 18px; }
  h2 { margin: 6px 0 4px; font-size: 18px; line-height: 1.3; }
  p { margin: 0 0 12px; color: var(--muted); }
  .you { background: var(--soft); border-radius: 10px; padding: 8px 12px; margin: 0 0 14px; font-size: 13px;
    color: var(--fg); white-space: pre-wrap; word-break: break-word; max-height: 90px; overflow: auto; }
  .matches { list-style: none; margin: 0 0 14px; padding: 0; display: grid; gap: 8px; }
  .match { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; display: grid;
    grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center; }
  .match:first-child { border-color: var(--accent); background: var(--accent-soft); }
  .match .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .match .prompt { grid-column: 1 / 2; color: var(--muted); font-size: 13px; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .match .meta { color: var(--muted); font-size: 12px; }
  .match .side { grid-row: 1 / 4; grid-column: 2; display: grid; gap: 6px; justify-items: end; }
  .pct { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 13px; color: var(--accent); }
  .row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; }
  .row.split { justify-content: space-between; }
  button { font: inherit; cursor: pointer; border-radius: 10px; border: 1px solid var(--line); background: var(--bg);
    color: var(--fg); padding: 8px 14px; font-weight: 600; transition: filter .1s, background .1s; }
  button:hover { filter: brightness(.97); background: var(--soft); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  button.primary:hover { background: var(--accent); filter: brightness(1.08); }
  button.danger { background: var(--danger); color: #fff; border-color: var(--danger); }
  button.link { border: none; background: none; padding: 4px 6px; color: var(--muted); font-weight: 500; }
  button.small { padding: 5px 10px; font-size: 12px; }
  button:disabled { opacity: .5; cursor: default; }
  kbd { font: 11px ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px;
    padding: 0 4px; color: var(--muted); }
  .hint { font-size: 12px; color: var(--muted); margin-top: 10px; }
  .list { list-style: none; margin: 8px 0 12px; padding: 0; border: 1px solid var(--line); border-radius: 12px;
    max-height: 48vh; overflow: auto; }
  .list li { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: start; padding: 10px 12px;
    border-top: 1px solid var(--line); }
  .list li:first-child { border-top: none; }
  .list input { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--accent); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .chip { font-size: 11px; border-radius: 999px; padding: 1px 8px; background: var(--soft); color: var(--muted); }
  .empty, .status { text-align: center; color: var(--muted); padding: 24px 8px; }
  .bar { height: 6px; border-radius: 99px; background: var(--soft); overflow: hidden; margin: 8px 0; }
  .bar > i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .2s; }
  .confirm { border: 1px solid var(--danger); border-radius: 12px; padding: 12px; margin-bottom: 12px; }
  .confirm strong { color: var(--danger); }
  .card:has(.confirm) .list { max-height: 26vh; }
  .ok { color: var(--ok); } .err { color: var(--danger); }
  .toast { position: absolute; right: 20px; bottom: 96px; width: min(380px, calc(100% - 40px)); pointer-events: auto;
    background: var(--bg); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow);
    padding: 14px; animation: pop .16s ease-out; }
  .toast p { color: var(--fg); margin-bottom: 10px; }
  .launcher { position: absolute; right: 18px; bottom: 140px; pointer-events: auto; width: 40px; height: 40px;
    padding: 0; border-radius: 50%; display: grid; place-items: center; background: var(--accent);
    color: var(--accent-fg); border: none; box-shadow: 0 6px 18px rgba(79, 70, 229, .35); opacity: .85; }
  .launcher:hover { opacity: 1; background: var(--accent); }
  .launcher svg { width: 20px; height: 20px; }
  a { color: var(--accent); }
  @keyframes fade { from { opacity: 0; } }
  @keyframes pop { from { opacity: 0; transform: translateY(6px) scale(.98); } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  `;

  const LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/></svg>';

  /** Minimal hyperscript helper. Children may be strings (inserted as text) or nodes. */
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v; // only ever used with the static LOGO constant
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
  }

  function relTime(ms) {
    if (!ms) return '';
    const d = Math.round((Date.now() - ms) / 86400000);
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 30) return `${d} days ago`;
    const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    if (d < 365) return plural(Math.max(1, Math.round(d / 30)), 'month');
    return plural(Math.round(d / 365), 'year');
  }

  class Overlay {
    constructor() {
      this.host = document.createElement('recall-overlay');
      this.host.setAttribute('data-recall', '');
      this.shadow = this.host.attachShadow({ mode: 'open' });
      this.shadow.append(h('style', {}, STYLE));
      this.layer = h('div', { class: 'layer' });
      this.shadow.append(this.layer);
      this.modal = null;
      this.toastEl = null;
      this.launcherEl = null;
      this.lastFocus = null;
      this.onKey = this.onKey.bind(this);
    }

    mount() {
      if (!this.host.isConnected) (document.body || document.documentElement).append(this.host);
      return this;
    }

    get isOpen() {
      return !!this.modal;
    }

    // ---------------------------------------------------------------- modal
    openModal(card, keymap = {}) {
      this.closeModal();
      this.mount();
      this.lastFocus = document.activeElement;
      this.keymap = keymap;
      const backdrop = h('div', {
        class: 'backdrop',
        onmousedown: (e) => {
          if (e.target === backdrop && keymap.Escape) keymap.Escape();
        },
      }, card);
      this.layer.append(backdrop);
      this.modal = backdrop;
      document.addEventListener('keydown', this.onKey, true);
      setTimeout(() => card.focus(), 0);
    }

    closeModal() {
      if (!this.modal) return;
      this.modal.remove();
      this.modal = null;
      document.removeEventListener('keydown', this.onKey, true);
      if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus();
    }

    onKey(e) {
      if (!this.modal) return;
      // Keep keystrokes away from ChatGPT's composer while our dialog is open.
      const inside = e.composedPath().includes(this.host);
      const fn = this.keymap[e.key] || (!e.ctrlKey && !e.metaKey && !e.altKey && this.keymap[e.key.toLowerCase()]);
      const typing = inside && e.composedPath()[0] && /INPUT|TEXTAREA/.test(e.composedPath()[0].tagName);
      if (fn && !typing && !e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        fn();
      } else if (!inside) {
        e.stopPropagation();
        if (e.key !== 'Tab') e.preventDefault();
      }
    }

    // ------------------------------------------------------------- redirect
    /**
     * @param {object} o
     * @param {string} o.prompt
     * @param {Array} o.matches from HistoryIndex.search
     * @param {(match) => void} o.onOpen
     * @param {() => void} o.onAskAnyway
     * @param {(match) => void} o.onNotHelpful
     * @param {() => void} o.onCancel
     */
    showRedirect(o) {
      const done = (fn, arg) => () => {
        this.closeModal();
        fn && fn(arg);
      };
      const top = o.matches[0];
      const items = o.matches.map((m, i) =>
        h('li', { class: 'match', 'data-testid': 'recall-match' },
          h('div', { class: 'title' }, m.title || 'Earlier chat'),
          h('div', { class: 'prompt' }, m.source === 'title' ? 'The chat’s title matches your question' : `You asked: “${m.prompt}”`),
          h('div', { class: 'meta' }, relTime(m.createdAt)),
          h('div', { class: 'side' },
            h('span', { class: 'pct', title: 'Similarity' }, `${Math.round(m.score * 100)}% match`),
            h('button', {
              class: i === 0 ? 'primary small' : 'small',
              'data-testid': i === 0 ? 'recall-open' : 'recall-open-alt',
              onclick: done(o.onOpen, m),
            }, 'Open chat'),
            h('button', { class: 'link small', 'data-testid': 'recall-not-helpful', onclick: done(o.onNotHelpful, m), title: 'Don’t suggest this chat for this question again' }, 'Not the same')
          )
        )
      );

      const card = h('div', { class: 'card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'recall-title', tabindex: '-1', 'data-testid': 'recall-dialog' },
        h('div', { class: 'brand', html: LOGO }, 'Recall'),
        h('h2', { id: 'recall-title' }, o.matches.length > 1 ? 'You’ve asked this before' : 'You already asked this'),
        h('p', {}, 'Jump back to the earlier answer instead of starting over, or ask again for a new one.'),
        h('div', { class: 'you' }, o.prompt),
        h('ul', { class: 'matches' }, items),
        h('div', { class: 'row split' },
          h('button', { class: 'link', onclick: done(o.onCancel), 'data-testid': 'recall-cancel' }, 'Keep editing'),
          h('div', { class: 'row' },
            h('button', { onclick: done(o.onAskAnyway), 'data-testid': 'recall-ask-anyway' }, 'Ask anyway'),
            h('button', { class: 'primary', onclick: done(o.onOpen, top), 'data-testid': 'recall-open-top' }, 'Take me there')
          )
        ),
        h('div', { class: 'hint' }, h('kbd', {}, 'O'), ' open  ·  ', h('kbd', {}, 'A'), ' ask anyway  ·  ', h('kbd', {}, 'Esc'), ' keep editing')
      );

      this.openModal(card, { o: done(o.onOpen, top), a: done(o.onAskAnyway), Escape: done(o.onCancel) });
    }

    // -------------------------------------------------------------- cleanup
    /**
     * @param {object} o
     * @param {() => Promise<{suggestions: Array, canDelete: boolean, note?: string}>} o.load
     * @param {(ids: string[], onProgress) => Promise<{deleted: string[], failed: Array}>} o.onDelete
     * @param {(ids: string[]) => void} o.onKeep
     * @param {(id: string) => string} o.urlFor
     */
    async showCleanup(o) {
      const body = h('div', {}, h('div', { class: 'status' }, 'Looking through your chats…'));
      const card = h('div', { class: 'card wide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'recall-clean-title', tabindex: '-1', 'data-testid': 'recall-cleanup' },
        h('div', { class: 'brand', html: LOGO }, 'Recall · Cleanup'),
        h('h2', { id: 'recall-clean-title' }, 'Tidy up your chat list'),
        body
      );
      const close = () => this.closeModal();
      this.openModal(card, { Escape: close });

      let data;
      try {
        data = await o.load();
      } catch (err) {
        body.replaceChildren(h('div', { class: 'status err' }, `Couldn’t load your chats: ${err.message}`), h('div', { class: 'row' }, h('button', { onclick: close }, 'Close')));
        return;
      }
      if (!this.modal) return;

      const { suggestions, canDelete, note } = data;
      if (!suggestions.length) {
        body.replaceChildren(h('div', { class: 'empty', 'data-testid': 'recall-clean-empty' }, 'Nothing to clean up. Your chat list looks tidy ✨'), h('div', { class: 'row' }, h('button', { class: 'primary', onclick: close }, 'Done')));
        return;
      }

      const boxes = new Map();
      const count = h('strong', {}, '');
      const deleteBtn = h('button', { class: 'danger', 'data-testid': 'recall-delete' }, '');
      const keepBtn = h('button', { 'data-testid': 'recall-keep' }, 'Keep selected');
      const refresh = () => {
        const n = [...boxes.values()].filter((b) => b.checked).length;
        count.textContent = `${n} of ${suggestions.length} selected`;
        deleteBtn.textContent = n ? `Delete ${n} chat${n === 1 ? '' : 's'}…` : 'Delete…';
        deleteBtn.disabled = !n || !canDelete;
        keepBtn.disabled = !n;
      };

      const rows = suggestions.map((s) => {
        const cb = h('input', { type: 'checkbox', 'aria-label': `Select ${s.title}`, 'data-id': s.id });
        cb.checked = s.preselected;
        cb.addEventListener('change', refresh);
        boxes.set(s.id, cb);
        return h('li', { 'data-testid': 'recall-suggestion' },
          cb,
          h('div', {},
            h('div', {}, h('a', { href: o.urlFor(s.id), target: '_blank', rel: 'noopener' }, s.title)),
            h('div', { class: 'chips' }, s.reasons.map((r) => h('span', { class: 'chip', title: r.detail || '' }, r.detail ? `${r.label} · ${r.detail}` : r.label)))
          ),
          h('span', { class: 'meta', style: 'color:var(--muted);font-size:12px' }, relTime(s.updatedAt))
        );
      });

      const setAll = (v) => {
        for (const b of boxes.values()) b.checked = v;
        refresh();
      };
      const selected = () => [...boxes].filter(([, b]) => b.checked).map(([id]) => id);

      keepBtn.addEventListener('click', () => {
        const ids = selected();
        o.onKeep(ids);
        for (const id of ids) {
          boxes.get(id).closest('li').remove();
          boxes.delete(id);
        }
        if (!boxes.size) close();
        refresh();
      });

      deleteBtn.addEventListener('click', () => {
        const ids = selected();
        const open = body.querySelector('.confirm');
        if (open) open.remove(); // never stack two confirmations
        const confirmBox = h('div', { class: 'confirm', role: 'alertdialog', 'data-testid': 'recall-confirm' },
          h('div', {}, h('strong', {}, `Delete ${ids.length} chat${ids.length === 1 ? '' : 's'} from ChatGPT?`)),
          h('p', { style: 'margin:6px 0 10px' }, 'They disappear from your history on every device. Recall can’t bring them back.'),
          h('div', { class: 'row' },
            h('button', { onclick: () => confirmBox.remove(), 'data-testid': 'recall-confirm-cancel' }, 'Cancel'),
            h('button', { class: 'danger', 'data-testid': 'recall-confirm-delete', onclick: () => run(ids, confirmBox) }, `Yes, delete ${ids.length}`)
          )
        );
        footer.before(confirmBox);
        confirmBox.querySelector('[data-testid="recall-confirm-cancel"]').focus();
      });

      const run = async (ids, confirmBox) => {
        confirmBox.remove();
        const bar = h('i');
        const status = h('div', { class: 'status', 'data-testid': 'recall-progress' }, `Deleting 0 / ${ids.length}…`);
        body.replaceChildren(h('div', { class: 'bar' }, bar), status);
        const res = await o.onDelete(ids, (done, total) => {
          bar.style.width = `${Math.round((done / total) * 100)}%`;
          status.textContent = `Deleting ${done} / ${total}…`;
        });
        const msg = [h('div', { class: 'ok', 'data-testid': 'recall-delete-result' }, `Deleted ${res.deleted.length} chat${res.deleted.length === 1 ? '' : 's'}.`)];
        if (res.failed.length) {
          msg.push(h('div', { class: 'err' }, `${res.failed.length} couldn’t be deleted. You can open them and delete them by hand:`));
          msg.push(h('ul', { class: 'list' }, res.failed.map((f) => h('li', { style: 'display:block' }, h('a', { href: o.urlFor(f.id), target: '_blank', rel: 'noopener' }, f.id)))));
        }
        status.replaceChildren(...msg);
        body.append(h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => { close(); if (res.deleted.length) o.onFinished && o.onFinished(res); } }, 'Done')));
      };

      const footer = h('div', { class: 'row split' },
        h('div', { class: 'row' },
          h('button', { class: 'link small', onclick: () => setAll(true), 'data-testid': 'recall-select-all' }, 'Select all'),
          h('button', { class: 'link small', onclick: () => setAll(false) }, 'Select none'),
          count
        ),
        h('div', { class: 'row' }, h('button', { class: 'link', onclick: close }, 'Close'), keepBtn, deleteBtn)
      );

      body.replaceChildren(
        h('p', {}, `Recall found ${suggestions.length} chat${suggestions.length === 1 ? '' : 's'} you probably don’t need. Review, untick anything you want to keep, then delete in one go.`),
        note ? h('p', { class: 'err' }, note) : '',
        h('ul', { class: 'list' }, rows),
        footer
      );
      refresh();
    }

    // ---------------------------------------------------------------- toast
    toast(message, actions = [], { timeout = 0, testid = 'recall-toast' } = {}) {
      this.mount();
      if (this.toastEl) this.toastEl.remove();
      const el = h('div', { class: 'toast', role: 'status', 'data-testid': testid },
        h('div', { class: 'brand', html: LOGO }, 'Recall'),
        h('p', {}, message),
        actions.length
          ? h('div', { class: 'row' }, actions.map((a) => h('button', { class: a.primary ? 'primary small' : 'small', onclick: () => { el.remove(); a.onClick && a.onClick(); } }, a.label)))
          : ''
      );
      this.layer.append(el);
      this.toastEl = el;
      if (timeout) setTimeout(() => el.remove(), timeout);
      return el;
    }

    /**
     * A quiet progress toast that updates in place (no re-animation) and can be
     * hidden while the work carries on in the background.
     * @returns {{update(msg: string, fraction?: number): void, done(msg: string): void, hidden: boolean}}
     */
    progress(message, { testid = 'recall-progress-toast', onHide } = {}) {
      this.mount();
      if (this.toastEl) this.toastEl.remove();
      const text = h('p', {}, message);
      const fill = h('i');
      const handle = { hidden: false };
      const hide = h('button', { class: 'small', 'data-testid': `${testid}-hide`, onclick: () => {
        handle.hidden = true;
        el.remove();
        onHide && onHide();
      } }, 'Hide');
      const el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite', 'data-testid': testid },
        h('div', { class: 'brand', html: LOGO }, 'Recall'),
        text,
        h('div', { class: 'bar' }, fill),
        h('div', { class: 'row' }, hide)
      );
      this.layer.append(el);
      this.toastEl = el;
      handle.update = (msg, fraction) => {
        if (handle.hidden) return;
        text.textContent = msg;
        if (fraction != null) fill.style.width = `${Math.round(fraction * 100)}%`;
      };
      handle.done = (msg, timeout = 6000) => {
        if (handle.hidden) return;
        text.textContent = msg;
        fill.style.width = '100%';
        hide.textContent = 'Close';
        setTimeout(() => el.remove(), timeout);
      };
      return handle;
    }

    // ------------------------------------------------------------- launcher
    setLauncher(visible, onClick) {
      this.mount();
      if (!visible) {
        if (this.launcherEl) this.launcherEl.remove();
        this.launcherEl = null;
        return;
      }
      if (this.launcherEl) return;
      this.launcherEl = h('button', { class: 'launcher', title: 'Recall: clean up chats', 'aria-label': 'Recall: clean up chats', 'data-testid': 'recall-launcher', onclick: onClick, html: LOGO });
      this.layer.append(this.launcherEl);
    }
  }

  root.RecallOverlay = Overlay;
})(globalThis);
