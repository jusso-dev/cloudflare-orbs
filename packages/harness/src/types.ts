import type {
	ApprovalMode,
	HarnessId,
	HarnessInfo,
	OrbEvent,
	TokenUsage,
} from "@orbs/protocol";

export type Provider = "anthropic" | "openai" | "none";

export interface HarnessRunInput {
	/** The prompt itself is fed through stdin by the runner, never through argv. */
	model: string;
	approvalMode: ApprovalMode;
	/** Session to resume. Only set when the harness supports it and the session is known to exist. */
	resumeSessionId?: string;
	/** AI Gateway root, e.g. https://gateway.ai.cloudflare.com/v1/<account>/<gateway> */
	gatewayUrl: string;
	/** Directory for harness-specific per-turn files. */
	taskDir: string;
	maxBudgetUsd?: number;
}

export interface HarnessCommand {
	argv: string[];
	env: Record<string, string>;
}

export interface TurnResult {
	outcome: "succeeded" | "failed";
	result?: string;
	error?: string;
	costUsd?: number;
	usage?: TokenUsage;
}

export interface ParsedLine {
	/** Persisted, replayable events. */
	events: OrbEvent[];
	/** Ephemeral text deltas for live typing. */
	deltas: string[];
	/** Harness session identifier, when the line carries one. */
	sessionId?: string;
	/** Present on the line that ends the turn. */
	result?: TurnResult;
}

export interface EventParser {
	parse(line: string): ParsedLine;
	/**
	 * Called once the agent process has exited. Returns a result only when the
	 * stream never produced one (crash, kill, malformed output).
	 */
	finish(exitCode: number, stderrTail: string): TurnResult | undefined;
}

export interface Harness {
	id: HarnessId;
	label: string;
	provider: Provider;
	defaultModels: string[];
	capabilities: HarnessInfo["capabilities"];
	command(input: HarnessRunInput): HarnessCommand;
	createParser(): EventParser;
}
