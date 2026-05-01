# BotFather Identity Polish

One-time setup via Telegram's `@BotFather`. None of this is code — it's 5 minutes of chat commands that change how your bot looks to anyone who opens a chat with it.

## Prerequisites

- You already created the bot via `@BotFather` (you have `BOT_TOKEN`).
- You know your bot's username (e.g., `@your_jarvis_bot`).

## 1. Set a real profile photo

The default is a faceless Telegram outline. Swap it for something recognizable — a subtle AI-avatar icon, an initial "J", a monochrome logo.

1. Open a chat with `@BotFather`.
2. Send `/setuserpic`.
3. Pick your bot from the list.
4. Send the image (square, ≥ 640×640 recommended; Telegram will crop to a circle).

Bundled avatars in this repo (drop straight into `/setuserpic`):

- `assets/jarvis-avatar.png` — generic monogram "J" on navy. Safe for any use, public or private.
- `assets/avengers/jarvis.png`, `tony.png`, `natasha.png`, `bruce.png` — the four bots' Marvel-themed avatars used by the multi-bot ensemble. **IP note:** these are stylized Iron Man / Black Widow / Hulk likenesses; trademarks of Marvel/Disney. Fine for a private personal bot, NOT safe for a public-facing bot. Generate your own if you intend to publish.

If you'd rather generate your own:

- `@Designer_bot` — AI image generation inside Telegram.
- DALL·E / Midjourney / Stable Diffusion prompt: *"minimalist monogram 'J', white on deep navy, subtle glow, square, centered, vector, no outer text"*.
- Or just grab a free icon from flaticon.com and color it.

## 2. Set the about text (the short line shown in search results)

1. `@BotFather` → `/setabouttext` → pick bot.
2. Paste — max 120 chars. Suggestion:

   ```
   Boss's personal AI assistant. File system, shell, web research, email, calendar. Autonomous /research and /build workflows.
   ```

## 3. Set the description (the longer paragraph shown on first DM open)

1. `@BotFather` → `/setdescription` → pick bot.
2. Paste — max 512 chars. Suggestion:

   ```
   Jarvis — personal AI agent running on Boss's machine.

   Chat normally for one-shot tasks, or use a skill:
   • /research <topic> — multi-angle research, delivered as a report
   • /fix <issue> — diagnose and propose a fix
   • /build <thing> — design, implement, verify
   • /voice on — spoken replies
   • /help — full command list

   Add --claude (cheap) or --sonnet (deeper) to any skill.
   ```

## 4. Curate the slash-command menu

This controls the picker that pops up when you type `/` in the chat.

1. `@BotFather` → `/setcommands` → pick bot.
2. Paste the list below (format: `command - short description`, one per line, no leading slash):

```
research - Autonomous multi-step research with a report
plan - Alias for /research
fix - Diagnose a bug or issue and propose a fix
build - Build a small app, feature, or script
voice - Toggle voice replies (on / off)
vision - Toggle image-input handling
calendar - Show or toggle Google Calendar tools
debate - Adversarial debate mode (on [rounds] [exchanges])
search - Web search shortcut
compact - Manually compact conversation history
audit - Show recent audit log (admin only, DM only)
model - Show or switch the current model (admin in groups)
cost - Show session token cost
history - Show recent message history (admin in groups)
projects - List configured project paths (admin in groups)
status - Show Jarvis status (admin in groups)
clear - Clear conversation history (admin in groups)
stop - Halt any in-flight command (admin in groups)
help - Show the full command reference
```

## 5. (Optional) Set menu button to a Web App

If you later ship the Web App panel (Tier 3 from TODO), you can wire it to the persistent blue menu button visible in all chats:

1. `@BotFather` → `/setmenubutton` → pick bot.
2. Either leave as default (shows the command list) or set to a URL pointing at the hosted Web App.

## 6. Verify

Open your bot's DM, tap the bot's name at the top to open its profile:

- ✓ Profile picture is the new one.
- ✓ The "about" line shows under the username.
- ✓ The description shows when the profile expands.
- ✓ Typing `/` shows the curated command picker.

If any of these still show the old defaults, Telegram caches on the client side — try killing the app and reopening.

## What this changes

Before: *"a bot"* with a default icon and no description.
After: *"Jarvis, Boss's assistant"* — recognizable in search, self-describes on first open, the command picker reads like a product menu. Still the same code underneath; just a real face on it.
