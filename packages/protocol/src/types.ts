// ---------------------------------------------------------------------------
// Identifiers & enums
// ---------------------------------------------------------------------------

export const HARNESS_IDS = ["claude-code", "codex", "demo"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const INSTANCE_TYPES = [
	"lite",
	"standard-1",
	"standard-2",
	"standard-3",
	"standard-4",
] as const;
export type InstanceType = (typeof INSTANCE_TYPES)[number];

export const APPROVAL_MODES = ["auto", "ask"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const NETWORK_POLICIES = ["strict", "packages"] as const;
export type NetworkPolicy = (typeof NETWORK_POLICIES)[number];

export const ORB_STATUSES = [
	"provisioning", // container starting / repo cloning
	"idle", // container awake, nothing running
	"running", // agent turn in progress
	"awaiting_approval", // agent blocked on a human decision
	"sleeping", // container stopped, filesystem snapshotted, zero cost
	"failed", // last turn / provisioning failed (send a message to retry)
	"budget_exceeded", // stopped by a cost control
	"archived", // deleted by the user
] as const;
export type OrbStatus = (typeof ORB_STATUSES)[number];

/** Statuses in which the container is (or is about to be) running and costing money. */
export const AWAKE_STATUSES: readonly OrbStatus[] = [
	"provisioning",
	"idle",
	"running",
	"awaiting_approval",
];

export const ORB_ID_PATTERN = /^[a-z0-9]{12}$/;

// ---------------------------------------------------------------------------
// GitHub repo helpers
// ---------------------------------------------------------------------------

const REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export interface GitHubRepo {
	owner: string;
	name: string;
}

export function parseGitHubRepo(url: string): GitHubRepo | null {
	const match = REPO_URL.exec(url.trim());
	if (!match) return null;
	const [, owner, name] = match;
	if (!owner || !name || name === "." || name === "..") return null;
	return { owner, name };
}

// ---------------------------------------------------------------------------
// Budgets & usage
// ---------------------------------------------------------------------------

export interface Budget {
	maxCostUsd?: number;
	/** Total wall-clock minutes the container may be awake over the orb's life. */
	maxRuntimeMinutes?: number;
}

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
}

export interface OrbUsage extends TokenUsage {
	costUsd: number;
	turns: number;
	/** Seconds the container has been awake (sum over all container sessions). */
	containerSeconds: number;
}

export const EMPTY_USAGE: OrbUsage = {
	costUsd: 0,
	inputTokens: 0,
	outputTokens: 0,
	cachedTokens: 0,
	turns: 0,
	containerSeconds: 0,
};

// ---------------------------------------------------------------------------
// Orb summary (thread list + header)
// ---------------------------------------------------------------------------

export interface OrbSummary {
	id: string;
	title: string;
	repoUrl: string;
	ref?: string;
	harness: HarnessId;
	model: string;
	approvalMode: ApprovalMode;
	networkPolicy: NetworkPolicy;
	instance: InstanceType;
	status: OrbStatus;
	statusReason?: string;
	createdAt: number;
	updatedAt: number;
	lastActivityAt: number;
	budget: Budget;
	usage: OrbUsage;
	branch?: string;
	prUrl?: string;
	hasSnapshot: boolean;
	/** Unix ms of the next scheduled wake-up, if any. */
	nextWakeAt?: number;
}

// ---------------------------------------------------------------------------
// Events (the persisted, replayable conversation log)
// ---------------------------------------------------------------------------

export type TurnOutcome = "succeeded" | "failed" | "interrupted" | "lost";

export type ApprovalDecision = "allow" | "deny" | "allow_always";

export type OrbEvent =
	| { kind: "user_message"; text: string; scheduled?: boolean }
	| { kind: "agent_message"; text: string }
	| { kind: "reasoning"; text: string }
	| { kind: "tool_call"; toolId: string; name: string; input: unknown }
	| {
			kind: "tool_result";
			toolId: string;
			output: string;
			isError: boolean;
			truncated?: boolean;
	  }
	| { kind: "file_change"; path: string; change: "add" | "update" | "delete" }
	| { kind: "turn_started"; turnId: string; idx: number; model: string }
	| {
			kind: "turn_finished";
			turnId: string;
			outcome: TurnOutcome;
			result?: string;
			error?: string;
			costUsd?: number;
			usage?: TokenUsage;
			durationMs?: number;
	  }
	| {
			kind: "approval_requested";
			approvalId: string;
			toolName: string;
			input: unknown;
			toolUseId?: string;
	  }
	| {
			kind: "approval_resolved";
			approvalId: string;
			decision: ApprovalDecision | "expired";
	  }
	| { kind: "status"; status: OrbStatus; reason?: string }
	| { kind: "system"; level: "info" | "warn" | "error"; message: string };

export type OrbEventKind = OrbEvent["kind"];

export interface EventRecord {
	seq: number;
	ts: number;
	turnId?: string;
	event: OrbEvent;
}

export interface PendingApproval {
	approvalId: string;
	toolName: string;
	input: unknown;
	toolUseId?: string;
	turnId?: string;
	createdAt: number;
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

export type ServerMessage =
	| {
			type: "hello";
			orb: OrbSummary;
			lastSeq: number;
			pendingApprovals: PendingApproval[];
	  }
	| { type: "events"; records: EventRecord[] }
	| { type: "event"; record: EventRecord }
	/** Ephemeral token stream. Never persisted; the full text arrives later as an `agent_message` event. */
	| { type: "delta"; turnId: string; text: string }
	| { type: "orb"; orb: OrbSummary }
	| { type: "pong" }
	| { type: "error"; message: string };

export type ClientMessage =
	| { type: "hello"; lastSeq: number }
	| { type: "message"; text: string }
	| { type: "approve"; approvalId: string; decision: ApprovalDecision }
	| { type: "interrupt" }
	| { type: "ping" };

/** Messages on the per-user "hub" socket that keeps the thread list live. */
export type HubServerMessage =
	| { type: "orbs"; orbs: OrbSummary[] }
	| { type: "orb"; orb: OrbSummary }
	| { type: "removed"; id: string }
	| { type: "pong" };

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

export interface CreateOrbRequest {
	repoUrl: string;
	ref?: string;
	prompt: string;
	title?: string;
	harness: HarnessId;
	model?: string;
	approvalMode: ApprovalMode;
	networkPolicy: NetworkPolicy;
	instance: InstanceType;
	budget?: Budget;
}

export interface HarnessInfo {
	id: HarnessId;
	label: string;
	models: string[];
	defaultModel: string;
	capabilities: { approvals: boolean; resume: boolean };
}

export interface AppConfig {
	user: { id: string; label: string };
	harnesses: HarnessInfo[];
	instances: InstanceType[];
	limits: {
		maxConcurrentOrbs: number;
		defaultBudget: Budget;
		idleSleepMinutes: number;
	};
}

export interface DiffResponse {
	diff: string;
	truncated: boolean;
	baseRef?: string;
}

export interface UsageResponse {
	total: OrbUsage;
	orbs: Array<{ id: string; title: string; status: OrbStatus; usage: OrbUsage }>;
	awakeOrbs: number;
	maxConcurrentOrbs: number;
}

export interface EventsPage {
	records: EventRecord[];
	lastSeq: number;
	hasMore: boolean;
}

export interface WsTicketResponse {
	ticket: string;
	expiresAt: number;
}

export interface ApiError {
	error: string;
	code?: string;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export function isAwake(status: OrbStatus): boolean {
	return AWAKE_STATUSES.includes(status);
}

/** Derive a short title from the first prompt. */
export function titleFromPrompt(prompt: string): string {
	const firstLine = prompt.trim().split("\n", 1)[0] ?? "";
	const collapsed = firstLine.replace(/\s+/g, " ").trim();
	return collapsed.length > 72 ? `${collapsed.slice(0, 69)}…` : collapsed || "Untitled orb";
}

export function addUsage(a: OrbUsage, b: Partial<OrbUsage>): OrbUsage {
	return {
		costUsd: a.costUsd + (b.costUsd ?? 0),
		inputTokens: a.inputTokens + (b.inputTokens ?? 0),
		outputTokens: a.outputTokens + (b.outputTokens ?? 0),
		cachedTokens: a.cachedTokens + (b.cachedTokens ?? 0),
		turns: a.turns + (b.turns ?? 0),
		containerSeconds: a.containerSeconds + (b.containerSeconds ?? 0),
	};
}
