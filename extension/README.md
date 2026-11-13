# Fiverr Telegram Alerts (Chrome extension)

Sends a Telegram message when a new Fiverr inbox message arrives. Manifest V3,
built with WXT + React + TypeScript. Each user brings their own bot. One user
can run it in several Chrome profiles (one Fiverr account per profile), all
on the same bot, through the relay `fta-relay` (protocol: the root README on
the relay branch).

The extension only **reads** Fiverr pages, and only navigates or reloads its
own watch tab. It never types, clicks or submits anything on Fiverr, and it
sends only text to Telegram.

## Load it in Chrome

```bash
cd extension
```

```bash
npm install
```

```bash
npm run build
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick `extension/.output/chrome-mv3`.
4. Pin the extension and open its popup. Click **Start setup**.
5. In Telegram, create a bot with @BotFather (`/newbot`). Paste the token in step 1.
6. Step 2: keep the default relay URL and click **Connect relay**.
7. Step 3: click **Open @yourbot** and send `/start`. The card turns to Done and
   the bot replies "Linked".
8. Step 4: type the account label, **Save**, then **Send test alert**.
9. Log in to Fiverr in this profile. The extension opens a pinned
   `fiverr.com/inbox` tab (the watch tab).

For a second Fiverr account, repeat in another Chrome profile with the same
bot token. Only the profile that is waiting at step 3 replies "Linked".

`npm run dev` starts Chrome with the extension and reloads it on change.
After `npm run build`, click the reload icon on `chrome://extensions`, then
reload open Fiverr tabs (old content scripts stop when the extension reloads).

## What I need you to capture

Four areas have placeholder selectors in `src/lib/selectors.ts` because there
is no real HTML sample yet. Until they are filled in, the related features
answer "selector … is not set up" instead of guessing. Alerts from toasts do
not depend on any of them.

Turn on **Settings → Debug mode**. The popup then shows **Debug capture**.
For each item: open the page, open the popup, press **Capture**, and click the
area on the page. `↑` selects the parent element, `↓` goes back, `Enter`
captures, `Esc` cancels. Your click goes to the picker, not to Fiverr. The
HTML is copied to the clipboard and also saved, so **Copy** in the popup gives
it again.

| Capture | Page | What to click | Fills |
| --- | --- | --- | --- |
| Unread badge | Any Fiverr page with at least 1 unread message | The number on the inbox (envelope) icon in the top bar | `INBOX.unreadBadge` |
| Inbox list | `fiverr.com/inbox` with 1 or more unread conversations **and** 1 or more read ones | One row, then `↑` until the outline covers the whole list | `INBOX.unreadRow`, `INBOX.rowName` |
| Conversation messages | `fiverr.com/inbox/<buyer>` with messages from both sides, at least one file or image, and one text + file message | One message, then `↑` until the outline covers the thread | `CONVERSATION.*` |
| Account menu | Any Fiverr page, logged in | Your avatar or username in the top bar | `HEADER.loggedInUsername` (default account label) |

Also tell me: does the unread badge disappear at 0 unread, or show "0"? The
code assumes it disappears (`src/content/reader.ts`, marked TODO).

The captures contain buyer names and message text. Remove anything you do not
want to share before you paste it.

## How it works, and why

**Alerts go straight to Telegram, not through the relay.** The content script
parses the toast, the background worker calls `api.telegram.org` itself. The
relay is only the return path (buttons and commands). So if the relay is down,
the popup shows a warning and alerts keep arriving; only the buttons stop.

**The token never leaves `chrome.storage.local` except to Telegram.** The relay
gets `botKey = SHA-256("fta-key:"+token)` and `secret = SHA-256("fta-secret:"+token)`.
Both are one-way, so the relay can tell bots apart and check the webhook
secret, but cannot call the Bot API. The Telegram client (`src/lib/telegram.ts`)
has no file or photo method at all, so "text only" holds by construction.

**Connect the WebSocket first, then `setWebhook`.** The relay trusts the first
secret it sees on a WebSocket (trust on first use) and answers 401 to webhooks
until then. Registering the webhook first would make Telegram retry into 401s.
The end-to-end test checks exactly this order.

**Toast detection observes two levels.** `ul.realtime-notifications` may not
exist at load, so a body observer waits for it; it costs one `isConnected`
check per mutation batch once the container is found. The container observer
uses `childList + subtree + characterData`, so a reused `<li>` whose text
changes is parsed again. Reads wait 150 ms after the last change so React has
finished rendering. A per-`<li>` signature stops re-renders from resending.

**Selectors avoid hashed classes.** Everything keys off semantic classes
(`toast`, `display-name`, `content`), the `data-testid="inbox_…"` prefix and
the `/conversations/` href, which survive Fiverr rebuilds. All selectors live
in `selectors.ts`, so a Fiverr change is a one-file fix.

**Body parsing tolerates the `<p><div>` nesting.** The live DOM has a `<div>`
inside `<p class="content">`. If that markup is ever parsed from HTML text,
the browser closes the `<p>` early and the text moves next to the div. The
parser handles both shapes (both are tested).

**Dedupe: same account + conversation + body within 20 s.** Several Fiverr
tabs show the same toast at once; they collapse into one alert. The window is
short, so a buyer who sends "ok?" again ten minutes later still alerts you. The
check and the record happen in one synchronous step, so two tabs reporting in
the same tick cannot both pass. If the send fails, the key is released so a
copy from another tab can retry.

**Updates are acked before work starts.** The relay holds at most 50 updates
per bot; a "Full message" read can take 20 s. The extension also keeps the last
200 `update_id`s in storage, because the relay can replay an update that was
delivered but not acked before a disconnect.

**Keep-alive with the plain-text `ping`.** The relay runtime answers it
without waking the Durable Object (no cost), and WebSocket traffic every 20 s
keeps the MV3 service worker alive. If Chrome stops the worker anyway, a
one-minute `chrome.alarms` alarm reconnects with backoff (3 s, 1, 2, 5, 10 min;
30 min after "wrong secret", 5 min after "replaced by another profile").

**`callback_data` carries the account: `c|{accountId}|{action}|{arg}`.** The
relay routes a press to the profile that claimed the message, or, without a
claim, to the accountId in the data. So buttons work even for alerts sent
while the relay was down (their claims are queued and sent on reconnect). A
broadcast press (`routed:false`) for another accountId is ignored.

**The watch tab is the only tab the extension touches.** One pinned, non-discardable
`/inbox` tab keeps a Fiverr page open for toasts, and all reloads and reads go
through a single queue, so a scheduled reload cannot interrupt a "Full
message" read. The reload time is random in 25–35 min (configurable) to avoid
a fixed pattern. Its tab id is kept in `storage.session`, because tab ids are
reused after a browser restart; on restart the extension adopts a restored
pinned `/inbox` tab instead of adding another one each time. If you close it,
it comes back (setting), but at most 3 times a minute.

**Linking.** `/start` goes to every profile. Each profile without a chat saves
it, but only the one whose options page is waiting at step 3 (15 min window)
replies "Linked", so you get one reply. After that, updates from any other chat
are ignored.

**Multi-account replies.** `/check` and `/status` go to every profile, and each
answers for itself. For `/status`, the online profile with the smallest
accountId (from the relay's presence frames) also lists offline profiles, so
they appear exactly once.

## Files

```
src/lib/selectors.ts        all Fiverr selectors (placeholders marked TODO)
src/lib/toast.ts            toast parser + attachment / empty-body rule
src/lib/dedupe.ts           20 s dedupe, last-200 update ids
src/lib/callback.ts         callback_data format
src/lib/telegram.ts         Bot API client (text only), retries with backoff
src/lib/format.ts           alert text and buttons
src/background/relay.ts     WebSocket client: auth, ping, ack, claims, backoff
src/background/watchTab.ts  pinned tab, reload alarm, reads, job queue
src/background/alerts.ts    toast → Telegram, unread-count alert
src/background/commands.ts  /start /check /status, buttons, offline notice
src/content/observer.ts     toast MutationObservers
src/content/reader.ts       inbox / conversation reads (placeholder selectors)
src/content/picker.ts       debug capture picker
src/entrypoints/            background, content script, popup, options
tests/                      Vitest: parser, attachment rule, dedupe, callback_data
```

## Tests

```bash
npm test
```

```bash
npm run compile
```
