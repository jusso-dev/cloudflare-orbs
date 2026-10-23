import { createClaudeParser } from "./claude-code.ts";
import type { Harness } from "./types.ts";

/**
 * Offline harness for exercising the whole orb pipeline (streaming, approvals,
 * sleep/wake, diffs) without model credentials. It runs a scripted agent that
 * emits Claude Code-shaped events, so it reuses the Claude parser. Gated behind
 * `ENABLE_DEMO_HARNESS` on the Worker.
 */
export const demo: Harness = {
	id: "demo",
	label: "Demo (scripted)",
	provider: "none",
	defaultModels: ["scripted-1"],
	capabilities: { approvals: true, resume: true },

	command(input) {
		return {
			argv: ["node", "/opt/orb/demo-agent.mjs", ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : [])],
			env: { ORB_APPROVAL_MODE: input.approvalMode },
		};
	},

	createParser: createClaudeParser,
};
