# Privacy Policy: Recall

_Last updated: 21 November 2026_

Recall is a browser extension that helps you avoid asking ChatGPT the same question twice and helps you clean up
old chats. It is built to work entirely on your device.

## What Recall stores

| Data | Where | Why |
|---|---|---|
| Text of prompts you sent or viewed on ChatGPT (max 400 characters each, max 5,000 prompts) and chat titles/ids | `chrome.storage.local` on your device | To recognise repeat questions. |
| Usage counters (repeats avoided, chats cleaned) | `chrome.storage.local` | Shown in the popup. |
| "Not the same" choices and chats you chose to keep | `chrome.storage.local` | So Recall respects your choices. |
| Settings (on/off, sensitivity, reminder preferences) | `chrome.storage.sync` | So your preferences follow your Chrome profile. Contains no chat content. |

Prompts typed in ChatGPT **temporary chats** are never stored.

## What Recall sends, and to whom

Recall has **no servers** and sends **no data to its developers or any third party**. It contains no analytics,
telemetry, advertising or remote code.

When *you* choose to import your history or delete chats, Recall makes requests to ChatGPT (chatgpt.com or
chat.openai.com) from your open ChatGPT tab, using your existing signed-in session, in the same way the ChatGPT
website does. These requests go only to ChatGPT.

## Your controls

- **Export my data** (popup → Settings) downloads everything Recall stores as a JSON file.
- **Forget everything** (popup → Settings) deletes the stored prompt index.
- Uninstalling the extension deletes all of its stored data.

## Permissions

- `storage`: to save the data described above on your device.
- Host access to `https://chatgpt.com/*` and `https://chat.openai.com/*`: to run on ChatGPT, and nowhere else.

## Contact

Questions or concerns: open an issue at https://github.com/Anushka180712/Recall-API/issues.
