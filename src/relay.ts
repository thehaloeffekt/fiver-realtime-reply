import { DurableObject } from "cloudflare:workers";
import { BROADCAST, parseClaim, routeKeyOf, targetFor, type RouteKey } from "./routing";
import { ACCOUNT_ID, HEX64, cleanLabel, fromHex, sha256, timingSafeEqual, toHex } from "./util";

/** Hard rule: no update is kept longer than this. */
export const UPDATE_HARD_LIMIT_MS = 5 * 60_000;
/**
 * Buffered updates expire this long after arrival. It is below the hard limit
 * so a slightly late alarm still deletes them inside 5 minutes; every request
 * also purges expired rows before doing anything else.
 */
export const UPDATE_TTL_MS = 4 * 60_000 + 30_000;
/** A socket must authenticate within this time. */
export const AUTH_TIMEOUT_MS = 5_000;
/** Claimed message ids stay routable this long (replies can come much later). */
export const ROUTE_TTL_MS = 14 * 24 * 60 * 60_000;
export const MAX_ROUTES = 50_000;
/** update_ids remembered for de-duplicating Telegram retries. */
export const SEEN_TTL_MS = 10 * 60_000;
export const MAX_SOCKETS = 32;
export const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;
export const MAX_CLAIMS_PER_MESSAGE = 100;
export const MAX_ACKS_PER_MESSAGE = 100;
/** Most updates held in the buffer per bot; the oldest are dropped first. */
export const MAX_QUEUED_UPDATES = 50;
/** Accepted webhook calls per bot in any rolling minute. */
export const HOOK_RATE_LIMIT = 60;
export const HOOK_RATE_WINDOW_MS = 60_000;
/** At most one "offline" notice per account in this period. */
export const OFFLINE_NOTICE_INTERVAL_MS = 5 * 60_000;
const HOUSEKEEPING_INTERVAL_MS = 60_000;

export const CLOSE = {
	AUTH_REQUIRED: 4001,
	AUTH_FAILED: 4003,
	AUTH_TIMEOUT: 4008,
	REPLACED: 4009,
	BAD_MESSAGE: 4400,
	TOO_MANY: 4429,
} as const;

interface SocketState {
	accountId: string;
	authed: boolean;
	connectedAt: number;
}

export interface AccountInfo {
	accountId: string;
	label: string;
	online: boolean;
	lastSeen: number;
}

const tagOf = (accountId: string) => `acct:${accountId}`;

/**
 * One instance per bot (keyed by botKey). Holds the trust-on-first-use secret
 * hash, the claimed-message routing table, known account labels, and a
 * short-lived buffer of updates waiting for an offline instance.
 */
export class RelayHub extends DurableObject<Env> {
	private sql: SqlStorage;
	private lastHousekeeping = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS accounts (
				account_id TEXT PRIMARY KEY,
				label TEXT NOT NULL,
				last_seen INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS routes (
				chat TEXT NOT NULL,
				message TEXT NOT NULL,
				account_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (chat, message)
			);
			CREATE INDEX IF NOT EXISTS routes_created ON routes (created_at);
			CREATE TABLE IF NOT EXISTS pending (
				update_id INTEGER PRIMARY KEY,
				target TEXT NOT NULL,
				body TEXT NOT NULL,
				received_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pending_received ON pending (received_at);
			CREATE TABLE IF NOT EXISTS seen (update_id INTEGER PRIMARY KEY, at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS hook_hits (at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS offline_notices (account_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
		`);
		// The extension sends the text "ping" every 20 s. The runtime answers
		// "pong" itself, so a hibernated object stays asleep. Only one pair can be
		// registered per object; the older {"type":"ping"} frame is still
		// answered, but by webSocketMessage.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	// ---------------------------------------------------------------- secret

	/**
	 * Checks a secret against the stored hash. With `allowFirstUse`, an
	 * object that has no hash yet stores this one (trust on first use).
	 * The read and the write run synchronously after the only await, so two
	 * racing first connections cannot both claim the object.
	 */
	private async checkSecret(secret: string, allowFirstUse: boolean): Promise<boolean> {
		const hash = await sha256(secret);
		const row = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'secret_hash'").toArray()[0];
		if (!row) {
			if (!allowFirstUse) return false;
			this.sql.exec("INSERT INTO meta (k, v) VALUES ('secret_hash', ?)", toHex(hash));
			return true;
		}
		return timingSafeEqual(hash, fromHex(row.v));
	}

	// --------------------------------------------------------------- webhook

	/**
	 * Called by the Worker for POST /hook/:botKey after the size check.
	 * Returns the HTTP status to give Telegram.
	 */
	async handleWebhook(secretHeader: string | null, body: string): Promise<number> {
		if (!secretHeader || secretHeader.length > 256) return 401;
		if (!(await this.checkSecret(secretHeader, false))) return 401;

		const now = Date.now();
		this.housekeeping(now);

		// Over the limit: say 200 so Telegram does not retry, and drop the update.
		if (!this.takeHookSlot(now)) return 200;

		let update: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(body);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return 400;
			update = parsed as Record<string, unknown>;
		} catch {
			return 400;
		}
		const updateId = update.update_id;
		if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) return 400;

		// Telegram retries a delivery it thinks failed; deliver each update once.
		if (this.sql.exec("SELECT 1 FROM seen WHERE update_id = ?", updateId).toArray().length) return 200;
		this.sql.exec("INSERT INTO seen (update_id, at) VALUES (?, ?)", updateId, now);

		const key = routeKeyOf(update);
		const target = targetFor(update, key && this.lookupRoute(key));
		if (target === null) {
			// Dropped (unclaimed plain message). Only its update_id is kept, for de-duplication.
			await this.scheduleAlarm(now + SEEN_TTL_MS);
			return 200;
		}

		this.sql.exec(
			"INSERT OR REPLACE INTO pending (update_id, target, body, received_at) VALUES (?, ?, ?, ?)",
			updateId,
			target,
			body,
			now,
		);
		this.capQueue();

		const frame = updateFrame(updateId, target !== BROADCAST, body);
		const sockets = target === BROADCAST ? this.authedSockets() : this.authedSockets(target);
		for (const ws of sockets) safeSend(ws, frame);
		if (target !== BROADCAST && sockets.length === 0) this.noticeOffline(target, now);

		await this.scheduleAlarm(now + UPDATE_TTL_MS);
		return 200;
	}

	/**
	 * Sliding-window rate limit: true if this webhook call may proceed. Only
	 * calls that passed the secret check get here, so a stranger who knows
	 * the botKey cannot use up the bot's allowance.
	 */
	private takeHookSlot(now: number): boolean {
		this.sql.exec("DELETE FROM hook_hits WHERE at <= ?", now - HOOK_RATE_WINDOW_MS);
		const used = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hook_hits").one().n;
		if (used >= HOOK_RATE_LIMIT) return false;
		this.sql.exec("INSERT INTO hook_hits (at) VALUES (?)", now);
		return true;
	}

	/** Keeps at most MAX_QUEUED_UPDATES buffered updates, dropping the oldest. */
	private capQueue() {
		const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending").one().n;
		if (count <= MAX_QUEUED_UPDATES) return;
		this.sql.exec(
			"DELETE FROM pending WHERE update_id IN (SELECT update_id FROM pending ORDER BY received_at, update_id LIMIT ?)",
			count - MAX_QUEUED_UPDATES,
		);
	}

	/**
	 * Tells one other connected profile that `accountId` is offline, so it can
	 * say so in Telegram. At most once per account per 5 minutes; the time is
	 * stored only when a notice was really sent.
	 */
	private noticeOffline(accountId: string, now: number) {
		const recent = this.sql
			.exec("SELECT 1 FROM offline_notices WHERE account_id = ? AND at > ?", accountId, now - OFFLINE_NOTICE_INTERVAL_MS)
			.toArray().length;
		if (recent) return;
		const messenger = this.authedSockets().find((ws) => stateOf(ws)!.accountId !== accountId);
		if (!messenger) return;
		const label =
			this.sql.exec<{ label: string }>("SELECT label FROM accounts WHERE account_id = ?", accountId).toArray()[0]?.label ?? "";
		safeSend(messenger, JSON.stringify({ type: "offline", accountId, label }));
		this.sql.exec("INSERT OR REPLACE INTO offline_notices (account_id, at) VALUES (?, ?)", accountId, now);
	}

	private lookupRoute(key: RouteKey): string | null {
		const row = this.sql
			.exec<{ account_id: string }>("SELECT account_id FROM routes WHERE chat = ? AND message = ?", key.chat, key.message)
			.toArray()[0];
		return row?.account_id ?? null;
	}

	// ------------------------------------------------------------- websocket

	/** GET /ws/:botKey?accountId=… (already validated by the Worker). */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("expected websocket", { status: 426 });
		}
		const accountId = new URL(request.url).searchParams.get("accountId") ?? "";
		if (!ACCOUNT_ID.test(accountId)) return new Response("bad accountId", { status: 400 });

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		// Hibernation tags are fixed when the socket is accepted, which is why
		// the accountId also travels in the URL. The auth message must repeat it.
		this.ctx.acceptWebSocket(server, [tagOf(accountId)]);

		if (this.ctx.getWebSockets().length > MAX_SOCKETS) {
			server.close(CLOSE.TOO_MANY, "too many connections");
			return new Response(null, { status: 101, webSocket: client });
		}

		const now = Date.now();
		server.serializeAttachment({ accountId, authed: false, connectedAt: now } satisfies SocketState);
		await this.scheduleAlarm(now + AUTH_TIMEOUT_MS);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const state = stateOf(ws);
		if (!state) return;
		const now = Date.now();
		this.housekeeping(now);

		if (typeof message !== "string") {
			return this.reject(ws, state, CLOSE.BAD_MESSAGE, "binary frames are not supported");
		}
		if (message.length > MAX_CLIENT_MESSAGE_BYTES) {
			return this.reject(ws, state, 1009, "message too large");
		}
		let msg: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(message);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
			msg = parsed as Record<string, unknown>;
		} catch {
			return this.reject(ws, state, CLOSE.BAD_MESSAGE, "invalid JSON");
		}

		if (!state.authed) return this.authenticate(ws, state, msg, now);

		switch (msg.type) {
			case "claim":
				return this.handleClaim(ws, state, msg, now);
			case "ack":
				return this.handleAck(ws, state, msg);
			case "ping":
				safeSend(ws, '{"type":"pong"}');
				return;
			default:
				sendError(ws, "unknown_type");
		}
	}

	/** Closes a socket that is not authenticated yet; only reports an error otherwise. */
	private reject(ws: WebSocket, state: SocketState, code: number, reason: string): void {
		if (state.authed) sendError(ws, "bad_message", reason);
		else safeClose(ws, code, reason);
	}

	private async authenticate(ws: WebSocket, state: SocketState, msg: Record<string, unknown>, now: number) {
		// Before this release the runtime answered {"type":"ping"} even before
		// auth. Keep doing so; the 5-second auth deadline still applies.
		if (msg.type === "ping") return safeSend(ws, '{"type":"pong"}');
		if (msg.type !== "auth") return safeClose(ws, CLOSE.AUTH_REQUIRED, "auth required");
		if (now - state.connectedAt > AUTH_TIMEOUT_MS) return safeClose(ws, CLOSE.AUTH_TIMEOUT, "auth timeout");
		if (typeof msg.secret !== "string" || !HEX64.test(msg.secret)) {
			return safeClose(ws, CLOSE.AUTH_FAILED, "auth failed");
		}
		if (msg.accountId !== state.accountId) return safeClose(ws, CLOSE.AUTH_FAILED, "accountId mismatch");
		if (!(await this.checkSecret(msg.secret, true))) return safeClose(ws, CLOSE.AUTH_FAILED, "auth failed");
		if (ws.readyState !== WebSocket.OPEN) return;

		const label = cleanLabel(msg.label);
		state.authed = true;
		ws.serializeAttachment(state);
		this.sql.exec(
			`INSERT INTO accounts (account_id, label, last_seen) VALUES (?, ?, ?)
			 ON CONFLICT (account_id) DO UPDATE SET label = excluded.label, last_seen = excluded.last_seen`,
			state.accountId,
			label,
			now,
		);

		// One live connection per account: a reloaded extension replaces the old socket.
		for (const other of this.ctx.getWebSockets(tagOf(state.accountId))) {
			if (other !== ws) safeClose(other, CLOSE.REPLACED, "replaced by a newer connection");
		}

		safeSend(
			ws,
			JSON.stringify({
				type: "ready",
				accountId: state.accountId,
				accounts: this.accounts(),
				updateTtlMs: UPDATE_TTL_MS,
			}),
		);

		// Replay what arrived while this instance was offline.
		const rows = this.sql
			.exec<{ update_id: number; target: string; body: string }>(
				`SELECT update_id, target, body FROM pending
				 WHERE (target = ? OR target = ?) AND received_at > ? ORDER BY update_id`,
				state.accountId,
				BROADCAST,
				now - UPDATE_TTL_MS,
			)
			.toArray();
		for (const row of rows) safeSend(ws, updateFrame(row.update_id, row.target !== BROADCAST, row.body));

		this.broadcastPresence();
	}

	private async handleClaim(ws: WebSocket, state: SocketState, msg: Record<string, unknown>, now: number) {
		const items = Array.isArray(msg.items) ? msg.items : [msg];
		if (items.length > MAX_CLAIMS_PER_MESSAGE) return sendError(ws, "too_many_claims");
		let bad = 0;
		for (const item of items) {
			const key = parseClaim(item);
			if (!key) {
				bad++;
				continue;
			}
			this.sql.exec(
				"INSERT OR REPLACE INTO routes (chat, message, account_id, created_at) VALUES (?, ?, ?, ?)",
				key.chat,
				key.message,
				state.accountId,
				now,
			);
		}
		if (bad) sendError(ws, "bad_claim", `${bad} claim(s) ignored`);
		// The alarm also deletes claims, so it must run when this one expires.
		if (bad < items.length) await this.scheduleAlarm(now + ROUTE_TTL_MS);
	}

	private handleAck(ws: WebSocket, state: SocketState, msg: Record<string, unknown>) {
		const ids = Array.isArray(msg.ids) ? msg.ids : [msg.id];
		if (ids.length > MAX_ACKS_PER_MESSAGE) return sendError(ws, "too_many_acks");
		for (const id of ids) {
			if (typeof id !== "number" || !Number.isSafeInteger(id)) continue;
			// An instance may drop its own updates and broadcast ones; the first
			// ack of a broadcast update removes it from the buffer.
			this.sql.exec(
				"DELETE FROM pending WHERE update_id = ? AND (target = ? OR target = ?)",
				id,
				state.accountId,
				BROADCAST,
			);
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		// 1005/1006 are reserved and cannot be sent back.
		safeClose(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
		this.onSocketGone(ws);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.onSocketGone(ws);
	}

	private onSocketGone(ws: WebSocket) {
		const state = stateOf(ws);
		if (!state?.authed) return;
		this.sql.exec("UPDATE accounts SET last_seen = ? WHERE account_id = ?", Date.now(), state.accountId);
		this.broadcastPresence(ws);
	}

	// ------------------------------------------------------------- presence

	private authedSockets(accountId?: string, exclude?: WebSocket): WebSocket[] {
		const sockets = accountId ? this.ctx.getWebSockets(tagOf(accountId)) : this.ctx.getWebSockets();
		return sockets.filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN && stateOf(ws)?.authed);
	}

	private accounts(exclude?: WebSocket): AccountInfo[] {
		const online = new Set(this.authedSockets(undefined, exclude).map((ws) => stateOf(ws)!.accountId));
		return this.sql
			.exec<{ account_id: string; label: string; last_seen: number }>(
				"SELECT account_id, label, last_seen FROM accounts ORDER BY account_id",
			)
			.toArray()
			.map((r) => ({ accountId: r.account_id, label: r.label, online: online.has(r.account_id), lastSeen: r.last_seen }));
	}

	private broadcastPresence(exclude?: WebSocket) {
		const frame = JSON.stringify({ type: "presence", accounts: this.accounts(exclude) });
		for (const ws of this.authedSockets(undefined, exclude)) safeSend(ws, frame);
	}

	// ---------------------------------------------------------- expiry/alarm

	/** Sets the alarm to `at` unless one is already due earlier. */
	private async scheduleAlarm(at: number) {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}

	/** Deletes expired updates on every call; trims the other tables at most once a minute. */
	private housekeeping(now: number) {
		this.sql.exec("DELETE FROM pending WHERE received_at <= ?", now - UPDATE_TTL_MS);
		if (now - this.lastHousekeeping < HOUSEKEEPING_INTERVAL_MS) return;
		this.lastHousekeeping = now;
		this.sql.exec("DELETE FROM seen WHERE at <= ?", now - SEEN_TTL_MS);
		this.sql.exec("DELETE FROM routes WHERE created_at <= ?", now - ROUTE_TTL_MS);
		this.sql.exec("DELETE FROM hook_hits WHERE at <= ?", now - HOOK_RATE_WINDOW_MS);
		this.sql.exec("DELETE FROM offline_notices WHERE at <= ?", now - OFFLINE_NOTICE_INTERVAL_MS);
		const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM routes").one().n;
		if (count > MAX_ROUTES) {
			this.sql.exec(
				"DELETE FROM routes WHERE rowid IN (SELECT rowid FROM routes ORDER BY created_at LIMIT ?)",
				count - MAX_ROUTES,
			);
		}
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		this.lastHousekeeping = 0;
		this.housekeeping(now);

		let next = Infinity;
		for (const ws of this.ctx.getWebSockets()) {
			const state = stateOf(ws);
			if (!state || state.authed) continue;
			const deadline = state.connectedAt + AUTH_TIMEOUT_MS;
			if (deadline <= now) safeClose(ws, CLOSE.AUTH_TIMEOUT, "auth timeout");
			else next = Math.min(next, deadline);
		}
		// Wake again when the next buffered update, claim or seen id expires.
		const expiries: Array<[string, number]> = [
			["SELECT MIN(received_at) AS t FROM pending", UPDATE_TTL_MS],
			["SELECT MIN(created_at) AS t FROM routes", ROUTE_TTL_MS],
			["SELECT MIN(at) AS t FROM seen", SEEN_TTL_MS],
		];
		for (const [query, ttl] of expiries) {
			const oldest = this.sql.exec<{ t: number | null }>(query).one().t;
			if (oldest !== null) next = Math.min(next, oldest + ttl);
		}

		if (next !== Infinity) await this.ctx.storage.setAlarm(Math.max(next, now + 1));
	}
}

function stateOf(ws: WebSocket): SocketState | null {
	return (ws.deserializeAttachment() as SocketState | null) ?? null;
}

/** `body` is the raw JSON Telegram sent; it was parsed once already, so it is valid. */
function updateFrame(updateId: number, routed: boolean, body: string): string {
	return `{"type":"update","id":${updateId},"routed":${routed},"update":${body}}`;
}

function sendError(ws: WebSocket, error: string, detail?: string) {
	safeSend(ws, JSON.stringify(detail ? { type: "error", error, detail } : { type: "error", error }));
}

function safeSend(ws: WebSocket, data: string) {
	try {
		ws.send(data);
	} catch {
		// Socket already closing; the update stays buffered until acked or expired.
	}
}

function safeClose(ws: WebSocket, code: number, reason: string) {
	try {
		ws.close(code, reason);
	} catch {
		// Already closed.
	}
}
