import type { HarnessId, HarnessInfo } from "@orbs/protocol";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { demo } from "./demo.ts";
import type { Harness } from "./types.ts";

export type {
	EventParser,
	Harness,
	HarnessCommand,
	HarnessRunInput,
	ParsedLine,
	Provider,
	TurnResult,
} from "./types.ts";
export { claudeCode, createClaudeParser } from "./claude-code.ts";
export { codex, createCodexParser } from "./codex.ts";
export { demo } from "./demo.ts";
export { clip, MAX_OUTPUT_CHARS, MAX_TEXT_CHARS } from "./util.ts";

/**
 * Adding a harness: implement `Harness` (command + event parser), register it
 * here, and install its CLI in container/Dockerfile.
 */
const REGISTRY: Record<HarnessId, Harness> = {
	"claude-code": claudeCode,
	codex,
	demo,
};

export function getHarness(id: HarnessId): Harness {
	return REGISTRY[id];
}

export interface HarnessCatalogOptions {
	/** Comma-separated model allowlists keyed by harness id; the first entry is the default. */
	models?: Partial<Record<HarnessId, string>>;
	demoEnabled?: boolean;
}

export function listHarnesses(options: HarnessCatalogOptions = {}): HarnessInfo[] {
	return (Object.values(REGISTRY) as Harness[])
		.filter((harness) => harness.id !== "demo" || options.demoEnabled)
		.map((harness) => {
			const configured = options.models?.[harness.id]
				?.split(",")
				.map((model) => model.trim())
				.filter(Boolean);
			const models = configured?.length ? configured : harness.defaultModels;
			return {
				id: harness.id,
				label: harness.label,
				models,
				defaultModel: models[0] ?? harness.defaultModels[0] ?? "",
				capabilities: harness.capabilities,
			};
		});
}
