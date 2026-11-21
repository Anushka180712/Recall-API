/*
 * Levelled, structured console logging.
 *
 *   const log = Recall.log.create('content');
 *   log.info('import done', { prompts: 120, chats: 40 });
 *   // -> [Recall:content] import done {prompts: 120, chats: 40}
 *
 * Levels: debug < info < warn < error. By default only warnings and errors
 * are printed, so the ChatGPT console stays quiet. Turning on "Debug logging"
 * in Recall's settings switches every logger to `debug`.
 *
 * Privacy: prompt text is never printed unless debug is on. Pass prompts
 * through `log.text(prompt)`, which returns a redacted stand-in such as
 * "<prompt: 42 chars>" when debug is off.
 *
 * The last 200 entries are kept in memory (`Recall.log.recent()`), which is
 * handy when reporting a bug: run it in the console and copy the output.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecallDefine('log', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 99 });
  const RING_SIZE = 200;

  let threshold = LEVELS.warn;
  let sink = typeof console !== 'undefined' ? console : null;
  const ring = [];

  /** Set the global level by name ('debug' | 'info' | 'warn' | 'error' | 'silent'). */
  function setLevel(name) {
    if (name in LEVELS) threshold = LEVELS[name];
  }

  function getLevel() {
    return Object.keys(LEVELS).find((k) => LEVELS[k] === threshold);
  }

  /** Apply the user's settings: `debug: true` means everything, otherwise warnings and up. */
  function configure(settings) {
    setLevel(settings && settings.debug ? 'debug' : 'warn');
  }

  /** Replace the console (tests). */
  function setSink(next) {
    sink = next;
  }

  /** Prompt text only when debugging; otherwise just its length. */
  function text(value) {
    const s = String(value == null ? '' : value);
    return threshold <= LEVELS.debug ? s : `<prompt: ${s.length} chars>`;
  }

  function create(scope) {
    const tag = `[Recall:${scope}]`;
    const emit = (level, msg, data) => {
      const entry = { at: Date.now(), level, scope, msg, ...(data !== undefined ? { data } : {}) };
      ring.push(entry);
      if (ring.length > RING_SIZE) ring.shift();
      if (LEVELS[level] < threshold || !sink) return;
      const fn = sink[level] || sink.log;
      if (data === undefined) fn.call(sink, tag, msg);
      else fn.call(sink, tag, msg, data);
    };
    return {
      debug: (msg, data) => emit('debug', msg, data),
      info: (msg, data) => emit('info', msg, data),
      warn: (msg, data) => emit('warn', msg, data),
      error: (msg, data) => emit('error', msg, data),
      text,
    };
  }

  /** Recent entries, newest last. Prompt text appears only if it was logged while debugging. */
  function recent() {
    return ring.slice();
  }

  return { LEVELS, create, configure, setLevel, getLevel, setSink, text, recent };
});
