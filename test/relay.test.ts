import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AUTH_TIMEOUT_MS, CLOSE, UPDATE_HARD_LIMIT_MS, UPDATE_TTL_MS } from "../src/relay";

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
		queue.push(JSON.parse(e.data as string));
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

	it("broadcasts unrouted updates to every instance", async () => {
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

	it("delivers each update_id only once", async () => {
		const bot = await newBot();
		const a = await connect(bot, "alice");
		const update = { update_id: 30, message: { message_id: 1, chat: { id: CHAT }, text: "x" } };
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
		await hook(bot.botKey, bot.secret, { update_id: 50, message: { message_id: 1, chat: { id: 1 }, text: "x" } });
		const stub = stubFor(bot.botKey);

		const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
		expect(alarm).not.toBeNull();
		expect(alarm!).toBeLessThanOrEqual(before + UPDATE_TTL_MS + 1000);

		// Pretend the update arrived TTL ago, then let the alarm run.
		await runInDurableObject(stub, (_i, state) => {
			state.storage.sql.exec("UPDATE pending SET received_at = received_at - ?", UPDATE_TTL_MS);
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const left = await runInDurableObject(stub, (_i, state) =>
			state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending").one().n,
		);
		expect(left).toBe(0);
	});
});
