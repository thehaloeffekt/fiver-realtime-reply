import { MAX_WEBHOOK_BYTES, SECRET_HEADER } from "./constants";
import { ACCOUNT_ID, HEX64, readBodyLimited } from "./util";

// The entry module exports only the fetch handler and the Durable Object
// class. Constants go in ./constants (see the note there).
export { RelayHub } from "./relay";

const HOOK_PATH = /^\/hook\/([^/]+)$/;
const WS_PATH = /^\/ws\/([^/]+)$/;

function text(body: string, status: number, headers?: HeadersInit): Response {
	return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === "/health") {
			if (request.method !== "GET" && request.method !== "HEAD") return text("method not allowed", 405, { allow: "GET" });
			return text("ok", 200);
		}

		const hook = HOOK_PATH.exec(path);
		if (hook) {
			if (request.method !== "POST") return text("method not allowed", 405, { allow: "POST" });
			const botKey = hook[1]!;
			if (!HEX64.test(botKey)) return text("not found", 404);
			const declared = Number(request.headers.get("content-length") ?? "0");
			if (!Number.isFinite(declared) || declared > MAX_WEBHOOK_BYTES) return text("payload too large", 413);
			const bytes = await readBodyLimited(request, MAX_WEBHOOK_BYTES);
			if (!bytes) return text("payload too large", 413);
			let body: string;
			try {
				body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
			} catch {
				return text("bad request", 400);
			}
			const stub = env.RELAY.get(env.RELAY.idFromName(botKey));
			const status = await stub.handleWebhook(request.headers.get(SECRET_HEADER), body);
			return new Response(null, { status });
		}

		const ws = WS_PATH.exec(path);
		if (ws) {
			if (request.method !== "GET") return text("method not allowed", 405, { allow: "GET" });
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return text("expected websocket", 426);
			const botKey = ws[1]!;
			if (!HEX64.test(botKey)) return text("not found", 404);
			if (!ACCOUNT_ID.test(url.searchParams.get("accountId") ?? "")) return text("bad accountId", 400);
			return env.RELAY.get(env.RELAY.idFromName(botKey)).fetch(request);
		}

		return text("not found", 404);
	},
} satisfies ExportedHandler<Env>;
