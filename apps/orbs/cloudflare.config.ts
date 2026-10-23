import { bindings, defineConfig, defineContainer, defineWorker, exports } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

/**
 * Deployment settings come from the environment `cf` runs in, with safe defaults,
 * so the file never contains an account id or a credential.
 *
 *   AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID   AI Gateway the agents call through
 *   ACCESS_TEAM_DOMAIN, ACCESS_AUD         Cloudflare Access (optional; otherwise AUTH_TOKEN)
 *   IMAGE_VERSION                          bump when container/ changes so old snapshots are not restored
 */
declare const process: { env: Record<string, string | undefined> };
const env = (name: string, fallback: string) => process.env[name] ?? fallback;

const WORKER_NAME = env("ORBS_WORKER_NAME", "cloudflare-orbs");

const workspace = defineContainer({
	name: `${WORKER_NAME}-workspace`,
	// The Durable Object chooses the image, size, network access and lifetime of each container.
	schedulingPolicy: "durable-object",
	images: {
		workspace: { dockerfile: "../../container/Dockerfile" },
	},
	observability: { enabled: true },
});

// Declared first so the Durable Object bindings below can reference its exports (this is what
// gives `env.ORB` its typed RPC methods).
const core = defineWorker({
	name: WORKER_NAME,
	compatibilityDate: "2026-10-23",
	compatibilityFlags: ["nodejs_compat"],
	entrypoint,
	exports: {
		Orb: exports.durableObject({ storage: "sqlite", container: workspace }),
		UserHub: exports.durableObject({ storage: "sqlite" }),
	},
});

const worker = defineWorker({
	...core,
	// The React app is static assets; only /api/* runs Worker code.
	assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] },
	env: {
		ORB: bindings.durableObject({ worker: core, exportName: "Orb" as const }),
		USER_HUB: bindings.durableObject({ worker: core, exportName: "UserHub" as const }),
		// Recovery patches for rebuilding a workspace when its snapshot is gone.
		ARTIFACTS: bindings.r2({ name: env("ORBS_ARTIFACTS_BUCKET", "orbs-artifacts") }),

		// Secrets: `cf secrets` / .dev.vars locally. None of these ever enter a container.
		AI_GATEWAY_TOKEN: bindings.secret(),
		GITHUB_TOKEN: bindings.secret(),
		SESSION_SECRET: bindings.secret(),
		AUTH_TOKEN: bindings.secret(),

		AI_GATEWAY_ACCOUNT_ID: bindings.text(env("AI_GATEWAY_ACCOUNT_ID", "REPLACE_WITH_ACCOUNT_ID")),
		AI_GATEWAY_ID: bindings.text(env("AI_GATEWAY_ID", "default")),
		ACCESS_TEAM_DOMAIN: bindings.text(env("ACCESS_TEAM_DOMAIN", "")),
		ACCESS_AUD: bindings.text(env("ACCESS_AUD", "")),
		CLAUDE_CODE_MODELS: bindings.text(env("CLAUDE_CODE_MODELS", "")),
		CODEX_MODELS: bindings.text(env("CODEX_MODELS", "")),
		ENABLE_DEMO_HARNESS: bindings.text(env("ENABLE_DEMO_HARNESS", "false")),
		MAX_CONCURRENT_ORBS: bindings.text(env("MAX_CONCURRENT_ORBS", "5")),
		IDLE_SLEEP_MINUTES: bindings.text(env("IDLE_SLEEP_MINUTES", "10")),
		DEFAULT_MAX_COST_USD: bindings.text(env("DEFAULT_MAX_COST_USD", "10")),
		DEFAULT_MAX_RUNTIME_MINUTES: bindings.text(env("DEFAULT_MAX_RUNTIME_MINUTES", "240")),
		EXTRA_ALLOWED_HOSTS: bindings.text(env("EXTRA_ALLOWED_HOSTS", "")),
		IMAGE_VERSION: bindings.text(env("IMAGE_VERSION", "1")),
	},
});

export default defineConfig({ worker, containers: [workspace] });
