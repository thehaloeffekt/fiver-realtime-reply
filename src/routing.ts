/**
 * Routing: which extension instance (accountId) should get a Telegram update.
 *
 * The relay cannot read Telegram history, so it learns ownership from the
 * extensions themselves. After an extension sends a message to Telegram it
 * reports the resulting (chat_id, message_id) with a "claim". Later updates
 * that point at that message — a reply, an inline-button press, a reaction —
 * go to the account that claimed it. Everything else (plain messages,
 * commands) is "unrouted" and goes to every connected instance.
 */

export interface RouteKey {
	/** Telegram chat id as a decimal string, or "inline" for inline messages. */
	chat: string;
	/** Telegram message_id as a decimal string, or the inline_message_id. */
	message: string;
}

export const INLINE_CHAT = "inline";

const CHAT_ID = /^-?\d{1,20}$/;
const INLINE_MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function chatIdOf(value: unknown): string | null {
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	if (typeof value === "string" && CHAT_ID.test(value)) return value;
	return null;
}

function messageIdOf(value: unknown): string | null {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
	if (typeof value === "string" && /^\d{1,15}$/.test(value) && Number(value) > 0) return value;
	return null;
}

function inlineIdOf(value: unknown): string | null {
	return typeof value === "string" && INLINE_MESSAGE_ID.test(value) ? value : null;
}

function keyOfMessage(message: Json | null, idField = "message_id"): RouteKey | null {
	if (!message) return null;
	const chat = chatIdOf(obj(message.chat)?.id);
	const id = messageIdOf(message[idField]);
	return chat && id ? { chat, message: id } : null;
}

/** Message types whose `reply_to_message` decides the route. */
const MESSAGE_FIELDS = [
	"message",
	"edited_message",
	"channel_post",
	"edited_channel_post",
	"business_message",
	"edited_business_message",
] as const;

/** Returns the claimed message this update refers to, or null if unrouted. */
export function routeKeyOf(update: Json): RouteKey | null {
	const callback = obj(update.callback_query);
	if (callback) {
		const key = keyOfMessage(obj(callback.message));
		if (key) return key;
		const inline = inlineIdOf(callback.inline_message_id);
		return inline ? { chat: INLINE_CHAT, message: inline } : null;
	}

	for (const field of MESSAGE_FIELDS) {
		const message = obj(update[field]);
		if (!message) continue;
		const reply = obj(message.reply_to_message);
		if (!reply) return null;
		// The reply_to_message object can omit `chat` in some update kinds;
		// a reply is always in the same chat as the message itself.
		const chat = chatIdOf(obj(reply.chat)?.id) ?? chatIdOf(obj(message.chat)?.id);
		const id = messageIdOf(reply.message_id);
		return chat && id ? { chat, message: id } : null;
	}

	const reaction = obj(update.message_reaction) ?? obj(update.message_reaction_count);
	if (reaction) return keyOfMessage(reaction);

	const chosen = obj(update.chosen_inline_result);
	if (chosen) {
		const inline = inlineIdOf(chosen.inline_message_id);
		return inline ? { chat: INLINE_CHAT, message: inline } : null;
	}

	return null;
}

/** Parses one claim item sent by an extension. */
export function parseClaim(value: unknown): RouteKey | null {
	const item = obj(value);
	if (!item) return null;
	if (item.inlineMessageId !== undefined) {
		const inline = inlineIdOf(item.inlineMessageId);
		return inline ? { chat: INLINE_CHAT, message: inline } : null;
	}
	const chat = chatIdOf(item.chatId);
	const message = messageIdOf(item.messageId);
	return chat && message ? { chat, message } : null;
}
