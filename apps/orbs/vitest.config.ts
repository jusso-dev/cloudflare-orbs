import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests do not boot the Cloudflare plugin.
export default defineConfig({
	test: { include: ["test/**/*.test.ts"], environment: "node" },
});
