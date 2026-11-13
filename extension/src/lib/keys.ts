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

/** https://host/path → wss://host/path (http → ws). Trailing slashes removed. */
export function relayWsBase(relayUrl: string): string {
  return relayUrl.trim().replace(/\/+$/, '').replace(/^http(s?):\/\//i, (_, s) => `ws${s}://`);
}
