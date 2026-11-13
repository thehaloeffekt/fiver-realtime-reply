import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	AUTH_TIMEOUT_MS,
	CLOSE,
	HOOK_RATE_LIMIT,
	MAX_QUEUED_UPDATES,
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

async function connect(bot: { botKey: string; secret: string }, accountId: string, label = accountId) {
	const c = await open(bot.botKey, accountId);
	c.send({ type: "auth", secret: bot.secret, accountId, label });
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
