import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	AUTH_TIMEOUT_MS,
	BYE_RATE_LIMIT,
	CLOSE,
	HOOK_RATE_LIMIT,
	MAX_PEER_BODY_BYTES,
	MAX_QUEUED_UPDATES,
	PEER_RATE_LIMIT,
	REMOVED_TTL_MS,
	ROUTE_TTL_MS,
	UPDATE_HARD_LIMIT_MS,
	UPDATE_TTL_MS,
} from "../src/relay";

const BASE = "https://relay.example";

async function hex(input: string): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
	return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let tokenCounter = 0;
/** Each test uses its own bot token so Durable Objects never overlap. */
async function newBot() {
	const token = `123456:test-token-${Date.now()}-${tokenCounter++}`;
	return { botKey: await hex(`fta-key:${token}`), secret: await hex(`fta-secret:${token}`) };
}

type Frame = Record<string, any>;

interface Client {
	ws: WebSocket;
	next(type?: string, timeoutMs?: number): Promise<Frame>;
	closed: Promise<{ code: number; reason: string }>;
	send(msg: unknown): void;
}

async function open(botKey: string, accountId: string): Promise<Client> {
	const res = await SELF.fetch(`${BASE}/ws/${botKey}?accountId=${encodeURIComponent(accountId)}`, {
		headers: { Upgrade: "websocket" },
	});
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	ws.accept();
	const queue: Frame[] = [];
	const waiters: Array<() => void> = [];
	ws.addEventListener("message", (e) => {
		const data = e.data as string;
		// Keep-alive replies are plain text, everything else is JSON.
		queue.push(data.startsWith("{") ? JSON.parse(data) : { type: "text", data });
		waiters.splice(0).forEach((w) => w());
	});
	const closed = new Promise<{ code: number; reason: string }>((resolve) =>
		ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason })),
	);
	return {
		ws,
		closed,
		send: (msg) => ws.send(typeof msg === "string" ? msg : JSON.stringify(msg)),
		async next(type, timeoutMs = 2000) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const i = queue.findIndex((f) => !type || f.type === type);
				if (i >= 0) return queue.splice(i, 1)[0]!;
				const left = deadline - Date.now();
				if (left <= 0) throw new Error(`timed out waiting for ${type ?? "frame"}`);
				await new Promise<void>((resolve) => {
					waiters.push(resolve);
					setTimeout(resolve, left);
				});
			}
		},
	};
}

async function connect(bot: { botKey: string; secret: string }, accountId: string, label = accountId, extra: Frame = {}) {
	const c = await open(bot.botKey, accountId);
	c.send({ type: "auth", secret: bot.secret, accountId, label, ...extra });
	const ready = await c.next("ready");
	return { ...c, ready };
}

function hook(botKey: string, secret: string | null, update: unknown) {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
	return SELF.fetch(`${BASE}/hook/${botKey}`, { method: "POST", headers, body: JSON.stringify(update) });
}

/** Resolves true if no frame of `type` arrives within `ms`. */
async function silent(c: Client, type: string, ms = 300) {
	try {
		await c.next(type, ms);
		return false;
	} catch {
		return true;
	}
}

const stubFor = (botKey: string) => env.RELAY.get(env.RELAY.idFromName(botKey));

const pendingCount = (botKey: string) =>
	runInDurableObject(stubFor(botKey), (_i, state) =>
		state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending").one().n,
	);
const pause = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("routes", () => {
	it("GET /health returns ok", async () => {
		const res = await SELF.fetch(`${BASE}/health`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	it("rejects malformed botKeys and missing accountId", async () => {
		expect((await hook("nothex", "x", { update_id: 1 })).status).toBe(404);
		const bot = await newBot();
		const res = await SELF.fetch(`${BASE}/ws/${bot.botKey}`, { headers: { Upgrade: "websocket" } });
		expect(res.status).toBe(400);
		expect((await SELF.fetch(`${BASE}/ws/${bot.botKey}?accountId=a`)).status).toBe(426);
		expect((await SELF.fetch(`${BASE}/nope`)).status).toBe(404);
	});
});

describe("webhook authentication", () => {
	it("rejects webhooks before any extension has registered a secret", async () => {
		const bot = await newBot();
		expect((await hook(bot.botKey, bot.secret, { update_id: 1 })).status).toBe(401);
	});

	it("rejects a wrong or missing secret header", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		expect((await hook(bot.botKey, "0".repeat(64), { update_id: 1 })).status).toBe(401);
		expect((await hook(bot.botKey, null, { update_id: 2 })).status).toBe(401);
		expect((await hook(bot.botKey, bot.secret, { update_id: 3 })).status).toBe(200);
		a.ws.close();
	});

	it("rejects bodies larger than 64 KB", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		const big = { update_id: 1, message: { text: "x".repeat(70 * 1024) } };
		expect((await hook(bot.botKey, bot.secret, big)).status).toBe(413);
		expect(await silent(a, "update")).toBe(true);
		a.ws.close();
	});
});

describe("websocket authentication", () => {
	it("stores the secret on first use and rejects a different one later", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		expect(a.ready.accountId).toBe("alice");

		const intruder = await open(bot.botKey, "mallory");
		intruder.send({ type: "auth", secret: "f".repeat(64), accountId: "mallory", label: "x" });
		expect((await intruder.closed).code).toBe(CLOSE.AUTH_FAILED);

		const stored = await runInDurableObject(stubFor(bot.botKey), (_i, state) =>
			state.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'secret_hash'").one().v,
		);
		expect(stored).toBe(await hex(bot.secret));
		expect(stored).not.toContain(bot.secret);
		a.ws.close();
	});

	it("closes when the first message is not auth", async () => {
		const bot = await newBot();
		const c = await open(bot.botKey, "alice");
		c.send({ type: "claim", chatId: 1, messageId: 1 });
		expect((await c.closed).code).toBe(CLOSE.AUTH_REQUIRED);
	});

	it("closes when auth accountId differs from the URL", async () => {
		const bot = await newBot();
		const c = await open(bot.botKey, "alice");
		c.send({ type: "auth", secret: bot.secret, accountId: "bob", label: "" });
		expect((await c.closed).code).toBe(CLOSE.AUTH_FAILED);
	});

	it(
		"closes when auth does not arrive within 5 seconds",
		async () => {
			const bot = await newBot();
			const c = await open(bot.botKey, "alice");
			const started = Date.now();
			const { code } = await c.closed;
			expect(code).toBe(CLOSE.AUTH_TIMEOUT);
			expect(Date.now() - started).toBeGreaterThanOrEqual(AUTH_TIMEOUT_MS - 200);
		},
		AUTH_TIMEOUT_MS + 5000,
	);

	it("replaces an older connection of the same account", async () => {
		const bot = await newBot();
		const first = await connect(bot, "alice");
		const second = await connect(bot, "alice");
		expect((await first.closed).code).toBe(CLOSE.REPLACED);
		second.ws.close();
	});

	it("remembers the last label for each account", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice", "Alice v1");
		a.ws.close();
		await a.closed;
		const a2 = await connect(bot, "alice", "Alice v2");
		const b = await connect(bot, "bob", "Bob");
		expect(b.ready.accounts).toEqual([
			expect.objectContaining({ accountId: "alice", label: "Alice v2", online: true }),
			expect.objectContaining({ accountId: "bob", label: "Bob", online: true }),
		]);
		// alice first sees her own join, then bob's.
		await a2.next("presence");
		const presence = await a2.next("presence");
		expect(presence.accounts.map((x: Frame) => x.label)).toEqual(["Alice v2", "Bob"]);
		b.ws.close();
		const left = await a2.next("presence");
		expect(left.accounts).toContainEqual(expect.objectContaining({ accountId: "bob", online: false }));
		a2.ws.close();
	});
});

describe("routing", () => {
	const CHAT = 777;

	it("broadcasts bot commands to every instance", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		const b = await connect(bot, "bob");
		const update = { update_id: 10, message: { message_id: 5, chat: { id: CHAT }, text: "/status" } };
		expect((await hook(bot.botKey, bot.secret, update)).status).toBe(200);
		for (const c of [a, b]) {
			const f = await c.next("update");
			expect(f).toEqual({ type: "update", id: 10, routed: false, update });
		}
		a.ws.close();
		b.ws.close();
	});

	it("routes replies, button presses and reactions to the account that claimed the message", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		const b = await connect(bot, "bob");
		a.send({ type: "claim", chatId: CHAT, messageId: 100 });
		b.send({ type: "claim", items: [{ chatId: String(CHAT), messageId: 200 }, { inlineMessageId: "AbC-123" }] });
		await new Promise((r) => setTimeout(r, 50));

		const reply = {
			update_id: 20,
			message: { message_id: 101, chat: { id: CHAT }, text: "hi", reply_to_message: { message_id: 200, chat: { id: CHAT } } },
		};
		const button = {
			update_id: 21,
			callback_query: { id: "q", data: "open", message: { message_id: 100, chat: { id: CHAT } } },
		};
		const inline = { update_id: 22, callback_query: { id: "q2", inline_message_id: "AbC-123" } };
		const reaction = { update_id: 23, message_reaction: { chat: { id: CHAT }, message_id: 100 } };

		for (const u of [reply, button, inline, reaction]) expect((await hook(bot.botKey, bot.secret, u)).status).toBe(200);

		expect((await b.next("update")).id).toBe(20);
		expect((await a.next("update")).id).toBe(21);
		expect(await b.next("update")).toMatchObject({ id: 22, routed: true });
		expect((await a.next("update")).id).toBe(23);
		expect(await silent(a, "update")).toBe(true);
		expect(await silent(b, "update")).toBe(true);
		a.ws.close();
		b.ws.close();
	});

	it("drops plain messages that match no claim", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		const b = await connect(bot, "bob");
		const plain = { update_id: 70, message: { message_id: 9, chat: { id: CHAT }, text: "hello" } };
		const strayReply = {
			update_id: 71,
			message: { message_id: 10, chat: { id: CHAT }, text: "ok", reply_to_message: { message_id: 999 } },
		};
		for (const u of [plain, strayReply]) expect((await hook(bot.botKey, bot.secret, u)).status).toBe(200);
		expect(await silent(a, "update")).toBe(true);
		expect(await silent(b, "update")).toBe(true);
		expect(await pendingCount(bot.botKey)).toBe(0);
		a.ws.close();
		b.ws.close();
	});

	it("broadcasts a command even when it replies to a claimed message", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		const b = await connect(bot, "bob");
		a.send({ type: "claim", chatId: CHAT, messageId: 400 });
		await pause();
		const cmd = {
			update_id: 72,
			message: { message_id: 401, chat: { id: CHAT }, text: "/status", reply_to_message: { message_id: 400 } },
		};
		await hook(bot.botKey, bot.secret, cmd);
		expect(await a.next("update")).toMatchObject({ id: 72, routed: false });
		expect(await b.next("update")).toMatchObject({ id: 72, routed: false });
		a.ws.close();
		b.ws.close();
	});

	it("routes an unclaimed button press by the accountId in callback_data", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		const b = await connect(bot, "bob");
		const press = (id: number, data: string) => ({
			update_id: id,
			callback_query: { id: `q${id}`, data, message: { message_id: 500 + id, chat: { id: CHAT } } },
		});
		await hook(bot.botKey, bot.secret, press(80, "c|bob|reply|order-42"));
		await hook(bot.botKey, bot.secret, press(81, "c|bob|open|")); // empty arg is fine
		expect(await b.next("update")).toMatchObject({ id: 80, routed: true });
		expect(await b.next("update")).toMatchObject({ id: 81, routed: true });
		expect(await silent(a, "update")).toBe(true);

		// Not the c|accountId|action|arg shape: broadcast.
		for (const [id, data] of [[82, "open|42"], [83, "c|bob|open"], [84, "c|bad id!|x|y"]] as const) {
			await hook(bot.botKey, bot.secret, press(id, data));
			expect(await a.next("update")).toMatchObject({ id, routed: false });
			expect(await b.next("update")).toMatchObject({ id, routed: false });
		}
		a.ws.close();
		b.ws.close();
	});

	it("prefers a claim over the accountId in callback_data", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		const b = await connect(bot, "bob");
		a.send({ type: "claim", chatId: CHAT, messageId: 600 });
		await pause();
		await hook(bot.botKey, bot.secret, {
			update_id: 85,
			callback_query: { id: "q", data: "c|bob|open|1", message: { message_id: 600, chat: { id: CHAT } } },
		});
		expect((await a.next("update")).id).toBe(85);
		expect(await silent(b, "update")).toBe(true);
		a.ws.close();
		b.ws.close();
	});

	it("tells one other profile when the target account is offline, at most once per 5 minutes", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice", "Alice");
		const c = await connect(bot, "carol", "Carol");
		const b = await connect(bot, "bob", "Bob (main)");
		b.ws.close();
		await b.closed;

		const press = (id: number) => ({
			update_id: id,
			callback_query: { id: `q${id}`, data: "c|bob|reply|1", message: { message_id: id, chat: { id: CHAT } } },
		});
		await hook(bot.botKey, bot.secret, press(90));
		const notice = await Promise.any([a.next("offline"), c.next("offline")]);
		expect(notice).toEqual({ type: "offline", accountId: "bob", label: "Bob (main)" });
		// Exactly one socket got it.
		expect((await silent(a, "offline")) && (await silent(c, "offline"))).toBe(true);

		await hook(bot.botKey, bot.secret, press(91));
		expect(await silent(a, "offline")).toBe(true);
		expect(await silent(c, "offline")).toBe(true);

		// After the 5-minute window a new notice may go out.
		await runInDurableObject(stubFor(bot.botKey), (_i, state) => {
			state.storage.sql.exec("UPDATE offline_notices SET at = at - ?", 5 * 60_000);
		});
		await hook(bot.botKey, bot.secret, press(92));
		await Promise.any([a.next("offline"), c.next("offline")]);
		a.ws.close();
		c.ws.close();
	});

	it("delivers each update_id only once", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		const update = { update_id: 30, message: { message_id: 1, chat: { id: CHAT }, text: "/check" } };
		await hook(bot.botKey, bot.secret, update);
		await hook(bot.botKey, bot.secret, update);
		expect((await a.next("update")).id).toBe(30);
		expect(await silent(a, "update")).toBe(true);
		a.ws.close();
	});

	it("buffers updates for an offline account and replays them on reconnect until acked", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		const b = await connect(bot, "bob");
		b.send({ type: "claim", chatId: CHAT, messageId: 300 });
		await new Promise((r) => setTimeout(r, 50));
		b.ws.close();
		await b.closed;

		const reply = {
			update_id: 40,
			message: { message_id: 301, chat: { id: CHAT }, text: "yes", reply_to_message: { message_id: 300 } },
		};
		expect((await hook(bot.botKey, bot.secret, reply)).status).toBe(200);
		expect(await silent(a, "update")).toBe(true);

		const b2 = await connect(bot, "bob");
		const replayed = await b2.next("update");
		expect(replayed).toMatchObject({ id: 40, routed: true });
		b2.send({ type: "ack", ids: [40] });
		await new Promise((r) => setTimeout(r, 50));
		b2.ws.close();
		await b2.closed;

		const b3 = await connect(bot, "bob");
		expect(await silent(b3, "update")).toBe(true);
		b3.ws.close();
		a.ws.close();
	});
});

describe("keep-alive", () => {
	it('answers the text "ping" with "pong" without running the object', async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		a.send("ping");
		expect(await a.next("text")).toEqual({ type: "text", data: "pong" });
		const answered = await runInDurableObject(stubFor(bot.botKey), (_i, state) =>
			state.getWebSockets("acct:alice").map((ws) => state.getWebSocketAutoResponseTimestamp(ws)),
		);
		expect(answered[0]).toBeInstanceOf(Date);
		// The older JSON ping still works.
		a.send({ type: "ping" });
		expect((await a.next("pong")).type).toBe("pong");
		a.ws.close();
	});
});

describe("limits", () => {
	it(`accepts ${HOOK_RATE_LIMIT} webhook calls per minute and drops the rest with 200`, async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		const cmd = (id: number) => ({ update_id: id, message: { message_id: id, chat: { id: 1 }, text: "/s" } });
		for (let i = 1; i <= HOOK_RATE_LIMIT; i++) expect((await hook(bot.botKey, bot.secret, cmd(i))).status).toBe(200);
		for (let i = 1; i <= HOOK_RATE_LIMIT; i++) expect((await a.next("update")).id).toBe(i);

		const over = await hook(bot.botKey, bot.secret, cmd(1000));
		expect(over.status).toBe(200);
		expect(await silent(a, "update")).toBe(true);

		// Wrong-secret calls are refused before the limiter and never count.
		const before = await runInDurableObject(stubFor(bot.botKey), (_i, state) =>
			state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hook_hits").one().n,
		);
		expect((await hook(bot.botKey, "0".repeat(64), cmd(1001))).status).toBe(401);
		const after = await runInDurableObject(stubFor(bot.botKey), (_i, state) =>
			state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hook_hits").one().n,
		);
		expect(after).toBe(before);

		// Once the window slides past, updates flow again.
		await runInDurableObject(stubFor(bot.botKey), (_i, state) => {
			state.storage.sql.exec("UPDATE hook_hits SET at = at - 60000");
		});
		await hook(bot.botKey, bot.secret, cmd(1002));
		expect((await a.next("update")).id).toBe(1002);
		a.ws.close();
	});

	it(`keeps at most ${MAX_QUEUED_UPDATES} queued updates and drops the oldest first`, async () => {
		const bot = await newBot();
		const b = await connect(bot, "bob");
		b.ws.close();
		await b.closed;
		const total = MAX_QUEUED_UPDATES + 3;
		for (let id = 1; id <= total; id++) {
			const press = { update_id: id, callback_query: { id: `q${id}`, data: "c|bob|open|x" } };
			expect((await hook(bot.botKey, bot.secret, press)).status).toBe(200);
		}
		expect(await pendingCount(bot.botKey)).toBe(MAX_QUEUED_UPDATES);

		const b2 = await connect(bot, "bob");
		const ids: number[] = [];
		for (let i = 0; i < MAX_QUEUED_UPDATES; i++) ids.push((await b2.next("update")).id);
		expect(ids[0]).toBe(4);
		expect(ids.at(-1)).toBe(total);
		b2.ws.close();
	});
});

describe("hibernation", () => {
	it("keeps routing to authenticated sockets after the object is evicted", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		a.send({ type: "claim", chatId: 9, messageId: 1 });
		await new Promise((r) => setTimeout(r, 50));
		await evictDurableObject(stubFor(bot.botKey));
		const reply = { update_id: 60, message: { message_id: 2, chat: { id: 9 }, reply_to_message: { message_id: 1 } } };
		expect((await hook(bot.botKey, bot.secret, reply)).status).toBe(200);
		expect(await a.next("update")).toMatchObject({ id: 60, routed: true });
		a.ws.close();
	});
});

describe("retention", () => {
	it("never keeps an update longer than 5 minutes", async () => {
		expect(UPDATE_TTL_MS).toBeLessThan(UPDATE_HARD_LIMIT_MS);
		const bot = await newBot();
		const a = await connect(bot, "alice");
		a.ws.close();
		await a.closed;

		const before = Date.now();
		await hook(bot.botKey, bot.secret, { update_id: 50, message: { message_id: 1, chat: { id: 1 }, text: "/start" } });
		const stub = stubFor(bot.botKey);

		const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
		expect(alarm).not.toBeNull();
		expect(alarm!).toBeLessThanOrEqual(before + UPDATE_TTL_MS + 1000);

		// Pretend the update arrived TTL ago, then let the alarm run.
		await runInDurableObject(stub, (_i, state) => {
			state.storage.sql.exec("UPDATE pending SET received_at = received_at - ?", UPDATE_TTL_MS);
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await pendingCount(bot.botKey)).toBe(0);
	});

	it("the alarm deletes expired claims", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		const before = Date.now();
		a.send({ type: "claim", items: [{ chatId: 1, messageId: 1 }, { chatId: 1, messageId: 2 }] });
		await pause();
		a.ws.close();
		await a.closed;
		const stub = stubFor(bot.botKey);

		const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
		expect(alarm).not.toBeNull();
		expect(alarm!).toBeLessThanOrEqual(before + ROUTE_TTL_MS + 1000);

		// Age one claim past its TTL; the alarm removes it and keeps the other.
		await runInDurableObject(stub, (_i, state) => {
			state.storage.sql.exec("UPDATE routes SET created_at = created_at - ? WHERE message = '1'", ROUTE_TTL_MS);
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const left = await runInDurableObject(stub, (_i, state) => ({
			routes: state.storage.sql.exec<{ message: string }>("SELECT message FROM routes").toArray().map((r) => r.message),
			alarm: state.storage.getAlarm(),
		}));
		expect(left.routes).toEqual(["2"]);
		// The next alarm is set for the remaining claim.
		expect(await left.alarm).not.toBeNull();
	});
});

describe("removal", () => {
	const CHAT = 555;
	const CODE = "c0de".repeat(16);
	const bye = (botKey: string, accountId: string, code: string) =>
		SELF.fetch(`${BASE}/bye/${botKey}?accountId=${encodeURIComponent(accountId)}&code=${encodeURIComponent(code)}`);
	const PAGE_TEXT = "This profile was disconnected. You can close this tab.";

	/** Rows left for one account in every table that holds per-account data. */
	const leftovers = (botKey: string, accountId: string) =>
		runInDurableObject(stubFor(botKey), (_i, state) => {
			const n = (q: string, ...p: unknown[]) => state.storage.sql.exec<{ n: number }>(q, ...p).one().n;
			return {
				accounts: n("SELECT COUNT(*) AS n FROM accounts WHERE account_id = ?", accountId),
				routes: n("SELECT COUNT(*) AS n FROM routes WHERE account_id = ?", accountId),
				pending: n("SELECT COUNT(*) AS n FROM pending WHERE target = ?", accountId),
				codes: n("SELECT COUNT(*) AS n FROM removal_codes WHERE account_id = ?", accountId),
				removed: n("SELECT COUNT(*) AS n FROM removed WHERE account_id = ?", accountId),
			};
		});

	/** bob: one claim, one queued update for him, and a removal code. Returns the sockets. */
	async function threeProfiles() {
		const bot = await newBot();
		const a = await connect(bot, "alice", "Alice");
		const b = await connect(bot, "bob", "Bob", { removalCodeHash: await hex(CODE) });
		b.send({ type: "claim", chatId: CHAT, messageId: 900 });
		await pause();
		return { bot, a, b };
	}

	it("stores only the hash of the removal code, sent at auth", async () => {
		const { bot, a, b } = await threeProfiles();
		const stored = await runInDurableObject(stubFor(bot.botKey), (_i, state) =>
			state.storage.sql.exec<{ code_hash: string }>("SELECT code_hash FROM removal_codes WHERE account_id = 'bob'").one().code_hash,
		);
		expect(stored).toBe(await hex(CODE));
		expect(stored).not.toContain(CODE);
		a.ws.close();
		b.ws.close();
	});

	it("forget: deletes the account's data, closes its sockets and tells one other profile", async () => {
		const { bot, a, b } = await threeProfiles();
		const c = await connect(bot, "carol", "Carol");
		// One update waiting for bob (queued, not acked).
		const press = { update_id: 700, callback_query: { id: "q", data: "c|bob|open|1", message: { message_id: 900, chat: { id: CHAT } } } };
		await hook(bot.botKey, bot.secret, press);
		await b.next("update");
		expect(await leftovers(bot.botKey, "bob")).toEqual({ accounts: 1, routes: 1, pending: 1, codes: 1, removed: 0 });

		a.send({ type: "forget", accountId: "bob" });
		expect(await b.next("removed")).toEqual({ type: "removed" });
		expect((await b.closed).code).toBe(CLOSE.REMOVED);
		const notice = await Promise.any([a.next("account_removed"), c.next("account_removed")]);
		expect(notice).toEqual({ type: "account_removed", accountId: "bob", label: "Bob" });
		// Exactly one profile got it.
		expect((await silent(a, "account_removed")) && (await silent(c, "account_removed"))).toBe(true);
		expect(await leftovers(bot.botKey, "bob")).toEqual({ accounts: 0, routes: 0, pending: 0, codes: 0, removed: 1 });

		// bob is gone from presence.
		const presence = await a.next("presence");
		expect(presence.accounts.map((x: Frame) => x.accountId)).not.toContain("bob");
		a.ws.close();
		c.ws.close();
	});

	it("forget of itself (Settings) sends no account_removed: that profile told the user already", async () => {
		const { bot, a, b } = await threeProfiles();
		b.send({ type: "forget", accountId: "bob" });
		await b.next("removed");
		expect((await b.closed).code).toBe(CLOSE.REMOVED);
		expect(await silent(a, "account_removed")).toBe(true);
		expect((await leftovers(bot.botKey, "bob")).removed).toBe(1);
		a.ws.close();
	});

	it("forget of an unknown or malformed accountId is an error, and changes nothing", async () => {
		const { bot, a, b } = await threeProfiles();
		a.send({ type: "forget", accountId: "nobody" });
		expect(await a.next("error")).toMatchObject({ error: "unknown_account" });
		a.send({ type: "forget", accountId: "bad id!" });
		expect(await a.next("error")).toMatchObject({ error: "bad_forget" });
		expect((await leftovers(bot.botKey, "nobody")).removed).toBe(0);
		a.ws.close();
		b.ws.close();
	});

	it("queues account_removed when no other profile is online, for the next one that connects", async () => {
		const { bot, a, b } = await threeProfiles();
		a.ws.close();
		await a.closed;
		b.ws.close();
		await b.closed;

		// Uninstall of bob while nobody is online.
		expect((await bye(bot.botKey, "bob", CODE)).status).toBe(200);
		expect((await leftovers(bot.botKey, "bob")).removed).toBe(1);

		const a2 = await connect(bot, "alice", "Alice");
		expect(await a2.next("account_removed")).toEqual({ type: "account_removed", accountId: "bob", label: "Bob" });
		a2.ws.close();
		await a2.closed;
		// Delivered once only.
		const a3 = await connect(bot, "alice", "Alice");
		expect(await silent(a3, "account_removed")).toBe(true);
		a3.ws.close();
	});

	it("GET /bye with the right code removes the account and shows the page", async () => {
		const { bot, a, b } = await threeProfiles();
		const res = await bye(bot.botKey, "bob", CODE);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(await res.text()).toContain(PAGE_TEXT);
		expect((await b.closed).code).toBe(CLOSE.REMOVED);
		// Not removed by a profile, so the other profile tells the user.
		expect(await a.next("account_removed")).toEqual({ type: "account_removed", accountId: "bob", label: "Bob" });
		expect(await leftovers(bot.botKey, "bob")).toEqual({ accounts: 0, routes: 0, pending: 0, codes: 0, removed: 1 });
		a.ws.close();
	});

	it("GET /bye with a wrong code shows the very same page and removes nothing", async () => {
		const { bot, a, b } = await threeProfiles();
		const good = await (await bye(bot.botKey, "bob", "0".repeat(64))).text();
		for (const [botKey, accountId, code] of [
			[bot.botKey, "bob", "0".repeat(64)], // wrong code
			[bot.botKey, "bob", "short"], // malformed code
			[bot.botKey, "nobody", CODE], // unknown account
			[bot.botKey, "alice", CODE], // another account's code
			["nothex", "bob", CODE], // malformed botKey
		]) {
			const res = await bye(botKey!, accountId!, code!);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe(good);
		}
		expect(good).toContain(PAGE_TEXT);
		expect(await leftovers(bot.botKey, "bob")).toEqual({ accounts: 1, routes: 1, pending: 0, codes: 1, removed: 0 });
		expect(await silent(b, "removed")).toBe(true);
		a.ws.close();
		b.ws.close();
	});

	it(`rate limits GET /bye to ${BYE_RATE_LIMIT} calls per minute per bot`, async () => {
		const { bot, a, b } = await threeProfiles();
		for (let i = 0; i < BYE_RATE_LIMIT; i++) expect((await bye(bot.botKey, "bob", "0".repeat(64))).status).toBe(200);
		// Over the limit even the right code is not checked.
		expect((await bye(bot.botKey, "bob", CODE)).status).toBe(429);
		expect((await leftovers(bot.botKey, "bob")).removed).toBe(0);
		await runInDurableObject(stubFor(bot.botKey), (_i, state) => {
			state.storage.sql.exec("UPDATE bye_hits SET at = at - 60000");
		});
		expect((await bye(bot.botKey, "bob", CODE)).status).toBe(200);
		expect((await leftovers(bot.botKey, "bob")).removed).toBe(1);
		a.ws.close();
	});

	it("auth refuses a removed accountId, but a new accountId on the same bot works", async () => {
		const { bot, a, b } = await threeProfiles();
		a.send({ type: "forget", accountId: "bob" });
		await b.closed;

		// An old copy of the extension with the right secret and the old id.
		const old = await open(bot.botKey, "bob");
		old.send({ type: "auth", secret: bot.secret, accountId: "bob", label: "Bob" });
		expect(await old.next("removed")).toEqual({ type: "removed" });
		expect((await old.closed).code).toBe(CLOSE.REMOVED);

		// A wrong secret still gets 4003, not "removed": strangers learn nothing.
		const stranger = await open(bot.botKey, "bob");
		stranger.send({ type: "auth", secret: "f".repeat(64), accountId: "bob", label: "x" });
		expect((await stranger.closed).code).toBe(CLOSE.AUTH_FAILED);

		// A new setup makes a new accountId: clean state, no claims, connects.
		const fresh = await connect(bot, "bobnew01", "Bob");
		expect(fresh.ready.accountId).toBe("bobnew01");
		expect(await leftovers(bot.botKey, "bobnew01")).toEqual({ accounts: 1, routes: 0, pending: 0, codes: 0, removed: 0 });

		// After 90 days the old id may connect again.
		await runInDurableObject(stubFor(bot.botKey), (_i, state) => {
			state.storage.sql.exec("UPDATE removed SET at = at - ?", REMOVED_TTL_MS);
		});
		const back = await connect(bot, "bob", "Bob");
		expect(back.ready.accountId).toBe("bob");
		a.ws.close();
		fresh.ws.close();
		back.ws.close();
	});

	it("presence and ready list offline accounts with their labels", async () => {
		const bot = await newBot();
		const b = await connect(bot, "bob", "Bob (spare)");
		b.ws.close();
		await b.closed;
		const a = await connect(bot, "alice", "Alice");
		expect(a.ready.accounts).toEqual([
			expect.objectContaining({ accountId: "alice", label: "Alice", online: true }),
			expect.objectContaining({ accountId: "bob", label: "Bob (spare)", online: false }),
		]);
		const c = await connect(bot, "carol", "Carol");
		await a.next("presence"); // alice's own join
		const presence = await a.next("presence");
		expect(presence.accounts).toContainEqual(expect.objectContaining({ accountId: "bob", label: "Bob (spare)", online: false }));
		expect(presence.accounts).toHaveLength(3);
		a.ws.close();
		c.ws.close();
	});

	it("the alarm deletes removed-list entries after 90 days", async () => {
		const { bot, a, b } = await threeProfiles();
		a.send({ type: "forget", accountId: "bob" });
		await b.closed;
		a.ws.close();
		await a.closed;
		const stub = stubFor(bot.botKey);
		await runInDurableObject(stub, (_i, state) => {
			state.storage.sql.exec("UPDATE removed SET at = at - ?", REMOVED_TTL_MS);
			state.storage.sql.exec("DELETE FROM routes");
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect((await leftovers(bot.botKey, "bob")).removed).toBe(0);
	});
});

describe("replies from Telegram", () => {
	const CHAT = 4242;
	const TEXT = "Hello from a test";
	const BOT_FROM = { id: 1000, is_bot: true, first_name: "Alerts" };
	const USER_FROM = { id: 2000, is_bot: false, first_name: "Tester" };

	/** An alert as Telegram repeats it inside reply_to_message. */
	const alert = (messageId: number, keyboard?: unknown) => ({
		message_id: messageId,
		chat: { id: CHAT },
		from: BOT_FROM,
		text: "New message from test_buyer_one",
		...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }),
	});
	const replyTo = (updateId: number, replied: unknown, text = TEXT) => ({
		update_id: updateId,
		message: { message_id: updateId + 10_000, chat: { id: CHAT }, from: USER_FROM, text, reply_to_message: replied },
	});

	/** Every row of every table of the bot's Durable Object, as JSON text. */
	const everyRow = (botKey: string) =>
		runInDurableObject(stubFor(botKey), (_i, state) => {
			const sql = state.storage.sql;
			const tables = sql
				.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
				.toArray()
				.map((r) => r.name);
			return { tables, dump: JSON.stringify(tables.map((t) => sql.exec(`SELECT * FROM "${t}"`).toArray())) };
		});

	it("a plain-text reply to a claimed alert goes only to the claiming account", async () => {
		const bot = await newBot();
		const a = await connect(bot, "acc-a");
		const b = await connect(bot, "acc-b");
		a.send({ type: "claim", chatId: CHAT, messageId: 1 });
		await pause();
		// The buttons name acc-b, but the claim wins.
		const update = replyTo(100, alert(1, [[{ text: "Full", callback_data: "c|acc-b|full|x" }]]));
		expect((await hook(bot.botKey, bot.secret, update)).status).toBe(200);
		expect(await a.next("update")).toEqual({ type: "update", id: 100, routed: true, update });
		expect(await silent(b, "update")).toBe(true);
		a.ws.close();
		b.ws.close();
	});

	it("an unclaimed reply to a bot message goes to the account in its buttons", async () => {
		const bot = await newBot();
		const a = await connect(bot, "acc-a");
		const b = await connect(bot, "acc-b");
		const keyboard = [
			[{ text: "Open", url: "https://www.fiverr.com/inbox/test_buyer_one" }, { text: "Other", callback_data: "open|1" }],
			[{ text: "Full", callback_data: "c|acc-b|full|x" }, { text: "Later", callback_data: "c|acc-a|full|y" }],
		];
		await hook(bot.botKey, bot.secret, replyTo(101, alert(2, keyboard)));
		expect(await b.next("update")).toMatchObject({ id: 101, routed: true });
		expect(await silent(a, "update")).toBe(true);
		a.ws.close();
		b.ws.close();
	});

	it("an unclaimed reply to a bot message without our buttons goes to everyone", async () => {
		const bot = await newBot();
		const a = await connect(bot, "acc-a");
		const b = await connect(bot, "acc-b");
		const shapes = [
			alert(3), // no reply_markup
			alert(4, [[{ text: "Other", callback_data: "open|1" }, { text: "Link", url: "https://example.com" }]]),
			alert(5, "not an array"),
			alert(6, [null, "x", [null, 7, { callback_data: 5 }, { callback_data: "c|bad id!|x|y" }]]),
		];
		for (const [i, replied] of shapes.entries()) {
			const id = 110 + i;
			await hook(bot.botKey, bot.secret, replyTo(id, replied));
			expect(await a.next("update")).toMatchObject({ id, routed: false });
			expect(await b.next("update")).toMatchObject({ id, routed: false });
		}
		a.ws.close();
		b.ws.close();
	});

	it("drops a reply to a non-bot message and a plain message that replies to nothing", async () => {
		const bot = await newBot();
		const a = await connect(bot, "acc-a");
		const b = await connect(bot, "acc-b");
		const userMessage = { message_id: 7, chat: { id: CHAT }, from: USER_FROM, text: "earlier", reply_markup: { inline_keyboard: [[{ text: "x", callback_data: "c|acc-b|full|x" }]] } };
		const updates = [
			replyTo(120, userMessage),
			replyTo(121, { message_id: 8, chat: { id: CHAT }, text: "no sender" }),
			replyTo(122, { message_id: 9, chat: { id: CHAT }, from: { id: 1, is_bot: "true" }, text: "string is_bot" }),
			{ update_id: 123, message: { message_id: 9, chat: { id: CHAT }, from: USER_FROM, text: TEXT } },
		];
		for (const u of updates) expect((await hook(bot.botKey, bot.secret, u)).status).toBe(200);
		expect(await silent(a, "update")).toBe(true);
		expect(await silent(b, "update")).toBe(true);
		expect(await pendingCount(bot.botKey)).toBe(0);
		a.ws.close();
		b.ws.close();
	});

	it("a command sent as a reply to an alert is still broadcast", async () => {
		const bot = await newBot();
		const a = await connect(bot, "acc-a");
		const b = await connect(bot, "acc-b");
		a.send({ type: "claim", chatId: CHAT, messageId: 10 });
		await pause();
		await hook(bot.botKey, bot.secret, replyTo(130, alert(10, [[{ text: "Full", callback_data: "c|acc-a|full|x" }]]), "/reply test_buyer_one"));
		await hook(bot.botKey, bot.secret, replyTo(131, alert(11, [[{ text: "Full", callback_data: "c|acc-a|full|x" }]]), "/status"));
		for (const id of [130, 131]) {
			expect(await a.next("update")).toMatchObject({ id, routed: false });
			expect(await b.next("update")).toMatchObject({ id, routed: false });
		}
		a.ws.close();
		b.ws.close();
	});

	it("a reply for an offline account is queued, one profile is told, and it is replayed on connect", async () => {
		const bot = await newBot();
		const a = await connect(bot, "acc-a", "Profile A");
		const c = await connect(bot, "acc-c", "Profile C");
		const b = await connect(bot, "acc-b", "Profile B");
		b.send({ type: "claim", chatId: CHAT, messageId: 20 });
		await pause();
		b.ws.close();
		await b.closed;

		// One reply routed by claim, one by the buttons of an unclaimed alert.
		const byClaim = replyTo(140, alert(20));
		const byButtons = replyTo(141, alert(21, [[{ text: "Full", callback_data: "c|acc-b|full|x" }]]));
		await hook(bot.botKey, bot.secret, byClaim);
		const notice = await Promise.any([a.next("offline"), c.next("offline")]);
		expect(notice).toEqual({ type: "offline", accountId: "acc-b", label: "Profile B" });
		expect((await silent(a, "offline")) && (await silent(c, "offline"))).toBe(true);
		await hook(bot.botKey, bot.secret, byButtons);
		expect(await silent(a, "update")).toBe(true);
		expect(await silent(c, "update")).toBe(true);
		expect(await pendingCount(bot.botKey)).toBe(2);

		const b2 = await connect(bot, "acc-b", "Profile B");
		expect(await b2.next("update")).toEqual({ type: "update", id: 140, routed: true, update: byClaim });
		expect(await b2.next("update")).toEqual({ type: "update", id: 141, routed: true, update: byButtons });
		b2.send({ type: "ack", ids: [140, 141] });
		await pause();
		expect(await pendingCount(bot.botKey)).toBe(0);
		a.ws.close();
		c.ws.close();
		b2.ws.close();
	});

	it(`still drops webhook number ${HOOK_RATE_LIMIT + 1} in a minute, replies included`, async () => {
		const bot = await newBot();
		const a = await connect(bot, "acc-a");
		a.send({ type: "claim", chatId: CHAT, messageId: 30 });
		await pause();
		for (let i = 1; i <= HOOK_RATE_LIMIT; i++) {
			expect((await hook(bot.botKey, bot.secret, replyTo(1000 + i, alert(30)))).status).toBe(200);
		}
		for (let i = 1; i <= HOOK_RATE_LIMIT; i++) expect((await a.next("update")).id).toBe(1000 + i);
		const over = replyTo(1000 + HOOK_RATE_LIMIT + 1, alert(30));
		expect((await hook(bot.botKey, bot.secret, over)).status).toBe(200);
		expect(await silent(a, "update")).toBe(true);
		a.ws.close();
	});

	it("does not keep the reply text once the target has acked it", async () => {
		const bot = await newBot();
		const a = await connect(bot, "acc-a");
		const b = await connect(bot, "acc-b");
		a.send({ type: "claim", chatId: CHAT, messageId: 40 });
		await pause();
		await hook(bot.botKey, bot.secret, replyTo(150, alert(40)));
		expect((await a.next("update")).id).toBe(150);

		// Before the ack the update waits in `pending` (so the search below works).
		const before = await everyRow(bot.botKey);
		expect(before.tables).toEqual(expect.arrayContaining(["pending", "seen", "routes"]));
		expect(before.dump).toContain(TEXT);

		// Another profile's ack does not remove a routed update; the target's does.
		b.send({ type: "ack", ids: [150] });
		await pause();
		expect(await pendingCount(bot.botKey)).toBe(1);
		a.send({ type: "ack", ids: [150] });
		await pause();
		const after = await everyRow(bot.botKey);
		expect(after.dump).not.toContain(TEXT);
		expect(after.dump).not.toContain("test_buyer_one");
		// Only the update_id is left, for de-duplication.
		const seen = await runInDurableObject(stubFor(bot.botKey), (_i, state) =>
			state.storage.sql.exec("SELECT * FROM seen").toArray(),
		);
		expect(seen).toEqual([{ update_id: 150, at: expect.any(Number) }]);
		a.ws.close();
		b.ws.close();
	});
});

describe("peer frames", () => {
	const peerRows = (botKey: string) =>
		runInDurableObject(stubFor(botKey), (_i, state) => ({
			pending: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending").one().n,
			notices: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM notices").one().n,
		}));

	it("forwards a peer frame to every other online profile, not to the sender, and stores nothing", async () => {
		const bot = await newBot();
		const a = await connect(bot, "acc-a");
		const b = await connect(bot, "acc-b");
		const c = await connect(bot, "acc-c");
		const body = { kind: "has_buyer", ask: 12345, yes: true };
		a.send({ type: "peer", body });
		for (const other of [b, c]) expect(await other.next("peer")).toEqual({ type: "peer", from: "acc-a", body });
		expect(await silent(a, "peer")).toBe(true);
		expect(await peerRows(bot.botKey)).toEqual({ pending: 0, notices: 0 });

		// A profile that connects later gets nothing replayed.
		const d = await connect(bot, "acc-d");
		expect(await silent(d, "peer")).toBe(true);
		for (const x of [a, b, c, d]) x.ws.close();
	});

	it("refuses a body that is not an object or is too large with bad_peer", async () => {
		const bot = await newBot();
		const a = await connect(bot, "acc-a");
		const b = await connect(bot, "acc-b");
		for (const body of [undefined, null, "text", 5, [1, 2]]) {
			a.send({ type: "peer", body });
			expect(await a.next("error")).toMatchObject({ error: "bad_peer" });
		}
		// The JSON of {"x":"…"} is 8 bytes plus the string.
		a.send({ type: "peer", body: { x: "y".repeat(MAX_PEER_BODY_BYTES - 8 + 1) } });
		expect(await a.next("error")).toMatchObject({ error: "bad_peer" });
		// Multi-byte characters count as bytes, not characters.
		a.send({ type: "peer", body: { x: "é".repeat(MAX_PEER_BODY_BYTES / 2) } });
		expect(await a.next("error")).toMatchObject({ error: "bad_peer" });
		expect(await silent(b, "peer")).toBe(true);

		a.send({ type: "peer", body: { x: "y".repeat(MAX_PEER_BODY_BYTES - 8) } });
		expect((await b.next("peer")).body.x).toHaveLength(MAX_PEER_BODY_BYTES - 8);
		a.ws.close();
		b.ws.close();
	});

	it(`allows ${PEER_RATE_LIMIT} peer frames per bot per minute, then peer_rate`, async () => {
		const bot = await newBot();
		const a = await connect(bot, "acc-a");
		const b = await connect(bot, "acc-b");
		// The limit is per bot: frames from both profiles count.
		for (let i = 0; i < PEER_RATE_LIMIT; i++) (i % 2 ? b : a).send({ type: "peer", body: { n: i } });
		for (let i = 0; i < PEER_RATE_LIMIT; i++) expect((await (i % 2 ? a : b).next("peer")).body.n).toBe(i);
		a.send({ type: "peer", body: { n: "over" } });
		expect(await a.next("error")).toMatchObject({ error: "peer_rate" });
		expect(await silent(b, "peer")).toBe(true);

		await runInDurableObject(stubFor(bot.botKey), (_i, state) => {
			state.storage.sql.exec("UPDATE peer_hits SET at = at - 60000");
		});
		a.send({ type: "peer", body: { n: "again" } });
		expect((await b.next("peer")).body.n).toBe("again");
		a.ws.close();
		b.ws.close();
	});
});
