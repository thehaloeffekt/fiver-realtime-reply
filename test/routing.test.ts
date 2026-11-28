import { describe, expect, it } from "vitest";
import { accountOfCallbackData, BROADCAST, callbackAccountOf, keyboardAccountOf, targetFor } from "../src/routing";

const CHAT = { id: 4242 };
const bot = { id: 1000, is_bot: true, first_name: "Alerts" };
const user = { id: 2000, is_bot: false, first_name: "Tester" };
const buttons = (...data: unknown[]) => ({ inline_keyboard: [data.map((d) => ({ text: "b", callback_data: d }))] });

const reply = (replied: unknown, text = "Hello from a test", field = "message") => ({
	update_id: 1,
	[field]: { message_id: 2, chat: CHAT, from: user, text, reply_to_message: replied },
});

describe("accountOfCallbackData", () => {
	it("reads c|accountId|action|arg and nothing else", () => {
		expect(accountOfCallbackData("c|acc-b|full|x")).toBe("acc-b");
		expect(accountOfCallbackData("c|acc-b|open|")).toBe("acc-b");
		expect(accountOfCallbackData("c|acc-b|reply|a|b")).toBe("acc-b");
		for (const bad of ["c|acc-b|full", "x|acc-b|full|x", "c|bad id!|x|y", "c||x|y", "", 5, null, undefined, {}]) {
			expect(accountOfCallbackData(bad)).toBeNull();
		}
	});

	it("is what callbackAccountOf uses", () => {
		expect(callbackAccountOf({ callback_query: { data: "c|acc-b|full|x" } })).toBe("acc-b");
		expect(callbackAccountOf({ callback_query: { data: "open|1" } })).toBeNull();
		expect(callbackAccountOf({ callback_query: "weird" })).toBeNull();
	});
});

describe("keyboardAccountOf", () => {
	it("returns the first of our buttons, scanning rows in order", () => {
		const message = {
			reply_markup: {
				inline_keyboard: [
					[{ text: "Link", url: "https://example.com" }, { text: "Other", callback_data: "open|1" }],
					[{ text: "B", callback_data: "c|acc-b|full|x" }, { text: "A", callback_data: "c|acc-a|full|x" }],
				],
			},
		};
		expect(keyboardAccountOf(message)).toBe("acc-b");
	});

	it("never throws on odd shapes", () => {
		for (const markup of [undefined, null, 5, "x", [], {}, { inline_keyboard: "x" }, { inline_keyboard: [null, 1, "x", [null, 2, []]] }]) {
			expect(keyboardAccountOf({ reply_markup: markup })).toBeNull();
		}
		expect(keyboardAccountOf(null)).toBeNull();
	});
});

describe("targetFor: replies", () => {
	it("a claim decides a plain reply", () => {
		expect(targetFor(reply({ message_id: 3, chat: CHAT, from: bot, reply_markup: buttons("c|acc-b|full|x") }), "acc-a")).toBe("acc-a");
	});

	it("an unclaimed reply to a bot message uses its buttons, else everyone", () => {
		expect(targetFor(reply({ message_id: 3, from: bot, reply_markup: buttons("c|acc-b|full|x") }), null)).toBe("acc-b");
		expect(targetFor(reply({ message_id: 3, from: bot, reply_markup: buttons("open|1") }), null)).toBe(BROADCAST);
		expect(targetFor(reply({ message_id: 3, from: bot }), null)).toBe(BROADCAST);
	});

	it("applies to every message kind", () => {
		for (const field of ["message", "edited_message", "channel_post", "edited_channel_post", "business_message", "edited_business_message"]) {
			const replied = { message_id: 3, from: bot, reply_markup: buttons("c|acc-b|full|x") };
			expect(targetFor(reply(replied, "Hello from a test", field), null)).toBe("acc-b");
		}
	});

	it("drops an unclaimed reply to a non-bot message, and a message that replies to nothing", () => {
		const marked = buttons("c|acc-b|full|x");
		expect(targetFor(reply({ message_id: 3, from: user, reply_markup: marked }), null)).toBeNull();
		expect(targetFor(reply({ message_id: 3, reply_markup: marked }), null)).toBeNull();
		expect(targetFor(reply({ message_id: 3, from: { is_bot: 1 }, reply_markup: marked }), null)).toBeNull();
		expect(targetFor(reply({ message_id: 3, from: "bot", reply_markup: marked }), null)).toBeNull();
		expect(targetFor(reply("not an object"), null)).toBeNull();
		expect(targetFor({ update_id: 1, message: { message_id: 2, chat: CHAT, text: "Hello from a test" } }, null)).toBeNull();
	});

	it("a command is broadcast even as a reply to a claimed or marked alert", () => {
		const replied = { message_id: 3, from: bot, reply_markup: buttons("c|acc-b|full|x") };
		expect(targetFor(reply(replied, "/reply test_buyer_one"), "acc-a")).toBe(BROADCAST);
		expect(targetFor(reply(replied, "/status"), null)).toBe(BROADCAST);
	});

	it("leaves unclaimed reactions and inline results dropped", () => {
		expect(targetFor({ update_id: 1, message_reaction: { chat: CHAT, message_id: 3 } }, null)).toBeNull();
		expect(targetFor({ update_id: 1, chosen_inline_result: { inline_message_id: "x" } }, null)).toBeNull();
	});
});
