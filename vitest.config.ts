import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
	// Only the relay's tests. extension/ has its own Vitest setup (jsdom, not workerd).
	test: { include: ["test/**/*.test.ts"] },
});
