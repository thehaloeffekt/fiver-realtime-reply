/** hex(SHA-256(input)) */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The two values the relay knows the bot by. The token itself never leaves for the relay. */
export async function deriveRelayKeys(token: string): Promise<{ botKey: string; secret: string }> {
  const [botKey, secret] = await Promise.all([sha256Hex(`fta-key:${token}`), sha256Hex(`fta-secret:${token}`)]);
  return { botKey, secret };
}

/** Random 8-character accountId from [a-z0-9]. */
export function newAccountId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  // 256 % 36 != 0 introduces a tiny bias; irrelevant for an identifier.
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** 32 random bytes as hex: the removal code. */
export function newRemovalCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Chrome refuses a longer uninstall URL (older versions, before 2023, allowed 255; ours fits either way with the default relay). */
export const MAX_UNINSTALL_URL_CHARS = 1023;

/**
 * The page Chrome opens after an uninstall: GET /bye on the relay. It holds
 * the botKey, the accountId and the removal code, which together can remove
 * this one account and nothing else. Never the bot token or the secret: this
 * URL ends up in browser history. Null when it would be too long for Chrome.
 */
export function uninstallUrl(relayUrl: string, botKey: string, accountId: string, removalCode: string): string | null {
  const url = `${relayUrl.trim().replace(/\/+$/, '')}/bye/${botKey}?accountId=${encodeURIComponent(accountId)}&code=${encodeURIComponent(removalCode)}`;
  return url.length <= MAX_UNINSTALL_URL_CHARS ? url : null;
}

/** https://host/path → wss://host/path (http → ws). Trailing slashes removed. */
export function relayWsBase(relayUrl: string): string {
  return relayUrl.trim().replace(/\/+$/, '').replace(/^http(s?):\/\//i, (_, s) => `ws${s}://`);
}
