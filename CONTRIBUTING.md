# Contributing to Recall

Thanks for helping out! A few guidelines keep the project easy to review and safe to install.

## Ground rules

- **Privacy first.** No new network destinations, analytics, or remote code. Data stays in `chrome.storage`.
- **No runtime dependencies, no build step.** `src/` must stay loadable as-is via *Load unpacked*.
- **Fail open.** If something unexpected happens, let the user's message through.
- **Keep ChatGPT-specific knowledge in one place:** selectors in `src/content/dom.js`, endpoints in
  `src/lib/chatgptApi.js`.

## Workflow

```bash
npm ci
npm run lint && npm test          # must pass
npm run test:e2e                  # for anything touching src/content or src/popup
```

- Changing when Recall redirects? Update `src/lib/policy.js`, add a case to `tests/unit/policy.test.js`, and
  update the table in the README's *When does Recall step in?* section. The three must agree.
- Changing the UI? Run `npm run screenshots` and commit the updated images.
- Use clear, imperative commit messages ("Add Firefox manifest", "Fix send hook on new composer").
