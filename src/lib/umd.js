/*
 * Tiny module shim shared by every file in src/lib.
 *
 * Library files must run in three places without a bundler:
 *   1. Chrome content scripts (classic scripts, no `import`),
 *   2. the extension popup (plain <script> tags),
 *   3. Node's test runner (CommonJS `require`).
 *
 * Each library calls `RecallDefine(name, deps, factory)`. In Node the module is
 * exported through `module.exports`; in the browser it is attached to
 * `globalThis.Recall[name]`.
 */
(function (root) {
  'use strict';
  if (root.RecallDefine) return;

  root.Recall = root.Recall || {};

  root.RecallDefine = function RecallDefine(name, deps, factory) {
    const resolved = deps.map((dep) => {
      const mod = root.Recall[dep];
      if (!mod) throw new Error(`Recall module "${name}" needs "${dep}" loaded first`);
      return mod;
    });
    root.Recall[name] = factory(...resolved);
    return root.Recall[name];
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
