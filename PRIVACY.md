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
| A pause end time, the last check's reason (with the first 80 characters of that prompt), and whether ChatGPT's message box was found | `chrome.storage.local` | Shown in the popup so you can see what Recall did and why. |
| Settings (on/off, sensitivity, reminder preferences, debug logging) | `chrome.storage.sync` | So your preferences follow your Chrome profile. Contains no chat content. |

Prompts typed in ChatGPT **temporary chats** are never stored.

## What Recall sends, and to whom

Recall has **no servers** and sends **no data to its developers or any third party**. It contains no analytics,
telemetry, advertising or remote code.

When *you* choose to import your history or delete chats, Recall makes requests to ChatGPT (chatgpt.com or
chat.openai.com) from your open ChatGPT tab, using your existing signed-in session, in the same way the ChatGPT
website does. These requests go only to ChatGPT.

## The send check

To make sure every message is checked, a small script in the ChatGPT page reads the text of the message you are
sending, just before ChatGPT's own request leaves your browser, and asks Recall (on your device) whether to hold it.
It never changes the request and never sends anything anywhere else.

## Logs

Recall writes warnings to your browser's developer console only. Prompt text is never logged unless you turn on
**Debug logging** in Recall's settings, and even then it stays in your own browser's console. Logs are never sent
anywhere.

## Your controls

- **Export my data** (popup → Settings) downloads everything Recall stores as a JSON file.
- **Forget everything** (popup → Settings) deletes the stored prompt index.
- Uninstalling the extension deletes all of its stored data.

## Permissions

- `storage`: to save the data described above on your device.
- `scripting`: after an update, to re-attach Recall to ChatGPT tabs that are already open (only ChatGPT tabs).
- Host access to `https://chatgpt.com/*` and `https://chat.openai.com/*`: to run on ChatGPT, and nowhere else.

- The keyboard shortcut (`commands`, no permission prompt) only switches Recall on or off.

## Contact

Questions or concerns: open an issue at https://github.com/Anushka180712/Recall-API/issues.
