# fta-relay

A Cloudflare Worker with one Durable Object that connects one Telegram bot to
several **Fiverr Telegram Alerts** extension instances (one per Chrome profile /
Fiverr account). Telegram delivers each update to one webhook; the relay
routes it to the profile it belongs to.

Fixed rules:

- The relay never receives the bot token and never calls the Telegram API. The
  extension makes every Telegram call, including `setWebhook`.
- No update is kept longer than 5 minutes. Buffered updates expire after
  4 min 30 s; a Durable Object alarm deletes them, and every request purges
  expired rows first. The same alarm deletes expired claims (14 days).
  Relay notices (`account_removed`, see below) are not Telegram updates: they
  hold only an account label and wait up to 30 days for a profile to connect.

## Identity

The extension derives two values from the bot token:

```
botKey = hex(SHA-256("fta-key:"    + token))
secret = hex(SHA-256("fta-secret:" + token))
```

There is one Durable Object per `botKey` (`idFromName(botKey)`). Trust on
first use: the first WebSocket that authenticates stores `SHA-256(secret)` in
the object's storage. Later sockets and every webhook must match it
(constant-time compare). Webhooks never set the secret, so a webhook that
arrives before any extension has connected gets `401`.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /hook/:botKey` | Telegram webhook. Checks `X-Telegram-Bot-Api-Secret-Token`; `401` if wrong or missing, `413` if the body is over 64 KB, else `200` with an empty body. Rate limited (see Limits). |
| `GET /ws/:botKey?accountId=…` | WebSocket for one extension instance. |
| `GET /bye/:botKey?accountId=…&code=…` | Uninstall URL. Removes one account when `SHA-256(code)` matches the `removalCodeHash` it sent at auth (see Removal). Always `200` with the same page, match or not; `429` over the rate limit. |
| `GET /health` | Returns `ok`. |

The extension registers the webhook itself:

```
setWebhook(url = "https://<relay-host>/hook/<botKey>", secret_token = <secret>)
```

A webhook turns off `getUpdates`, so the extension stops long polling once it
uses the relay.

## WebSocket protocol

`accountId` must match `[A-Za-z0-9_.:@-]{1,64}`. It goes in the URL because
the Hibernation API fixes a socket's tags when it is accepted; the socket is
tagged `acct:<accountId>`. All frames are JSON text.

### Client → relay

| Frame | Notes |
| --- | --- |
| `{"type":"auth","secret","accountId","label","removalCodeHash?"}` | Must be the first frame, within 5 s. `accountId` must equal the URL's. `label` is trimmed to 64 chars and remembered per account. Optional `removalCodeHash`: hex SHA-256 of the account's removal code, stored per account for `GET /bye` (ignored unless 64 hex chars). A removed `accountId` gets `{"type":"removed"}` and close 4010. |
| `{"type":"claim","chatId","messageId"}` | "I sent this message." Replies, button presses and reactions on it are routed to this account. Batch form: `{"type":"claim","items":[{chatId,messageId}, {inlineMessageId}, …]}` (max 100). |
| `{"type":"ack","ids":[update_id,…]}` | Removes delivered updates from the buffer (max 100). |
| `{"type":"forget","accountId"}` | Removes one account of this bot (any profile may remove any account, including itself). See Removal. Error `unknown_account` if the relay does not know it. |
| `ping` (plain text) | Keep-alive, every 20 s. The runtime answers `pong` (plain text) without waking the object. |
| `{"type":"ping"}` | Older keep-alive, still answered with `{"type":"pong"}`, but it wakes the object. Prefer the plain-text form. |

### Relay → client

| Frame | Notes |
| --- | --- |
| `{"type":"ready","accountId","accounts":[…],"updateTtlMs"}` | Sent after a good auth, followed by any buffered updates. |
| `{"type":"update","id","routed","update"}` | `update` is the raw Telegram update. `routed:true`: sent to this account only. `routed:false`: sent to every instance. |
| `{"type":"offline","accountId","label"}` | An update for `accountId` was queued because that account has no open socket. Sent to one other connected instance, at most once per account per 5 minutes, so it can tell the user in Telegram. |
| `{"type":"presence","accounts":[{accountId,label,online,lastSeen}]}` | Sent when an instance connects, leaves or is removed. Lists every known account, offline ones too (`online:false`), so a profile can show and remove an account whose browser is closed. `ready.accounts` has the same shape. |
| `{"type":"removed"}` | This account was removed (forget, `GET /bye`, or auth with a removed `accountId`). The socket is closed with 4010 right after. The extension must clear its state and not reconnect. |
| `{"type":"account_removed","accountId","label"}` | Another account was removed. Sent to one other online profile so it can tell the user in Telegram; queued for the next profile that connects if none is online. Not sent when an account removed itself (the Settings flow tells the user itself). |
| `{"type":"error","error","detail?"}` | Bad frame from an authenticated socket. |

### Close codes

| Code | Meaning |
| --- | --- |
| 4001 | A frame other than `auth` or `ping` arrived before auth |
| 4003 | Wrong secret or `accountId` mismatch |
| 4008 | No `auth` within 5 s |
| 4009 | Replaced by a newer connection with the same `accountId` |
| 4010 | The account was removed, or is on the removed list (90 days) |
| 4400 | Bad frame before auth |
| 4429 | Too many sockets on this bot (32) |

### Routing

Rules, first match wins:

1. **Bot command** — a message (`message`, `edited_message`, `channel_post`, …)
   whose `text` starts with `/`, such as `/start`, `/check`, `/status`: every
   connected instance, `routed:false`. This holds even when the command is a
   reply to a claimed message.
2. **Claimed message** — the update points at a message an extension claimed:
   a `callback_query` on it, a reply to it (`reply_to_message`), a
   `message_reaction(_count)`, or a `chosen_inline_result`/inline
   `callback_query` with a claimed `inline_message_id`. Goes only to the
   claiming account, `routed:true`.
3. **Button press without a claim** — if `callback_data` is
   `c|{accountId}|{action}|{arg}` (at least four `|`-separated parts, `arg`
   may be empty, `accountId` in the allowed charset), only that account,
   `routed:true`. Any other `callback_data`: every instance, `routed:false`.
4. **Any other message, reaction or inline result without a claim** —
   dropped (answered `200`, never stored).
5. **Everything else** (for example `my_chat_member` when the user blocks the
   bot) — every instance, `routed:false`.

Delivery:

- Claims are kept for 14 days (max 50,000 per bot).
- Every delivered update is also buffered until acked or expired. If the target
  is offline it is replayed on reconnect, and one other instance gets an
  `offline` notice. The first ack of a broadcast update removes it for everyone.
- Duplicate `update_id`s (Telegram retries) are delivered once. Extensions
  should still de-duplicate by `id`, because a replay can repeat an update
  that was delivered but not acked.

### Removal

An account can be removed three ways. All end in the same steps.

- **Settings** in the extension sends `forget` for its own `accountId`.
- **Telegram** `/remove label` makes the leader profile send `forget` for
  another account.
- **Uninstall**: Chrome opens the extension's uninstall URL,
  `GET /bye/:botKey?accountId=…&code=…`.

The removal code is random (32 bytes, hex), made by the extension at setup
and kept in its storage. The relay stores only its SHA-256, sent as
`removalCodeHash` at auth. The uninstall URL stays in browser history, so it
holds neither the bot token nor the secret, only a code that can remove that
one account and nothing else. `/bye` hashes the code and compares it with the
stored hash in constant time, and shows the same page whether it matched or
not, so the answer does not tell an attacker which codes are right.

On removal the relay:

1. deletes the account's label, claims, queued updates and removal hash;
2. puts the `accountId` on the removed list for 90 days;
3. sends `{"type":"removed"}` to that account's sockets and closes them (4010);
4. unless the account removed itself, sends `account_removed` to one other
   online profile, or queues it for the next one that connects (30 days, at
   most 20 queued);
5. sends `presence` to the rest.

While on the removed list the `accountId` cannot authenticate: an old copy of
the extension (a restored profile, a second install with the same storage)
gets `removed` and 4010 instead of connecting again without notice. The check
runs after the secret check, so a stranger learns nothing. A new setup is not
affected, because the extension makes a new random `accountId` whenever its
storage is cleared.

### Limits

| Limit | Value | When exceeded |
| --- | --- | --- |
| Webhook calls per bot | 60 in any rolling minute | Answered `200` and the update is dropped, so Telegram does not retry in a loop. Only calls with the right secret count. |
| `GET /bye` calls per bot | 10 in any rolling minute, match or not | `429`, and the code is not checked |
| Queued updates per bot | 50 | The oldest are dropped first. |
| Webhook body | 64 KB | `413` |
| Sockets per bot | 32 | Closed with 4429 |
| Client frame | 16 KB | Error frame, or close before auth |

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run dev
```

```bash
npm run deploy
```

After changing `wrangler.jsonc`, run `npm run cf-typegen` to refresh
`worker-configuration.d.ts`.

The code lives in `src/index.ts` (Worker routing and webhook size check;
it exports only the handler and the Durable Object class, so shared values
such as the body limit go in `src/constants.ts`),
`src/relay.ts` (the `RelayHub` Durable Object) and `src/routing.ts` (which
account an update belongs to).
