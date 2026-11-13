/** Lowercase hex SHA-256 digest: botKey and secret both have this shape. */
export const HEX64 = /^[0-9a-f]{64}$/;

/** accountId is chosen by the extension (Fiverr username or similar). */
export const ACCOUNT_ID = /^[A-Za-z0-9_.:@-]{1,64}$/;

export const MAX_LABEL_LENGTH = 64;

const encoder = new TextEncoder();

export async function sha256(input: string): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
	return new Uint8Array(digest);
}

export function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

export function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/**
 * Constant-time comparison. Both inputs are always SHA-256 digests (32 bytes),
 * so the length check leaks nothing about the secret.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const subtle = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
	};
	if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
	let diff = 0;
	for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

/**
 * Reads a request body but gives up (returns null) as soon as it grows past
 * `limit` bytes, so an oversized body is never fully buffered.
 */
export async function readBodyLimited(request: Request, limit: number): Promise<Uint8Array | null> {
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/** Trims a label and strips control characters. Returns "" for non-strings. */
export function cleanLabel(value: unknown): string {
	if (typeof value !== "string") return "";
	// eslint-disable-next-line no-control-regex
	return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_LABEL_LENGTH);
}
