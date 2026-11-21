# Store listing (Chrome Web Store / Edge Add-ons)

Ready-to-paste text for publishing Recall. Screenshots are in [`images/`](images/) (regenerate with `npm run screenshots`).

## Name (max 75)

Recall – Already Asked That?

## Short description (max 132)

Spots when you're about to ask ChatGPT something you already asked and takes you to that chat. Plus one-click chat cleanup.

## Category

Productivity

## Detailed description

Already asked that? Recall takes you straight back to the chat where you did.

When you're about to send ChatGPT a question you already asked, Recall holds the message back and shows you the
earlier chat. One click opens it and scrolls to the exact message, so you can pick up where you left off instead
of starting over.

WHAT IT DOES
• Catches repeat questions, even re-phrased ones, and exact copies of long prompts
• "Take me there" opens the earlier chat and highlights the exact message
• Stops repeats inside the same chat too, and scrolls up to the answer
• Never gets in the way when you ask for a new answer ("again", "another one", "regenerate", "otra vez", "phir se"…), for small talk, follow-ups, attachments, time-sensitive questions or temporary chats
• Ask anyway, Not the same, Pause for 1 hour, an on/off switch and a keyboard shortcut (Alt+Shift+R)
• Bulk cleanup of stale chats: untitled, greeting-only, duplicates and long-abandoned chats, with a confirmation step and Undo
• A live tester shows exactly why Recall would or wouldn't step in
• Interface in English, Spanish, French, German, Hindi and Portuguese; matching works in any language

PRIVATE BY DESIGN
• Everything stays on your device. No servers, no analytics, no accounts, no AI service
• Temporary chats are never stored
• Export or erase your data any time

Open source (MIT): https://github.com/Anushka180712/Recall-API

Recall is an independent project and is not affiliated with OpenAI.

## Single purpose (Chrome Web Store)

Help people avoid re-asking ChatGPT questions they already asked by pointing them to the earlier chat, and help them clean up old chats.

## Permission justifications

- **storage**: saves settings and the local index of the user's own prompts, on the device.
- **scripting**: after an update, re-attaches the extension to ChatGPT tabs that are already open, so users don't have to reload them.
- **Host access to chatgpt.com and chat.openai.com**: the extension only works on ChatGPT and runs nowhere else.

## Data usage disclosures

- Collects: website content (the user's own prompts on ChatGPT), stored only locally on the device.
- Not sold, not transferred to third parties, not used for anything unrelated to the single purpose, not used for creditworthiness.
- Privacy policy: https://github.com/Anushka180712/Recall-API/blob/main/PRIVACY.md
