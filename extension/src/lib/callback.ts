/**
 * Inline button payload: `c|{accountId}|{action}|{arg}`.
 *
 * The relay reads the accountId from this string when a button is pressed on a
 * message it has no claim for, and routes the press to that profile only.
 * Telegram limits callback_data to 64 bytes.
 */
export type CallbackAction = 'full' | 'check';

export interface CallbackData {
  accountId: string;
  action: string;
  arg: string;
}

export const CALLBACK_MAX_BYTES = 64;
const ACCOUNT_ID = /^[A-Za-z0-9_.:@-]{1,64}$/;

/** Returns the callback_data string, or null if it would exceed 64 bytes. */
export function encodeCallback(accountId: string, action: CallbackAction, arg = ''): string | null {
  if (!ACCOUNT_ID.test(accountId)) throw new Error(`invalid accountId: ${accountId}`);
  const data = `c|${accountId}|${action}|${arg}`;
  return new TextEncoder().encode(data).length <= CALLBACK_MAX_BYTES ? data : null;
}

/** Parses callback_data; null if it is not in our format. `arg` may contain "|". */
export function decodeCallback(data: unknown): CallbackData | null {
  if (typeof data !== 'string') return null;
  const parts = data.split('|');
  if (parts.length < 4 || parts[0] !== 'c') return null;
  const accountId = parts[1]!;
  if (!ACCOUNT_ID.test(accountId)) return null;
  return { accountId, action: parts[2]!, arg: parts.slice(3).join('|') };
}

/**
 * Should this profile handle a button press? A press that the relay
 * broadcast (routed:false) but that names another account belongs to that
 * account, which will get it when it reconnects.
 */
export function isCallbackForMe(data: CallbackData | null, routed: boolean, myAccountId: string): boolean {
  if (!data) return false;
  // routed:true means the relay already picked this profile (claim or accountId).
  if (routed) return true;
  return data.accountId === myAccountId;
}
