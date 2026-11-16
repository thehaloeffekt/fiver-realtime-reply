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

## Selectors and captures

Every selector in `src/lib/selectors.ts` was checked against a real capture
(2026-11-16). They use `data-testid`, `data-track-tag` / `data-track-value`,
`aria-label` and a few semantic classes (`message`, `message-content`,
`contact-excerpt`, `attachment`, `main-header`), never hashed class names.
Sanitized copies of the captures are in `tests/fixtures/` (buyer names,
usernames, image and signed download links replaced) and the tests run on them.

If Fiverr changes its markup, turn on **Settings → Debug mode** and use
**Debug capture** in the popup: open the page, press **Capture**, click the
area. `↑` selects the parent element, `↓` goes back, `Enter` captures, `Esc`
cancels. Your click goes to the picker, not to Fiverr. The captures contain
buyer names and message text; check them before you share them.

| Capture | Page | What to click |
| --- | --- | --- |
| Unread chip | `fiverr.com/inbox` with 1 or more unread conversations | The "Unread" chip with its count, above the list |
| Inbox list | `fiverr.com/inbox` | One row, then `↑` until the outline covers the list |
| Conversation messages | `fiverr.com/inbox/<buyer>` with messages from both sides and a file | One message, then `↑` until the outline covers the thread |
| Account menu | Any Fiverr page, logged in | Your avatar in the top bar |

## Background diagnostics (debug mode)

Fiverr does not render toasts in a hidden tab, so the pinned watch tab
misses them. To find a signal that does fire there, debug mode records, on
every Fiverr page, with the time and `document.visibilityState`:

- `visibilitychange`, focus/blur, freeze/resume, pageshow/pagehide
- every `document.title` change
- every mutation in `ul.realtime-notifications`
- on `/inbox`: rows added, removed, moved or changed in the conversation
  list, and every change of the "Unread" filter chip (both found by broad
  structural matching and logged as 300-character outerHTML snippets,
  because their selectors are not final)
- a heartbeat every 5 minutes (a long gap means Chrome throttled or froze the tab)

The recorder only observes. It does not touch `visibilityState`, does not
inject into the page's main world and does not change the page. The last 300
entries are kept in `chrome.storage.local`; the popup's **Copy diagnostics
log** copies them, one line per entry, and lines from the watch tab are
marked `W`.

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

**Two detectors: toasts, and the inbox list for hidden tabs.** Fiverr does
not render toasts in a hidden tab, so the pinned watch tab (normally hidden)
saw nothing. The diagnostics log of a real hidden-tab test showed that the
`/inbox` conversation list stays live there: within seconds of each message
the buyer's row (`[data-testid="contact"]`) shows the new preview and a higher
unread count. `src/content/inboxWatcher.ts` alerts when a row that is not
"Me:" and not "Typing..." is unread and its count went up or its preview
changed. Rows present when the list appears are the baseline and never alert.
It works inside the MutationObserver callback with no timers, because hidden
tabs delay timers by up to a minute but deliver observer callbacks at once.

Each row's avatar has the buyer's username in `data-track-value`, so every
list alert has "(@user)", "Full message" and a direct "Open inbox" link to
`/inbox/{username}`. The row state and the dedupe key use the username,
because two buyers can have the same display name but never the same
username. If a row ever loses its attributes, it is read by the order of its
text (anchored on the relative time) and the display name → username map
learned from toasts fills in the username.

**Dedupe: same account + username + body within 20 s.** The toast and the
list report the same message, and several tabs show the same toast; they
collapse into one alert. The key uses the first 40 letters of the body,
ignoring case and spaces, because the two sources space the text differently.
The window is short, so a buyer who sends "ok?" again ten minutes later still
alerts you. The check and the record happen in one synchronous step, so two
reports in the same tick cannot both pass. If the send fails, the key is
released so another copy can retry.

A toast that appears in the first seconds after a long-hidden tab becomes
visible is Fiverr replaying a message it skipped while hidden. It is checked
against the last 2 hours instead of 20 s, so it does not repeat an alert the
list already sent, but it still alerts if nothing did. Files appear as
"1 File" in a toast but may differ in the list, so for non-text messages an
alert from the other detector for the same buyer within 20 s also counts as a
duplicate.

**Closing the reload gap** (`src/background/listSync.ts`). A message that
arrives while the watch tab reloads changes the list before the new page reads
it, so the new page would take it as its baseline. So the watch tab's list
state (per username: unread count, preview, "Me:") is saved in
`chrome.storage.local` whenever it changes, and once more right before each
reload. Each report carries a page id (the page's load time). When a report
comes from a new page, it does not overwrite the saved state: the background
reads the fresh list and compares the two, and each row that is unread and
changed alerts. A conversation that was not saved alerts only if it is above
every saved row (where Fiverr puts a new one). Because the new page triggers
the compare, it runs for every kind of replacement: the reload alarm, "Check
now", `/check`, a manual reload, the stale-page reload, and Chrome restoring
the pinned tab at browser start. Saved state older than 24 hours is not used.
More than 8 gap alerts become one summary line.

**Stale page check.** If Chrome freezes the watch tab and later resumes it,
the page may have lost its connection, so the content script asks for a reload
on the `resume` event. If the list is missing on `/inbox` for more than 60 s,
it asks too. A content script cannot report anything while frozen or hung, so
the background also asks the watch tab every minute: no answer twice in a row,
a discarded tab, or a list missing for 60 s means a reload. Each such reload
runs the compare above. At most one stale reload per 5 minutes, so a
logged-out page is not reloaded every minute, and never while you are looking
at the watch tab or while a "Full message" read is moving it.

**"Full message"** opens `/inbox/{username}` in the watch tab and reads the
buyer's last 10 messages (`div.message`, keyed by its id), each with its time.
Files are written as `[file: name]`; the file itself is never read or sent.
Your own messages are skipped by your username (from the account menu) or the
"Me" name. "Translate to English" and "Create an offer" are interface text and
are never part of a body.

**"Check now" and `/check`** reload the watch tab, run the compare, and reply
with the Unread chip's count (unread conversations) and each unread row with
its display name, username and count.

**Default account label** is your username, read from the profile button in
the page header (`data-track-value`, same as the img alt). The conversation
page has a second `<header>` with the buyer's avatar, so only an avatar inside
`.main-header`, or one whose img alt equals its value, counts.

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
are ignored. Linking (step 3) comes before naming (step 4), so the reply uses
the saved label or the username read from Fiverr, and never the "Fiverr
account" placeholder; with neither, it says to name the account in step 4.
Saving a label sends "Account named …" to confirm it.

**Multi-account replies.** `/check` and `/status` go to every profile, and each
answers for itself. For `/status`, the online profile with the smallest
accountId (from the relay's presence frames) also lists offline profiles, so
they appear exactly once.

## Files

```
src/lib/selectors.ts        all Fiverr selectors, each from a real capture
src/lib/toast.ts            toast parser + attachment / empty-body rule
src/lib/dedupe.ts           dedupe key, 20 s / replay windows, sender gate, last-200 update ids
src/lib/inboxRow.ts         inbox list row parser (attributes, text order fallback)
src/lib/listState.ts        per-username list state, new-message rule, gap compare
src/lib/callback.ts         callback_data format
src/lib/telegram.ts         Bot API client (text only), retries with backoff
src/lib/format.ts           alert text and buttons
src/background/relay.ts     WebSocket client: auth, ping, ack, claims, backoff
src/background/watchTab.ts  pinned tab, reload alarm, reads, job queue
src/background/alerts.ts    toast / list message → Telegram
src/background/listSync.ts  saved list state, compare after reloads, stale page check
src/background/commands.ts  /start /check /status, buttons, offline notice
src/content/observer.ts     toast MutationObservers, replay flag
src/content/inboxWatcher.ts inbox list detector (works in hidden tabs)
src/content/reader.ts       Unread chip, list rows, conversation, my username
src/content/picker.ts       debug capture picker
src/content/diagnostics.ts  background diagnostics recorder (debug mode)
src/entrypoints/            background, content script, popup, options
tests/                      Vitest: parsers, dedupe, gap compare, callback_data
tests/fixtures/             sanitized real Fiverr captures used by the tests
```

## Tests

```bash
npm test
```

```bash
npm run compile
```
