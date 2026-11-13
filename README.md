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
| `{"type":"auth","secret","accountId","label"}` | Must be the first frame, within 5 s. `accountId` must equal the URL's. `label` is trimmed to 64 chars and remembered per account. |
| `{"type":"claim","chatId","messageId"}` | "I sent this message." Replies, button presses and reactions on it are routed to this account. Batch form: `{"type":"claim","items":[{chatId,messageId}, {inlineMessageId}, …]}` (max 100). |
| `{"type":"ack","ids":[update_id,…]}` | Removes delivered updates from the buffer (max 100). |
| `ping` (plain text) | Keep-alive, every 20 s. The runtime answers `pong` (plain text) without waking the object. |
| `{"type":"ping"}` | Older keep-alive, still answered with `{"type":"pong"}`, but it wakes the object. Prefer the plain-text form. |

### Relay → client

| Frame | Notes |
| --- | --- |
| `{"type":"ready","accountId","accounts":[…],"updateTtlMs"}` | Sent after a good auth, followed by any buffered updates. |
| `{"type":"update","id","routed","update"}` | `update` is the raw Telegram update. `routed:true`: sent to this account only. `routed:false`: sent to every instance. |
| `{"type":"offline","accountId","label"}` | An update for `accountId` was queued because that account has no open socket. Sent to one other connected instance, at most once per account per 5 minutes, so it can tell the user in Telegram. |
| `{"type":"presence","accounts":[{accountId,label,online,lastSeen}]}` | Sent when an instance connects or leaves. |
| `{"type":"error","error","detail?"}` | Bad frame from an authenticated socket. |

### Close codes

| Code | Meaning |
| --- | --- |
| 4001 | A frame other than `auth` or `ping` arrived before auth |
| 4003 | Wrong secret or `accountId` mismatch |
| 4008 | No `auth` within 5 s |
| 4009 | Replaced by a newer connection with the same `accountId` |
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

### Limits

| Limit | Value | When exceeded |
| --- | --- | --- |
| Webhook calls per bot | 60 in any rolling minute | Answered `200` and the update is dropped, so Telegram does not retry in a loop. Only calls with the right secret count. |
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

The code lives in `src/index.ts` (Worker routing and webhook size check),
`src/relay.ts` (the `RelayHub` Durable Object) and `src/routing.ts` (which
account an update belongs to).
