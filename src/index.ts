import { MAX_WEBHOOK_BYTES, SECRET_HEADER } from "./constants";
import { ACCOUNT_ID, HEX64, readBodyLimited } from "./util";

// The entry module exports only the fetch handler and the Durable Object
// class. Constants go in ./constants (see the note there).
export { RelayHub } from "./relay";

const HOOK_PATH = /^\/hook\/([^/]+)$/;
const WS_PATH = /^\/ws\/([^/]+)$/;
const BYE_PATH = /^\/bye\/([^/]*)$/;

/**
 * The one page GET /bye shows, whether the code was right or not: a
 * different page would tell an attacker which codes are correct. The URL
 * holds the removal code, so the page loads nothing and sends no referrer.
 */
const BYE_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fiverr Telegram Alerts</title>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
<p>This profile was disconnected. You can close this tab.</p>
</body>
</html>
`;

const BYE_HEADERS = {
	"content-type": "text/html; charset=utf-8",
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
	"x-robots-tag": "noindex",
};

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

		const bye = BYE_PATH.exec(path);
		if (bye) {
			if (request.method !== "GET") return text("method not allowed", 405, { allow: "GET" });
			const botKey = bye[1]!;
			// Malformed input gets the same page as a wrong code (see BYE_PAGE).
			if (HEX64.test(botKey)) {
				const stub = env.RELAY.get(env.RELAY.idFromName(botKey));
				const status = await stub.handleBye(url.searchParams.get("accountId") ?? "", url.searchParams.get("code") ?? "");
				if (status === 429) return text("Too many requests. Try again in a minute.", 429, { "retry-after": "60", "cache-control": "no-store" });
			}
			return new Response(BYE_PAGE, { status: 200, headers: BYE_HEADERS });
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
