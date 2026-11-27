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

**Third detector: the open conversation's thread** (`src/content/threadWatcher.ts`).
With a conversation open in a tab, Fiverr marks each new message in it read at
once, so its inbox row never becomes unread, and Fiverr draws no toast in a
hidden tab. So nothing alerted until the tab came to the front and Fiverr
replayed the toast. On `/inbox/{username}` the thread is watched instead: a new
`div.message` whose id was not there when the conversation opened (the first
1.5 s of rendering are the baseline), whose UUID time is newer than every
message in that baseline and not more than 5 min before the conversation was
opened (history loaded by scrolling up never counts), and whose sender is that
buyer (not "Me", not my username) is a new message. Files are named as
`[file: name]`, never sent. It alerts only while the tab is hidden or its
window has no focus; in a visible, focused tab you are reading it. The
background also skips it when any tab shows that conversation in a focused
window. Keys: the message id (two tabs with the same conversation open give one
alert) and the usual account + username + body, with the body as the toast
shows it (the text, or "1 File" for a file-only message), so the replayed
toast and the list do not alert again.

**Rows read at once.** The same open conversation makes its inbox row change
its preview while it stays at 0 unread. The list detector alerts on that too
(as "read"), only while its own tab is hidden or unfocused, and the background
drops it if the conversation is in view. In the after-reload compare it counts
only when the saved state is under 5 minutes old (a reload or the return to
/inbox saves it right before); after a long gap a read row is more likely a
message you read on the phone.

**The watch tab rests on `/inbox`.** If it shows a conversation, hidden, for
over 60 s and no "Full message" is using it, it goes back to `/inbox` and the
list compare runs. Checked on tab and window changes and every minute. The
state saved before that navigation is never an empty list, so a conversation
page without the list cannot wipe the saved state.

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
buyer's last 10 messages (`div.message`, keyed by its id). Files are written as
`[file: name]`; the file itself is never read or sent. Your own messages are
skipped by your username (from the account menu) or the "Me" name. "Translate
to English" and "Create an offer" are interface text and are never part of a
body. The reply has **Open conversation** and **Check now** buttons.

**Long messages and Telegram's 4,096 limit** (`src/lib/split.ts`). Telegram
refuses a message over 4,096 characters (counted after the HTML is parsed) and
text that is not valid UTF-8. An alert shows at most 3,500 characters of the
buyer's message and then "… (message cut, open Fiverr for the rest)", so it
always fits. "Full message" shows each buyer message up to 8,000 characters
(then the same note) and sends the reply as several Telegram messages, split at
line breaks without cutting a tag, an `&amp;` or an emoji. The first part
replies to the command and the buttons go on the last. Over 5 parts, the
oldest buyer messages are left out and a line says how many. No cut ever
splits an emoji (a surrogate pair), and `sendMessage` replaces any lone
surrogate with U+FFFD as a last guard.

**Message times: my time and the buyer's time** (`src/lib/buyerTime.ts`). A
conversation page shows three zones: message times are in the Fiverr
account's zone, the header shows the buyer's local time, and you have your
own (**My time zone**, below). The extension does not parse the message time text. The second half of
each message id (`{conversation}_{message}`) is a version-1 UUID, which holds
the moment the message was created; shown in the account's zone it gives
exactly the time the page shows (tested on the capture). That instant is shown
in My time zone, and at the buyer's offset:
`Nov 16, 6:52 PM (buyer 5:52 PM): text`, with the buyer's day added when it
is a different day. If an id does not parse, the page's text is shown and
marked `(Fiverr account time)`. The line under the title is
`Times: Africa/Lagos. Buyer local time now: 6:07 PM (UTC+0, Country)`.

**My time zone** (`src/lib/myZone.ts`, Settings → My time zone, or
`/timezone`). The browser's own zone is never used as "my time" without
saying so: an anti-detect browser reports each profile's configured zone
(for example UTC-5), not the computer's, and hides the real one. So the zone
is a setting (an IANA name), and every formatter takes it as an argument and
passes it to `Intl.DateTimeFormat`'s `timeZone` option. When it is empty the
browser's zone is used and marked: `Times: America/Bogota (browser zone, not
set: …)`, `last alert 12:52 PM (America/Bogota, browser zone, not set)`. It
covers Full message, the alert's buyer-time day, `/status`, the popup, the
options page and the diagnostics log (`2026-11-16 18:52:00.120 +01:00`). The
buyer's offset does not depend on it: the header clock is compared with UTC.

**The buyer's offset is learned passively.** The header shows
`<time>2:57 AM</time><span>(local time)</span>` next to the buyer's avatar. In
any Fiverr tab where a conversation is open (yours, or "Full message"), the
content script compares that clock with the current UTC time, rounds to 15
minutes, and saves the offset per buyer username with the date. The clock has
no date, so the offset is only known modulo 24 h; it is put in −10:00…+13:45,
which keeps Hawaii (−10) and reads −11/−12 as +13/+12 (New Zealand, Fiji,
Tonga), so every result is in −12…+14. It is re-read on every page change,
when the clock is current. An offset older than 30 days is still used but
shown with `?` (daylight saving may have changed it). The country comes from the
details pane on the right (`[data-testid="details-pane"]`): the
`li[data-track-tag="list_item"]` whose `p[data-track-tag="text"]` label is
"From", value in its `p[data-track-tag="typography"]` (confirmed from a
capture). If you closed that sidebar there is no country; one read earlier is
kept. The extension never opens a conversation just to learn the zone,
because opening it marks it read. Alerts get a last line `Buyer time: 9:54 AM`
when the offset for that buyer is known.

**"Check now" and `/check`** reload the watch tab, run the compare, and reply
with the Unread chip's count (unread conversations) and each unread row with
its display name, username and count, with **Open inbox** and **Check now**
buttons for that account.

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

**Telegram commands.** Registered with `setMyCommands` at setup (step 2) and
after each extension update, so they show in Telegram's "/" menu.

| Command | Who answers |
| --- | --- |
| `/check` | every account: unread count and unread buyers |
| `/check {label}` | only that account |
| `/full {username}` (with or without `@`) | each account that has that buyer in its inbox list |
| `/full {username} {label}` | only that account, also when it does not have the buyer |
| `/status` | each account: label, online, alerts on/paused, unread conversations (the Fiverr "Unread" chip counts conversations, not messages), last alert; the leader adds offline accounts |
| `/pause`, `/resume` | every account, replying with its new state |
| `/pause {label}`, `/resume {label}` | only that account |
| `/timezone {zone}` (`Africa/Lagos`, or a short form such as `Lagos` that matches one zone) | every account saves it and confirms; the leader names offline accounts, which miss it, and alone answers an unknown or ambiguous zone |
| `/timezone` | each account: the zone it uses now, or "not set" with the browser zone |
| `/accounts` | the leader: every profile on the bot with its label, online or offline (last seen), and its account id |
| `/remove {label}` or `/remove {accountId}` | the leader: removes that profile from the bot (see Removing a profile). Refuses an unknown label and lists the valid ones; asks for the account id when two profiles have the same label; refuses its own label (use Settings on that profile) |
| `/help` | the leader: commands and examples |

The relay sends every command to every profile, and each one decides for
itself. Labels match without case. A label is the saved account label, or the
Fiverr username when none is saved (the same name the relay shows in
presence). **The leader** is the online profile with the smallest accountId in
the relay's presence list; it alone answers for the group: `/help`, an unknown
label ("No account is named …" plus the valid labels), and a label whose
account is offline. So each command gets one reply per account it is for, and
group answers come once. If no account has the buyer in `/full {username}`,
nobody answers (one profile cannot see another's inbox).

**Paused.** The popup shows a "Paused" badge and banner. Switching alerts off
or on in the popup or in Settings sends one Telegram message ("alerts paused in
Chrome" / "alerts on"), so every device on the chat sees it. `/pause` and
`/resume` reply instead. Messages that arrive while paused are not sent later:
the list state keeps updating, so `/resume` does not replay them.

## Removing a profile

A profile (one Chrome profile, one Fiverr account) can be removed from the bot
in three ways. The relay side is described in the root README (Removal).

**Settings → Disconnect this profile.** After a confirmation step, in this
order: a Telegram notice ("{label} was disconnected from this bot."), the
`forget` frame (the extension waits up to 5 s for the relay's `removed`
answer), close the socket, close the watch tab, clear all alarms, and clear
all extension storage. The notice needs the token and the chat, and the forget
needs the socket, so storage goes last. If the relay's account list shows that
this was the last account on the bot, `deleteWebhook` is called too, before
storage is cleared (it needs the token); with other accounts, even offline
ones, the webhook stays, because they share it. If Telegram or the relay
cannot be reached the profile is still cleared, and the relay keeps it as an
offline account that `/remove` can remove later. Settings then shows the first
setup step.

**Uninstall.** At setup and at every service worker start the extension calls
`chrome.runtime.setUninstallURL` with
`{relay}/bye/{botKey}?accountId={accountId}&code={removalCode}`. The removal
code is 32 random bytes made at setup; the relay gets only its SHA-256 (in the
auth frame). The URL stays in browser history, so it never holds the bot token
or the secret, only a code that can remove this one account. With the default
relay it is about 200 characters, under Chrome's 1,023 limit (and under 255, the
limit in Chrome versions before 2023). After a removal the URL is cleared.

**Telegram `/remove {label}`.** The leader sends `forget` for that account. If
the profile is online, the relay sends it `removed`; if it is offline, the
relay refuses it with `removed` when it next connects. Either way it stops,
does not reconnect, closes the watch tab, clears alarms and storage, and the
popup says "This profile was removed from the bot. Set it up again to use it."
Without this a removed profile would retry the relay forever.

When the relay removes an account that did not remove itself (`/remove`,
uninstall), it sends `account_removed` to one online profile, which posts
"{label} was removed from this bot." If none is online the relay keeps it for
the next profile that connects.

**A new setup after a removal.** Clearing storage writes a new random
accountId. The relay keeps the old id on a removed list for 90 days, so an old
copy of the profile (a restored profile folder, say) is refused instead of
coming back without notice, while a new setup uses the new id and starts
clean. The removed flag is not cleared by a correct secret, because an old
copy has the correct secret too.

## Files

```
src/lib/selectors.ts        all Fiverr selectors, each from a real capture
src/lib/toast.ts            toast parser + attachment / empty-body rule
src/lib/dedupe.ts           dedupe key, 20 s / replay windows, sender gate, last-200 update ids
src/lib/inboxRow.ts         inbox list row parser (attributes, text order fallback)
src/lib/listState.ts        per-username list state, new-message rule, gap compare
src/lib/callback.ts         callback_data format
src/lib/telegram.ts         Bot API client (text only), retries with backoff
src/lib/format.ts           alert text and buttons, message cut note
src/lib/split.ts            Telegram length: visible length, split long HTML, emoji-safe cuts
src/background/relay.ts     WebSocket client: auth, ping, ack, claims, backoff
src/background/watchTab.ts  pinned tab, reload alarm, reads, job queue
src/background/alerts.ts    toast / list message → Telegram
src/background/listSync.ts  saved list state, compare after reloads, stale page check
src/background/commands.ts  commands (/check /full /status /pause /resume /timezone /accounts /remove /help), buttons, leader rule, offline and removed notices
src/background/setup.ts     setup step 2, uninstall URL, Disconnect this profile, removed elsewhere
src/background/buyerZones.ts saved buyer UTC offsets per username
src/lib/buyerTime.ts        message time from the id, buyer offset from the header clock, formatting
src/lib/myZone.ts           My time zone: setting, browser fallback, zone lookup and offsets
src/content/buyerHeader.ts  reads the conversation header clock passively in any Fiverr tab
src/content/threadWatcher.ts new buyer messages in an open conversation, while you are away from the tab
src/background/view.ts      is a conversation in view (active tab, focused window)
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
