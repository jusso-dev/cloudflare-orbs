import type { Budget, HarnessId } from "@orbs/protocol";

export const GATEWAY_HOST = "gateway.ai.cloudflare.com";

export interface Settings {
	/** AI Gateway root, e.g. https://gateway.ai.cloudflare.com/v1/<account>/<gateway> */
	gatewayUrl: string;
	gatewayPath: string;
	maxConcurrentOrbs: number;
	idleSleepMs: number;
	defaultBudget: Budget;
	extraAllowedHosts: string[];
	/** Bumped when the container image changes; older snapshots are then not restored. */
	imageVersion: string;
	demoEnabled: boolean;
	models: Partial<Record<HarnessId, string>>;
}

function positiveNumber(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositive(value: string | undefined): number | undefined {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function readSettings(env: Env): Settings {
	const gatewayPath = `/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}`;
	return {
		gatewayUrl: `https://${GATEWAY_HOST}${gatewayPath}`,
		gatewayPath,
		maxConcurrentOrbs: Math.floor(positiveNumber(env.MAX_CONCURRENT_ORBS, 5)),
		idleSleepMs: positiveNumber(env.IDLE_SLEEP_MINUTES, 10) * 60_000,
		defaultBudget: {
			maxCostUsd: optionalPositive(env.DEFAULT_MAX_COST_USD),
			maxRuntimeMinutes: optionalPositive(env.DEFAULT_MAX_RUNTIME_MINUTES),
		},
		extraAllowedHosts: (env.EXTRA_ALLOWED_HOSTS ?? "")
			.split(",")
			.map((host: string) => host.trim().toLowerCase())
			.filter(Boolean),
		imageVersion: env.IMAGE_VERSION,
		demoEnabled: env.ENABLE_DEMO_HARNESS === "true",
		models: {
			"claude-code": env.CLAUDE_CODE_MODELS || undefined,
			codex: env.CODEX_MODELS || undefined,
		},
	};
}
