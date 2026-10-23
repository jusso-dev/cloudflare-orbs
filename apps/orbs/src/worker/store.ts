import type {
	ApprovalDecision,
	Budget,
	EventRecord,
	OrbEvent,
	OrbStatus,
	OrbUsage,
	PendingApproval,
	TokenUsage,
} from "@orbs/protocol";
import type { OrbConfig } from "./types.ts";

type Row = Record<string, string | number | null | ArrayBuffer>;

/** The slice of Durable Object SQLite storage this store needs (also satisfied by a node:sqlite adapter in tests). */
export interface SqlLike {
	exec(query: string, ...bindings: any[]): { toArray(): Row[]; one(): Row };
}

export interface KvLike {
	get<T = unknown>(key: string): T | undefined;
	put(key: string, value: unknown): void;
	delete(key: string): boolean;
}

export type TurnStatus =
	| "queued"
	| "starting"
	| "running"
	| "succeeded"
	| "failed"
	| "interrupted"
	| "lost";

export interface TurnRow {
	id: string;
	idx: number;
	prompt: string;
	scheduled: boolean;
	status: TurnStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Bytes of the agent's event file already ingested. */
	offset: number;
	sessionId?: string;
	costUsd: number;
	usage: TokenUsage;
	error?: string;
	result?: string;
	/** Set once the agent emitted its terminal result line. */
	resultSeen: boolean;
	interruptRequestedAt?: number;
}

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";

export interface ApprovalRow {
	id: string;
	turnId?: string;
	toolUseId?: string;
	toolName: string;
	input: unknown;
	status: ApprovalStatus;
	note?: string;
	createdAt: number;
	resolvedAt?: number;
}

export interface ScheduledRow {
	id: string;
	runAt: number;
	text: string;
	status: "pending" | "sent" | "skipped";
}

export interface SnapshotRow {
	id: string;
	createdAt: number;
	size: number;
	imageVersion: string;
	reason: string;
}

/** Mutable singleton state, kept in the sync KV store. */
export interface OrbState {
	status: OrbStatus;
	statusReason?: string;
	updatedAt: number;
	lastActivityAt: number;
	/** Commit the workspace was cloned at. Recovery patches are diffs against it. */
	baseCommit?: string;
	baseRef?: string;
	branch?: string;
	prUrl?: string;
	/** Tool names the user chose to always allow for this orb. */
	autoAllow: string[];
	/** False when the workspace was rebuilt from git and the agent's session files are gone. */
	sessionValid: boolean;
}

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS events (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		ts INTEGER NOT NULL,
		turn_id TEXT,
		kind TEXT NOT NULL,
		data TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS turns (
		id TEXT PRIMARY KEY,
		idx INTEGER NOT NULL,
		prompt TEXT NOT NULL,
		scheduled INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		started_at INTEGER,
		finished_at INTEGER,
		offset INTEGER NOT NULL DEFAULT 0,
		session_id TEXT,
		cost_usd REAL NOT NULL DEFAULT 0,
		input_tokens INTEGER NOT NULL DEFAULT 0,
		output_tokens INTEGER NOT NULL DEFAULT 0,
		cached_tokens INTEGER NOT NULL DEFAULT 0,
		error TEXT,
		result TEXT,
		result_seen INTEGER NOT NULL DEFAULT 0,
		interrupt_requested_at INTEGER
	)`,
	`CREATE INDEX IF NOT EXISTS turns_status ON turns(status)`,
	`CREATE TABLE IF NOT EXISTS approvals (
		id TEXT PRIMARY KEY,
		turn_id TEXT,
		tool_use_id TEXT,
		tool_name TEXT NOT NULL,
		input TEXT NOT NULL,
		status TEXT NOT NULL,
		note TEXT,
		created_at INTEGER NOT NULL,
		resolved_at INTEGER
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS approvals_tool_use ON approvals(tool_use_id) WHERE tool_use_id IS NOT NULL`,
	`CREATE TABLE IF NOT EXISTS scheduled (
		id TEXT PRIMARY KEY,
		run_at INTEGER NOT NULL,
		text TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending'
	)`,
	`CREATE TABLE IF NOT EXISTS container_sessions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		started_at INTEGER NOT NULL,
		ended_at INTEGER,
		instance TEXT NOT NULL,
		end_reason TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS snapshots (
		id TEXT PRIMARY KEY,
		created_at INTEGER NOT NULL,
		size INTEGER NOT NULL,
		image_version TEXT NOT NULL,
		reason TEXT NOT NULL
	)`,
];

const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0));
const optNum = (value: unknown): number | undefined =>
	value === null || value === undefined ? undefined : Number(value);
const optStr = (value: unknown): string | undefined =>
	value === null || value === undefined ? undefined : String(value);

export class OrbStore {
	constructor(
		private readonly sql: SqlLike,
		private readonly kv: KvLike,
		private readonly transaction: <T>(fn: () => T) => T,
	) {}

	migrate(): void {
		for (const statement of SCHEMA) this.sql.exec(statement);
	}

	// ---- singleton config & state -------------------------------------------

	getConfig(): OrbConfig | undefined {
		return this.kv.get<OrbConfig>("config");
	}

	setConfig(config: OrbConfig): void {
		this.kv.put("config", config);
	}

	getState(): OrbState | undefined {
		return this.kv.get<OrbState>("state");
	}

	setState(state: OrbState): void {
		this.kv.put("state", state);
	}

	patchState(patch: Partial<OrbState>): OrbState {
		const current = this.getState();
		if (!current) throw new Error("orb state not initialised");
		const next = { ...current, ...patch };
		this.setState(next);
		return next;
	}

	/** Small named values that do not warrant a table (cached diff, pending wake flag). */
	getMisc<T>(key: string): T | undefined {
		return this.kv.get<T>(`misc:${key}`);
	}

	setMisc(key: string, value: unknown): void {
		this.kv.put(`misc:${key}`, value);
	}

	delMisc(key: string): void {
		this.kv.delete(`misc:${key}`);
	}

	// ---- events -------------------------------------------------------------

	appendEvent(event: OrbEvent, turnId?: string, now = Date.now()): EventRecord {
		const row = this.sql
			.exec(
				"INSERT INTO events (ts, turn_id, kind, data) VALUES (?, ?, ?, ?) RETURNING seq",
				now,
				turnId ?? null,
				event.kind,
				JSON.stringify(event),
			)
			.one();
		return { seq: num(row.seq), ts: now, ...(turnId ? { turnId } : {}), event };
	}

	eventsAfter(seq: number, limit = 500): EventRecord[] {
		return this.sql
			.exec(
				"SELECT seq, ts, turn_id, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
				seq,
				limit,
			)
			.toArray()
			.map(rowToRecord);
	}

	lastSeq(): number {
		return num(this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").one().seq);
	}

	/** Compact transcript of finished turns, used to rebuild context when an agent session is lost. */
	transcript(limitTurns = 8): Array<{ prompt: string; result?: string }> {
		return this.sql
			.exec(
				`SELECT prompt, result FROM turns WHERE status IN ('succeeded','failed','interrupted')
				 ORDER BY idx DESC LIMIT ?`,
				limitTurns,
			)
			.toArray()
			.reverse()
			.map((row) => ({ prompt: String(row.prompt), result: optStr(row.result) }));
	}

	// ---- turns --------------------------------------------------------------

	createTurn(id: string, prompt: string, scheduled: boolean, now = Date.now()): TurnRow {
		const idx = num(this.sql.exec("SELECT COALESCE(MAX(idx), 0) + 1 AS n FROM turns").one().n);
		this.sql.exec(
			"INSERT INTO turns (id, idx, prompt, scheduled, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)",
			id,
			idx,
			prompt,
			scheduled ? 1 : 0,
			now,
		);
		return this.getTurn(id)!;
	}

	getTurn(id: string): TurnRow | undefined {
		const row = this.sql.exec("SELECT * FROM turns WHERE id = ?", id).toArray()[0];
		return row ? rowToTurn(row) : undefined;
	}

	/** The turn whose agent process should currently exist (starting or running). */
	activeTurn(): TurnRow | undefined {
		const row = this.sql
			.exec("SELECT * FROM turns WHERE status IN ('starting','running') ORDER BY idx LIMIT 1")
			.toArray()[0];
		return row ? rowToTurn(row) : undefined;
	}

	nextQueuedTurn(): TurnRow | undefined {
		const row = this.sql
			.exec("SELECT * FROM turns WHERE status = 'queued' ORDER BY idx LIMIT 1")
			.toArray()[0];
		return row ? rowToTurn(row) : undefined;
	}

	/** Drop queued (not yet started) turns. Returns how many were cancelled. */
	cancelQueued(now = Date.now()): number {
		return this.sql
			.exec(
				"UPDATE turns SET status = 'interrupted', finished_at = ? WHERE status = 'queued' RETURNING id",
				now,
			)
			.toArray().length;
	}

	queuedCount(): number {
		return num(this.sql.exec("SELECT COUNT(*) AS n FROM turns WHERE status = 'queued'").one().n);
	}

	patchTurn(id: string, patch: Partial<Omit<TurnRow, "id" | "idx" | "prompt" | "createdAt">>): void {
		const columns: Record<string, unknown> = {
			scheduled: patch.scheduled === undefined ? undefined : patch.scheduled ? 1 : 0,
			status: patch.status,
			started_at: patch.startedAt,
			finished_at: patch.finishedAt,
			offset: patch.offset,
			session_id: patch.sessionId,
			cost_usd: patch.costUsd,
			input_tokens: patch.usage?.inputTokens,
			output_tokens: patch.usage?.outputTokens,
			cached_tokens: patch.usage?.cachedTokens,
			error: patch.error,
			result: patch.result,
			result_seen: patch.resultSeen === undefined ? undefined : patch.resultSeen ? 1 : 0,
			interrupt_requested_at: patch.interruptRequestedAt,
		};
		const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
		if (entries.length === 0) return;
		this.sql.exec(
			`UPDATE turns SET ${entries.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
			...entries.map(([, value]) => value),
			id,
		);
	}

	/** Most recent agent session id, for resuming the conversation. */
	latestSessionId(): string | undefined {
		const row = this.sql
			.exec("SELECT session_id FROM turns WHERE session_id IS NOT NULL ORDER BY idx DESC LIMIT 1")
			.toArray()[0];
		return row ? optStr(row.session_id) : undefined;
	}

	/**
	 * Persist a batch of parsed events and advance the ingest offset atomically,
	 * so a restart between batches never duplicates or drops events.
	 */
	ingest(
		turnId: string,
		offset: number,
		events: OrbEvent[],
		patch: Partial<TurnRow> = {},
		now = Date.now(),
	): EventRecord[] {
		return this.transaction(() => {
			const records = events.map((event) => this.appendEvent(event, turnId, now));
			this.patchTurn(turnId, { ...patch, offset });
			return records;
		});
	}

	// ---- approvals ----------------------------------------------------------

	/** Idempotent on `toolUseId`: a shim that retries gets the same approval back. */
	createApproval(input: {
		id: string;
		turnId?: string;
		toolUseId?: string;
		toolName: string;
		input: unknown;
		now?: number;
	}): { approval: ApprovalRow; created: boolean } {
		if (input.toolUseId) {
			const existing = this.sql
				.exec("SELECT * FROM approvals WHERE tool_use_id = ?", input.toolUseId)
				.toArray()[0];
			if (existing) return { approval: rowToApproval(existing), created: false };
		}
		this.sql.exec(
			`INSERT INTO approvals (id, turn_id, tool_use_id, tool_name, input, status, created_at)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
			input.id,
			input.turnId ?? null,
			input.toolUseId ?? null,
			input.toolName,
			JSON.stringify(input.input ?? {}),
			input.now ?? Date.now(),
		);
		return { approval: this.getApproval(input.id)!, created: true };
	}

	getApproval(id: string): ApprovalRow | undefined {
		const row = this.sql.exec("SELECT * FROM approvals WHERE id = ?", id).toArray()[0];
		return row ? rowToApproval(row) : undefined;
	}

	pendingApprovals(): PendingApproval[] {
		return this.sql
			.exec("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at")
			.toArray()
			.map(rowToApproval)
			.map((approval) => ({
				approvalId: approval.id,
				toolName: approval.toolName,
				input: approval.input,
				toolUseId: approval.toolUseId,
				turnId: approval.turnId,
				createdAt: approval.createdAt,
			}));
	}

	resolveApproval(
		id: string,
		status: Exclude<ApprovalStatus, "pending">,
		note?: string,
		now = Date.now(),
	): boolean {
		const result = this.sql
			.exec(
				"UPDATE approvals SET status = ?, note = ?, resolved_at = ? WHERE id = ? AND status = 'pending' RETURNING id",
				status,
				note ?? null,
				now,
				id,
			)
			.toArray();
		return result.length > 0;
	}

	/** Expire every pending approval (turn ended, interrupted, or orb deleted). Returns the expired ids. */
	expirePendingApprovals(now = Date.now()): string[] {
		return this.sql
			.exec(
				"UPDATE approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending' RETURNING id",
				now,
			)
			.toArray()
			.map((row) => String(row.id));
	}

	static decisionToStatus(decision: ApprovalDecision): "allowed" | "denied" {
		return decision === "deny" ? "denied" : "allowed";
	}

	// ---- scheduled messages -------------------------------------------------

	addScheduled(id: string, runAt: number, text: string): void {
		this.sql.exec("INSERT INTO scheduled (id, run_at, text) VALUES (?, ?, ?)", id, runAt, text);
	}

	dueScheduled(now: number): ScheduledRow[] {
		return this.sql
			.exec("SELECT * FROM scheduled WHERE status = 'pending' AND run_at <= ? ORDER BY run_at", now)
			.toArray()
			.map(rowToScheduled);
	}

	pendingScheduled(): ScheduledRow[] {
		return this.sql
			.exec("SELECT * FROM scheduled WHERE status = 'pending' ORDER BY run_at")
			.toArray()
			.map(rowToScheduled);
	}

	markScheduled(id: string, status: "sent" | "skipped"): void {
		this.sql.exec("UPDATE scheduled SET status = ? WHERE id = ?", status, id);
	}

	cancelScheduled(id: string): boolean {
		return (
			this.sql
				.exec("DELETE FROM scheduled WHERE id = ? AND status = 'pending' RETURNING id", id)
				.toArray().length > 0
		);
	}

	nextScheduledAt(): number | undefined {
		return optNum(
			this.sql
				.exec("SELECT MIN(run_at) AS at FROM scheduled WHERE status = 'pending'")
				.one().at,
		);
	}

	// ---- container sessions (runtime metering) ------------------------------

	openSession(instance: string, now = Date.now()): void {
		this.closeSession("superseded", now);
		this.sql.exec(
			"INSERT INTO container_sessions (started_at, instance) VALUES (?, ?)",
			now,
			instance,
		);
	}

	closeSession(reason: string, now = Date.now()): void {
		this.sql.exec(
			"UPDATE container_sessions SET ended_at = ?, end_reason = ? WHERE ended_at IS NULL",
			now,
			reason,
		);
	}

	hasOpenSession(): boolean {
		return (
			num(
				this.sql
					.exec("SELECT COUNT(*) AS n FROM container_sessions WHERE ended_at IS NULL")
					.one().n,
			) > 0
		);
	}

	containerSeconds(now = Date.now()): number {
		const row = this.sql
			.exec(
				"SELECT COALESCE(SUM(COALESCE(ended_at, ?) - started_at), 0) AS ms FROM container_sessions",
				now,
			)
			.one();
		return Math.round(num(row.ms) / 1000);
	}

	// ---- snapshots ----------------------------------------------------------

	addSnapshot(snapshot: SnapshotRow): void {
		this.sql.exec(
			"INSERT OR REPLACE INTO snapshots (id, created_at, size, image_version, reason) VALUES (?, ?, ?, ?, ?)",
			snapshot.id,
			snapshot.createdAt,
			snapshot.size,
			snapshot.imageVersion,
			snapshot.reason,
		);
		// The container API cannot list or delete snapshots; keep only the recent handles.
		this.sql.exec(
			"DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY created_at DESC LIMIT 20)",
		);
	}

	clearSnapshots(): void {
		this.sql.exec("DELETE FROM snapshots");
	}

	latestSnapshot(): SnapshotRow | undefined {
		const row = this.sql
			.exec("SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 1")
			.toArray()[0];
		return row ? rowToSnapshot(row) : undefined;
	}

	listSnapshots(): SnapshotRow[] {
		return this.sql
			.exec("SELECT * FROM snapshots ORDER BY created_at DESC")
			.toArray()
			.map(rowToSnapshot);
	}

	// ---- usage ----------------------------------------------------------------

	usage(now = Date.now()): OrbUsage {
		const row = this.sql
			.exec(
				`SELECT COALESCE(SUM(cost_usd), 0) AS cost,
				        COALESCE(SUM(input_tokens), 0) AS input,
				        COALESCE(SUM(output_tokens), 0) AS output,
				        COALESCE(SUM(cached_tokens), 0) AS cached,
				        COUNT(*) AS turns
				 FROM turns WHERE status IN ('succeeded','failed','interrupted','lost')`,
			)
			.one();
		return {
			costUsd: num(row.cost),
			inputTokens: num(row.input),
			outputTokens: num(row.output),
			cachedTokens: num(row.cached),
			turns: num(row.turns),
			containerSeconds: this.containerSeconds(now),
		};
	}
}

export function budgetExceeded(budget: Budget, usage: OrbUsage): string | undefined {
	if (budget.maxCostUsd !== undefined && usage.costUsd >= budget.maxCostUsd) {
		return `Cost limit reached ($${usage.costUsd.toFixed(2)} of $${budget.maxCostUsd.toFixed(2)})`;
	}
	if (
		budget.maxRuntimeMinutes !== undefined &&
		usage.containerSeconds >= budget.maxRuntimeMinutes * 60
	) {
		return `Runtime limit reached (${Math.round(usage.containerSeconds / 60)} of ${budget.maxRuntimeMinutes} minutes)`;
	}
	return undefined;
}

function rowToRecord(row: Row): EventRecord {
	return {
		seq: num(row.seq),
		ts: num(row.ts),
		...(row.turn_id ? { turnId: String(row.turn_id) } : {}),
		event: JSON.parse(String(row.data)) as OrbEvent,
	};
}

function rowToTurn(row: Row): TurnRow {
	return {
		id: String(row.id),
		idx: num(row.idx),
		prompt: String(row.prompt),
		scheduled: num(row.scheduled) === 1,
		status: String(row.status) as TurnStatus,
		createdAt: num(row.created_at),
		startedAt: optNum(row.started_at),
		finishedAt: optNum(row.finished_at),
		offset: num(row.offset),
		sessionId: optStr(row.session_id),
		costUsd: num(row.cost_usd),
		usage: {
			inputTokens: num(row.input_tokens),
			outputTokens: num(row.output_tokens),
			cachedTokens: num(row.cached_tokens),
		},
		error: optStr(row.error),
		result: optStr(row.result),
		resultSeen: num(row.result_seen) === 1,
		interruptRequestedAt: optNum(row.interrupt_requested_at),
	};
}

function rowToApproval(row: Row): ApprovalRow {
	return {
		id: String(row.id),
		turnId: optStr(row.turn_id),
		toolUseId: optStr(row.tool_use_id),
		toolName: String(row.tool_name),
		input: JSON.parse(String(row.input)),
		status: String(row.status) as ApprovalStatus,
		note: optStr(row.note),
		createdAt: num(row.created_at),
		resolvedAt: optNum(row.resolved_at),
	};
}

function rowToScheduled(row: Row): ScheduledRow {
	return {
		id: String(row.id),
		runAt: num(row.run_at),
		text: String(row.text),
		status: String(row.status) as ScheduledRow["status"],
	};
}

function rowToSnapshot(row: Row): SnapshotRow {
	return {
		id: String(row.id),
		createdAt: num(row.created_at),
		size: num(row.size),
		imageVersion: String(row.image_version),
		reason: String(row.reason),
	};
}
