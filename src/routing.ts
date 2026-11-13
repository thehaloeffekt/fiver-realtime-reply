/**
 * Routing: which extension instance (accountId) should get a Telegram update.
 *
 * The relay cannot read Telegram history, so it learns ownership from the
 * extensions themselves. After an extension sends a message to Telegram it
 * reports the resulting (chat_id, message_id) with a "claim". Later updates
 * that point at that message — a reply, an inline-button press, a reaction —
 * go to the account that claimed it. `targetFor` applies the full rule set.
 */

import { ACCOUNT_ID } from "./util";

/** Target meaning "every connected instance". */
export const BROADCAST = "*";

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

/**
 * Fallback for button presses: the extension writes the owning account into
 * every button as `c|{accountId}|{action}|{arg}`. Returns that accountId, or
 * null when the data does not have this shape.
 */
export function callbackAccountOf(update: Json): string | null {
	const data = obj(update.callback_query)?.data;
	if (typeof data !== "string") return null;
	const parts = data.split("|");
	// `arg` may be empty and may itself contain "|", so require at least 4 parts.
	if (parts.length < 4 || parts[0] !== "c") return null;
	const accountId = parts[1]!;
	return ACCOUNT_ID.test(accountId) ? accountId : null;
}

/** The message-like object of an update (message, edited_message, …), if any. */
function messageOf(update: Json): Json | null {
	for (const field of MESSAGE_FIELDS) {
		const message = obj(update[field]);
		if (message) return message;
	}
	return null;
}

/** True for a bot command such as "/start" or "/check@MyBot arg". */
export function isCommand(update: Json): boolean {
	const text = messageOf(update)?.text;
	return typeof text === "string" && text.startsWith("/");
}

/**
 * Decides where an update goes.
 *
 * @param claimedBy the account that claimed the message this update refers
 *   to (from `routeKeyOf` + the routes table), or null.
 * @returns an accountId, BROADCAST, or null to drop the update.
 */
export function targetFor(update: Json, claimedBy: string | null): string | null {
	// 1. Commands are for every profile, even when sent as a reply.
	if (isCommand(update)) return BROADCAST;
	// 2. A claimed message decides.
	if (claimedBy) return claimedBy;
	// 3. Unclaimed button press: the account written into callback_data, else everyone.
	if (update.callback_query !== undefined) return callbackAccountOf(update) ?? BROADCAST;
	// 4. Unclaimed messages and things that point at a message (reactions,
	//    inline results) cannot be attributed to a profile: drop them.
	if (
		messageOf(update) ||
		update.message_reaction !== undefined ||
		update.message_reaction_count !== undefined ||
		update.chosen_inline_result !== undefined
	) {
		return null;
	}
	// 5. Anything else (my_chat_member when the bot is blocked, …) concerns the
	//    bot as a whole, so every profile hears about it.
	return BROADCAST;
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
