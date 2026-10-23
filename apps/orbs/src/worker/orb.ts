import { DurableObject } from "cloudflare:workers";
import { getHarness, type EventParser } from "@orbs/harness";
import {
	ClientMessageSchema,
	isAwake,
	type ApprovalDecision,
	type Budget,
	type DiffResponse,
	type EventRecord,
	type EventsPage,
	type OrbEvent,
	type OrbSummary,
	type ServerMessage,
	type TurnOutcome,
} from "@orbs/protocol";
import { BASE_ENV, ORB_DIR, REPO_DIR, Sandbox, describe } from "./sandbox.ts";
import { readSettings, type Settings } from "./settings.ts";
import { OrbStore, budgetExceeded, type ApprovalStatus, type TurnRow } from "./store.ts";
import { fail, ok, type OrbConfig, type Result } from "./types.ts";
import { deleteRecoveryPatch, openPullRequest, readDiff } from "./workspace.ts";

/** Cadence of the alarm while a container is awake and idle. */
const CHECK_INTERVAL_MS = 60_000;
/** How soon the alarm re-enters to supervise a running turn. */
const SUPERVISE_MS = 20_000;
/** One alarm invocation follows the agent's output for at most this long (alarm handlers are capped at 15 minutes). */
const PUMP_WINDOW_MS = 14 * 60_000;
/** Snapshot an awake orb at this interval so an abrupt stop loses little. */
const CHECKPOINT_MS = 15 * 60_000;
const KILL_AFTER_INTERRUPT_MS = 10_000;
/** How often a followed turn's process is checked for liveness. */
const PROBE_INTERVAL_MS = 45_000;
const ACTIVITY_WRITE_THROTTLE_MS = 5_000;
const MAX_DIFF_BYTES = 900_000;
const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

const newId = (prefix = "") => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const isTerminal = (status: TurnRow["status"]) =>
	status !== "queued" && status !== "starting" && status !== "running";

export class Orb extends DurableObject<Env> {
	private readonly store: OrbStore;
	private readonly settings: Settings;
	private sandbox: Sandbox | undefined;

	// Nothing below matters across a restart: it is all rebuilt from SQLite and the container.
	private readonly parsers = new Map<string, EventParser>();
	private readonly resumeUsed = new Set<string>();
	private readonly waiters = new Map<string, Set<() => void>>();
	private pumping: Promise<"finished" | "detached"> | undefined;
	private terminals = 0;
	private lastPublished = "";
	private lastActivityWrite = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.settings = readSettings(env);
		this.store = new OrbStore(ctx.storage.sql, ctx.storage.kv, (fn) => ctx.storage.transactionSync(fn));
		ctx.blockConcurrencyWhile(async () => {
			this.store.migrate();
		});
		// Keep-alive pings are answered without waking the object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));

		const config = this.store.getConfig();
		if (config) {
			this.sandbox = this.createSandbox(config);
			void ctx.blockConcurrencyWhile(async () => {
				if (ctx.container?.running) {
					// The container outlived this object (deploy, eviction): re-attach to it.
					await this.sandbox!.ensureRunning().catch((error) => console.warn("re-attach failed", describe(error)));
				}
				// Safety net: whatever happened to the previous instance's alarm, work that is still
				// pending (a running turn, a queued message, a scheduled wake-up) gets one again.
				if ((await ctx.storage.getAlarm()) === null) await this.scheduleNextAlarm();
			});
		}
	}

	private createSandbox(config: OrbConfig): Sandbox {
		return new Sandbox(
			this.ctx,
			this.env,
			this.store,
			config,
			this.settings,
			(event) => void this.emit(event),
			(reason) => void this.onContainerExit(reason),
		);
	}

	private get config(): OrbConfig {
		const config = this.store.getConfig();
		if (!config) throw new Error("orb is not initialised");
		return config;
	}

	// =========================================================================
	// RPC: lifecycle
	// =========================================================================

	async init(config: OrbConfig, prompt: string): Promise<Result<OrbSummary>> {
		if (this.store.getConfig()) return fail(409, "This orb already exists");

		const now = Date.now();
		this.store.setConfig(config);
		this.store.setState({
			status: "sleeping",
			updatedAt: now,
			lastActivityAt: now,
			autoAllow: [],
			sessionValid: true,
		});
		this.sandbox = this.createSandbox(config);

		// Register with the user's hub first so the concurrency check has a row to count.
		const hub = this.hub();
		await hub.upsertOrb(this.summary());
		if (!(await hub.claimSlot(config.id, this.settings.maxConcurrentOrbs))) {
			await hub.removeOrb(config.id);
			await this.ctx.storage.deleteAll();
			this.sandbox = undefined;
			return fail(429, `You already have ${this.settings.maxConcurrentOrbs} orbs awake. Put one to sleep first.`);
		}

		const sent = await this.enqueueMessage(prompt, false, "Creating the workspace…");
		if (!sent.ok) return sent;
		return ok(this.summary());
	}

	getSummary(): OrbSummary | null {
		return this.store.getConfig() ? this.summary() : null;
	}

	getEvents(after: number, limit: number): EventsPage {
		const records = this.store.eventsAfter(after, Math.min(Math.max(limit, 1), 500));
		return {
			records,
			lastSeq: this.store.lastSeq(),
			hasMore: records.length > 0 && records[records.length - 1]!.seq < this.store.lastSeq(),
		};
	}

	async sendMessage(text: string): Promise<Result<{ turnId: string; queued: boolean }>> {
		return this.enqueueMessage(text, false);
	}

	private async enqueueMessage(
		text: string,
		scheduled: boolean,
		wakeReason = "Waking up…",
	): Promise<Result<{ turnId: string; queued: boolean }>> {
		const config = this.store.getConfig();
		const state = this.store.getState();
		if (!config || !state || !this.sandbox) return fail(404, "Orb not found");
		if (state.status === "archived") return fail(410, "This orb was deleted");

		const exceeded = budgetExceeded(config.budget, this.store.usage());
		if (exceeded) return fail(402, `${exceeded}. Raise the budget to continue.`);

		const asleep = !this.sandbox.running && !isAwake(state.status);
		if (asleep && !(await this.hub().claimSlot(config.id, this.settings.maxConcurrentOrbs))) {
			return fail(429, `You already have ${this.settings.maxConcurrentOrbs} orbs awake. Put one to sleep first.`);
		}

		const busy = this.store.activeTurn() !== undefined || this.store.queuedCount() > 0;
		const turn = this.store.createTurn(newId("t_"), text, scheduled);
		await this.emit({ kind: "user_message", text, ...(scheduled ? { scheduled } : {}) }, turn.id);
		this.markActivity(true);
		if (asleep) this.setStatus("provisioning", wakeReason);
		await this.kick();
		return ok({ turnId: turn.id, queued: busy });
	}

	async scheduleMessage(at: number, text: string): Promise<Result<{ id: string; at: number }>> {
		if (!this.store.getConfig()) return fail(404, "Orb not found");
		const now = Date.now();
		if (at < now + 5_000) return fail(400, "Pick a time in the future");
		if (at > now + 30 * 24 * 60 * 60_000) return fail(400, "Schedule at most 30 days ahead");
		const id = newId("s_");
		this.store.addScheduled(id, at, text);
		await this.scheduleNextAlarm();
		await this.publish();
		return ok({ id, at });
	}

	listScheduled() {
		return this.store.pendingScheduled();
	}

	async cancelScheduled(id: string): Promise<Result<true>> {
		if (!this.store.cancelScheduled(id)) return fail(404, "No such scheduled message");
		await this.scheduleNextAlarm();
		await this.publish();
		return ok(true);
	}

	async interrupt(): Promise<Result<true>> {
		const turn = this.store.activeTurn();
		const cancelled = this.store.cancelQueued();
		if (cancelled > 0) {
			await this.emit({ kind: "system", level: "info", message: `Cancelled ${cancelled} queued message${cancelled === 1 ? "" : "s"}.` });
		}
		if (!turn) return cancelled > 0 ? ok(true) : fail(409, "Nothing is running");

		this.store.patchTurn(turn.id, { interruptRequestedAt: Date.now() });
		await this.expireApprovals();
		if (this.sandbox?.running && turn.status === "running") await this.signalTurn(turn, "TERM");
		await this.kick();
		return ok(true);
	}

	async resolveApproval(id: string, decision: ApprovalDecision): Promise<Result<true>> {
		const approval = this.store.getApproval(id);
		if (!approval) return fail(404, "No such approval");
		if (approval.status !== "pending") return fail(409, "This approval was already resolved");

		const status = OrbStore.decisionToStatus(decision);
		this.store.resolveApproval(id, status, decision === "deny" ? "The user denied this action." : undefined);
		await this.emit({ kind: "approval_resolved", approvalId: id, decision }, approval.turnId);

		if (decision === "allow_always") {
			const state = this.store.getState()!;
			this.store.patchState({ autoAllow: [...new Set([...state.autoAllow, approval.toolName])] });
			// Anything else already waiting on the same tool is covered by the new rule.
			for (const other of this.store.pendingApprovals()) {
				if (other.toolName === approval.toolName) {
					this.store.resolveApproval(other.approvalId, "allowed");
					await this.emit({ kind: "approval_resolved", approvalId: other.approvalId, decision: "allow_always" }, other.turnId);
					this.wake(other.approvalId);
				}
			}
		}
		this.wake(id);
		this.markActivity(true);
		if (this.store.pendingApprovals().length === 0) {
			this.setStatus(this.store.activeTurn() ? "running" : "idle");
		}
		return ok(true);
	}

	async setBudget(budget: Budget): Promise<Result<OrbSummary>> {
		const config = this.store.getConfig();
		if (!config) return fail(404, "Orb not found");
		this.store.setConfig({ ...config, budget });
		// Raising a limit lifts a budget stop.
		const state = this.store.getState()!;
		if (state.status === "budget_exceeded" && !budgetExceeded(budget, this.store.usage())) {
			this.setStatus(this.sandbox?.running ? "idle" : "sleeping");
		}
		await this.publish();
		return ok(this.summary());
	}

	async wakeUp(): Promise<Result<OrbSummary>> {
		const config = this.store.getConfig();
		const state = this.store.getState();
		if (!config || !state || !this.sandbox) return fail(404, "Orb not found");
		if (this.sandbox.running) return ok(this.summary());
		if (!(await this.hub().claimSlot(config.id, this.settings.maxConcurrentOrbs))) {
			return fail(429, `You already have ${this.settings.maxConcurrentOrbs} orbs awake. Put one to sleep first.`);
		}
		this.store.setMisc("wake", true);
		this.setStatus("provisioning", "Waking up…");
		await this.kick();
		return ok(this.summary());
	}

	async sleepNow(): Promise<Result<OrbSummary>> {
		if (!this.sandbox) return fail(404, "Orb not found");
		if (this.store.activeTurn() || this.store.queuedCount() > 0) {
			return fail(409, "A turn is in progress. Stop it first.");
		}
		try {
			await this.goToSleep("manual");
		} catch (error) {
			return fail(500, `Could not save the workspace: ${describe(error)}`);
		}
		return ok(this.summary());
	}

	async snapshotNow(): Promise<Result<OrbSummary>> {
		if (!this.sandbox?.running) return fail(409, "The orb is asleep; its workspace is already saved.");
		try {
			await this.sandbox.snapshot("manual");
		} catch (error) {
			return fail(500, `Snapshot failed: ${describe(error)}`);
		}
		await this.emit({ kind: "system", level: "info", message: "Saved a workspace snapshot." });
		return ok(this.summary());
	}

	async destroyOrb(): Promise<Result<true>> {
		const config = this.store.getConfig();
		if (!config) return fail(404, "Orb not found");
		await this.ctx.storage.deleteAlarm();
		try {
			await this.sandbox?.stop("deleted");
		} catch (error) {
			console.warn("stop on delete failed", describe(error));
		}
		await deleteRecoveryPatch(this.env, config.name).catch(() => {});
		await this.hub().removeOrb(config.id).catch(() => {});
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1000, "orb deleted");
			} catch {}
		}
		await this.ctx.storage.deleteAll();
		this.sandbox = undefined;
		return ok(true);
	}

	// =========================================================================
	// RPC: workspace
	// =========================================================================

	async getDiff(fresh = false): Promise<Result<DiffResponse>> {
		const state = this.store.getState();
		if (!state) return fail(404, "Orb not found");
		if (fresh && this.sandbox?.running) await this.refreshDiff().catch(() => {});
		const cached = this.store.getMisc<{ diff: string; truncated: boolean }>("diff");
		return ok({ diff: cached?.diff ?? "", truncated: cached?.truncated ?? false, baseRef: state.baseRef });
	}

	async createPullRequest(input: { title?: string; body?: string }): Promise<Result<{ url: string; number: number }>> {
		const config = this.store.getConfig();
		if (!config || !this.sandbox) return fail(404, "Orb not found");
		if (this.store.activeTurn()) return fail(409, "Wait for the current turn to finish.");
		try {
			await this.ensureAwake();
			const lastResult = this.store.transcript(1)[0]?.result;
			const pr = await openPullRequest(this.sandbox, {
				title: input.title ?? config.title,
				body:
					input.body ??
					`${lastResult ? `${lastResult}\n\n` : ""}_Opened by [Cloudflare Orbs](https://developers.cloudflare.com/sandbox/) from \`${config.harness}\`._`,
			});
			this.store.patchState({ prUrl: pr.url });
			await this.emit({
				kind: "system",
				level: "info",
				message: `${pr.existing ? "Updated" : "Opened"} pull request #${pr.number}: ${pr.url}`,
			});
			await this.publish();
			return ok({ url: pr.url, number: pr.number });
		} catch (error) {
			return fail(502, describe(error));
		}
	}

	// =========================================================================
	// RPC: control plane for the container (called from Outbound)
	// =========================================================================

	async requestApproval(input: {
		toolName: string;
		toolUseId?: string;
		input?: unknown;
	}): Promise<{ id: string; status: ApprovalStatus }> {
		const state = this.store.getState();
		const turn = this.store.activeTurn();
		const { approval, created } = this.store.createApproval({
			id: newId("a_"),
			turnId: turn?.id,
			toolUseId: input.toolUseId,
			toolName: input.toolName,
			input: input.input ?? {},
		});
		if (!created) return { id: approval.id, status: approval.status };

		if (state?.autoAllow.includes(input.toolName)) {
			this.store.resolveApproval(approval.id, "allowed");
			return { id: approval.id, status: "allowed" };
		}
		await this.emit(
			{
				kind: "approval_requested",
				approvalId: approval.id,
				toolName: input.toolName,
				input: input.input ?? {},
				toolUseId: input.toolUseId,
			},
			turn?.id,
		);
		this.setStatus("awaiting_approval", `Waiting for your approval: ${input.toolName}`);
		this.markActivity(true);
		return { id: approval.id, status: "pending" };
	}

	/** Long-poll: resolves when the approval is decided or `waitMs` elapses. State lives in SQLite, so a restart loses nothing. */
	async waitApproval(id: string, waitMs: number): Promise<{ status: ApprovalStatus; note?: string }> {
		let approval = this.store.getApproval(id);
		if (!approval) return { status: "expired" };
		if (approval.status === "pending" && waitMs > 0) {
			await new Promise<void>((resolve) => {
				const set = this.waiters.get(id) ?? new Set<() => void>();
				set.add(resolve);
				this.waiters.set(id, set);
				setTimeout(resolve, waitMs);
			});
			approval = this.store.getApproval(id) ?? approval;
		}
		return { status: approval.status, note: approval.note };
	}

	private wake(approvalId: string): void {
		const set = this.waiters.get(approvalId);
		this.waiters.delete(approvalId);
		set?.forEach((resolve) => resolve());
	}

	private async expireApprovals(): Promise<void> {
		for (const id of this.store.expirePendingApprovals()) {
			await this.emit({ kind: "approval_resolved", approvalId: id, decision: "expired" });
			this.wake(id);
		}
	}

	// =========================================================================
	// Alarm: the supervisor
	// =========================================================================

	private kick(): Promise<void> {
		return this.ctx.storage.setAlarm(Date.now());
	}

	async alarm(): Promise<void> {
		// A deleted orb may still get one last alarm; its tables are gone.
		if (!this.sandbox || !this.store.getConfig()) return;
		// Guarantee re-entry even if this run is cut short.
		await this.scheduleNextAlarm(Date.now() + SUPERVISE_MS);
		try {
			await this.tick();
		} catch (error) {
			console.error("tick failed", describe(error));
		}
		await this.publish();
		await this.scheduleNextAlarm();
	}

	private async tick(): Promise<void> {
		const sandbox = this.sandbox;
		const state = this.store.getState();
		if (!sandbox || !state || state.status === "archived") return;
		const now = Date.now();

		await this.promoteScheduled(now);

		if (this.store.getMisc<boolean>("wake")) {
			this.store.delMisc("wake");
			try {
				await this.ensureAwake();
			} catch (error) {
				this.setStatus("failed", `Could not wake: ${describe(error)}`);
				await this.emit({ kind: "system", level: "error", message: `Could not wake the workspace: ${describe(error)}` });
			}
		}

		await this.enforceBudget();

		const active = this.store.activeTurn();
		if (active) {
			await this.superviseTurn(active);
			return;
		}

		const queued = this.store.nextQueuedTurn();
		if (queued) {
			await this.startTurn(queued);
			const started = this.store.activeTurn();
			if (started) await this.superviseTurn(started);
			return;
		}

		await this.idleMaintenance(now);
	}

	/** Alarm times are the earliest of: supervise a turn, start a queued one, idle check, a scheduled message. */
	private async scheduleNextAlarm(floor?: number): Promise<void> {
		const now = Date.now();
		const candidates: number[] = [];
		if (floor !== undefined) candidates.push(floor);
		if (this.store.activeTurn()) candidates.push(now + SUPERVISE_MS);
		if (this.store.nextQueuedTurn()) candidates.push(now + 250);
		if (this.sandbox?.running) candidates.push(now + CHECK_INTERVAL_MS);
		const scheduled = this.store.nextScheduledAt();
		if (scheduled !== undefined) candidates.push(Math.max(scheduled, now + 250));

		if (candidates.length === 0) {
			await this.ctx.storage.deleteAlarm();
		} else {
			await this.ctx.storage.setAlarm(Math.min(...candidates));
		}
	}

	private async promoteScheduled(now: number): Promise<void> {
		for (const item of this.store.dueScheduled(now)) {
			const sent = await this.enqueueMessage(item.text, true);
			this.store.markScheduled(item.id, sent.ok ? "sent" : "skipped");
			if (!sent.ok) {
				await this.emit({ kind: "system", level: "warn", message: `Scheduled message skipped: ${sent.error}` });
			}
		}
	}

	private async enforceBudget(): Promise<void> {
		const config = this.store.getConfig();
		const state = this.store.getState();
		if (!config || !state || state.status === "budget_exceeded") return;
		const reason = budgetExceeded(config.budget, this.store.usage());
		if (!reason) return;

		await this.emit({ kind: "system", level: "warn", message: reason });
		const active = this.store.activeTurn();
		if (active) {
			this.store.patchTurn(active.id, { interruptRequestedAt: Date.now() });
			await this.expireApprovals();
			await this.signalTurn(active, "TERM").catch(() => {});
		}
		this.store.cancelQueued();
		this.setStatus("budget_exceeded", reason);
	}

	private async idleMaintenance(now: number): Promise<void> {
		const sandbox = this.sandbox;
		const state = this.store.getState();
		if (!sandbox?.running || !state) return;

		// A person at a terminal, or a pending approval, counts as activity.
		if (this.terminals > 0 || this.store.pendingApprovals().length > 0) {
			await sandbox.touch();
			return;
		}

		if (now - state.lastActivityAt >= this.settings.idleSleepMs) {
			try {
				await this.goToSleep("idle");
			} catch (error) {
				// Keep the workspace alive and try again at the next check.
				console.error("sleep failed", describe(error));
				await sandbox.touch();
			}
			return;
		}

		const savedAt = this.store.latestSnapshot()?.createdAt ?? 0;
		if (state.lastActivityAt > savedAt && now - savedAt > CHECKPOINT_MS) {
			await sandbox.snapshot("checkpoint").catch((error) => console.warn("checkpoint failed", describe(error)));
		}
		await sandbox.touch();
	}

	private async goToSleep(reason: "idle" | "manual"): Promise<void> {
		const sandbox = this.sandbox;
		if (!sandbox?.running) {
			this.setStatus("sleeping");
			return;
		}
		await this.refreshDiff().catch(() => {});
		await sandbox.sleep(reason);
		await this.emit({
			kind: "system",
			level: "info",
			message: reason === "idle" ? "Idle: saved the workspace and went to sleep." : "Saved the workspace and went to sleep.",
		});
		this.setStatus("sleeping");
	}

	private async onContainerExit(reason: string): Promise<void> {
		const active = this.store.activeTurn();
		if (active) await this.markLost(active, `The workspace stopped unexpectedly (${reason}).`);
		await this.emit({ kind: "system", level: "warn", message: `The workspace stopped unexpectedly: ${reason}. Send a message to resume from the last snapshot.` });
		if (this.store.getState()?.status !== "archived") this.setStatus("sleeping", "Stopped unexpectedly");
		await this.scheduleNextAlarm();
	}

	// =========================================================================
	// Turns
	// =========================================================================

	private async ensureAwake(): Promise<void> {
		const sandbox = this.sandbox!;
		const cold = !sandbox.running;
		if (cold) this.setStatus("provisioning", "Starting the workspace…");
		await sandbox.ensureRunning();
		if (cold && !this.store.activeTurn()) this.setStatus("idle");
	}

	private async startTurn(turn: TurnRow): Promise<void> {
		const sandbox = this.sandbox!;
		const config = this.config;
		const state = this.store.getState()!;
		this.store.patchTurn(turn.id, { status: "starting" });

		try {
			await this.ensureAwake();
		} catch (error) {
			await this.failTurn(turn, `Could not start the workspace: ${describe(error)}`);
			return;
		}
		if (this.store.getTurn(turn.id)?.interruptRequestedAt) {
			await this.finishTurn(turn.id, "interrupted", { error: "Stopped before the agent started." });
			return;
		}

		const harness = getHarness(config.harness);
		const dir = `${ORB_DIR}/turn-${turn.idx}`;
		const sessionId = harness.capabilities.resume && state.sessionValid ? this.store.latestSessionId() : undefined;
		const prompt = sessionId ? turn.prompt : withReplay(this.store.transcript(), turn.prompt);
		const usage = this.store.usage();
		const command = harness.command({
			model: config.model,
			approvalMode: config.approvalMode,
			resumeSessionId: sessionId,
			gatewayUrl: this.settings.gatewayUrl,
			taskDir: dir,
			maxBudgetUsd:
				config.budget.maxCostUsd !== undefined ? Math.max(config.budget.maxCostUsd - usage.costUsd, 0.01) : undefined,
		});

		try {
			await sandbox.files.mkdir(dir, { recursive: true });
			await sandbox.files.writeFile(`${dir}/prompt.txt`, prompt);
			const launch = await sandbox.exec(["orb-run", dir, "--", ...command.argv], {
				cwd: REPO_DIR,
				env: command.env,
				timeoutMs: 30_000,
			});
			if (launch.exitCode !== 0) throw new Error(launch.stderr.trim() || `orb-run exited ${launch.exitCode}`);
		} catch (error) {
			await this.failTurn(turn, `Could not launch ${harness.label}: ${describe(error)}`);
			return;
		}

		if (sessionId) this.resumeUsed.add(turn.id);
		else this.store.patchState({ sessionValid: true });
		this.store.patchTurn(turn.id, { status: "running", startedAt: Date.now(), offset: 0 });
		this.markActivity(true);
		await this.emit({ kind: "turn_started", turnId: turn.id, idx: turn.idx, model: config.model }, turn.id);
		this.setStatus("running");
	}

	private async failTurn(turn: TurnRow, error: string): Promise<void> {
		await this.finishTurn(turn.id, "failed", { error });
		this.setStatus("failed", error);
	}

	/**
	 * Follow the agent for up to one alarm window. The stream is read live, but every
	 * so often we also check the process itself, so a vanished agent is noticed within
	 * a minute rather than after the whole window.
	 */
	private async superviseTurn(turn: TurnRow): Promise<void> {
		const sandbox = this.sandbox!;
		const windowEnd = Date.now() + PUMP_WINDOW_MS;
		let current: TurnRow | undefined = turn;

		while (current && !isTerminal(current.status) && Date.now() < windowEnd) {
			if (!sandbox.running) {
				await this.markLost(current, "The workspace stopped while the agent was running.");
				return;
			}
			await sandbox.touch();

			const interrupting = current.interruptRequestedAt !== undefined;
			if (interrupting && Date.now() - current.interruptRequestedAt! > KILL_AFTER_INTERRUPT_MS) {
				await this.signalTurn(current, "KILL").catch(() => {});
			}

			const slice = interrupting ? 4_000 : PROBE_INTERVAL_MS;
			if ((await this.pump(current.id, Math.min(Date.now() + slice, windowEnd))) === "finished") return;

			current = this.store.getTurn(current.id);
			if (!current || isTerminal(current.status)) return;
			if (!sandbox.running) continue;

			const alive = await this.probeTurn(current);
			if (alive === "exited") {
				await this.drain(current);
				return;
			}
			if (alive === "lost") {
				// The process is gone without an end marker. If we asked it to stop, that is the stop.
				if (current.interruptRequestedAt) await this.finalizeTurn(current.id, 143);
				else await this.markLost(current, "The agent process disappeared (the workspace was restarted).");
				return;
			}
		}
	}

	private pump(turnId: string, deadline: number): Promise<"finished" | "detached"> {
		if (!this.pumping) {
			this.pumping = this.runPump(turnId, deadline).finally(() => {
				this.pumping = undefined;
			});
		}
		return this.pumping;
	}

	/**
	 * Stream the agent's event file into SQLite and out to clients. The file, not
	 * this process, is the source of truth: progress is a byte offset persisted
	 * with each batch, so a restart resumes exactly where it stopped.
	 */
	private async runPump(turnId: string, deadline: number): Promise<"finished" | "detached"> {
		const sandbox = this.sandbox!;
		const decoder = new TextDecoder();
		const parser = await this.parserFor(turnId);

		while (Date.now() < deadline) {
			const turn = this.store.getTurn(turnId);
			if (!turn || isTerminal(turn.status)) return "finished";
			if (!sandbox.running) return "detached";

			const controller = new AbortController();
			let exited = false;
			const proc = await sandbox.container.exec(
				["tail", "-c", `+${turn.offset + 1}`, "-F", `${ORB_DIR}/turn-${turn.idx}/events.jsonl`],
				{ stdout: "pipe", stderr: "ignore", signal: controller.signal },
			);
			const settled = () => {
				exited = true;
			};
			proc.exitCode.then(settled, settled);
			// Aborting after the process exited raises an uncaught error, so guard it.
			const timer = setTimeout(() => {
				if (!exited) controller.abort();
			}, Math.max(1_000, deadline - Date.now()));

			let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
			let offset = turn.offset;
			let finished = false;
			try {
				if (proc.stdout) {
					for await (const chunk of proc.stdout) {
						const merged = new Uint8Array(carry.length + chunk.length);
						merged.set(carry);
						merged.set(chunk, carry.length);

						const lines: string[] = [];
						let start = 0;
						for (let i = merged.indexOf(10); i !== -1; i = merged.indexOf(10, start)) {
							lines.push(decoder.decode(merged.subarray(start, i)));
							start = i + 1;
						}
						carry = merged.subarray(start);
						if (lines.length === 0) continue;

						offset += start;
						if (await this.ingestLines(turnId, parser, lines, offset)) {
							finished = true;
							break;
						}
					}
				}
			} catch (error) {
				console.warn("pump read failed", describe(error));
			} finally {
				clearTimeout(timer);
				if (!exited) {
					try {
						controller.abort();
					} catch {}
				}
			}
			if (finished) return "finished";
			// The stream ended without the exit marker: the process, the container, or the window ended.
			if (Date.now() >= deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		return "detached";
	}

	/** Parse a batch of lines, persist events + offset atomically, then fan out. Returns true when the turn ended. */
	private async ingestLines(turnId: string, parser: EventParser, lines: string[], offset: number): Promise<boolean> {
		const events: OrbEvent[] = [];
		let deltas = "";
		let exitCode: number | undefined;
		const patch: Partial<TurnRow> = {};

		for (const raw of lines) {
			const line = raw.trim();
			if (!line) continue;
			if (line.startsWith('{"type":"__orb_exit"')) {
				try {
					exitCode = Number((JSON.parse(line) as { code?: number }).code ?? 0);
				} catch {
					exitCode = 1;
				}
				continue;
			}
			const parsed = parser.parse(line);
			events.push(...parsed.events);
			deltas += parsed.deltas.join("");
			if (parsed.sessionId) patch.sessionId = parsed.sessionId;
			if (parsed.result) {
				patch.resultSeen = true;
				patch.costUsd = parsed.result.costUsd ?? 0;
				patch.usage = parsed.result.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
				if (parsed.result.result !== undefined) patch.result = parsed.result.result;
				if (parsed.result.error !== undefined) patch.error = parsed.result.error;
			}
		}

		if (deltas) this.broadcast({ type: "delta", turnId, text: deltas });
		const records = this.store.ingest(turnId, offset, events, patch);
		for (const record of records) this.broadcast({ type: "event", record });
		if (records.length > 0) this.markActivity();

		if (exitCode !== undefined) {
			await this.finalizeTurn(turnId, exitCode);
			return true;
		}
		return false;
	}

	/** Parser state (Codex pairs items, for example) is rebuilt by replaying what was already ingested. */
	private async parserFor(turnId: string): Promise<EventParser> {
		const existing = this.parsers.get(turnId);
		if (existing) return existing;

		const turn = this.store.getTurn(turnId)!;
		const parser = getHarness(this.config.harness).createParser();
		this.parsers.set(turnId, parser);
		if (turn.offset > 0 && this.sandbox?.running) {
			const head = await this.sandbox.exec(
				["head", "-c", String(turn.offset), `${ORB_DIR}/turn-${turn.idx}/events.jsonl`],
				{ maxBytes: Math.max(turn.offset + 1024, 1024 * 1024) },
			);
			for (const line of head.stdout.split("\n")) if (line.trim()) parser.parse(line.trim());
		}
		return parser;
	}

	/** One-shot read of whatever the agent wrote that we have not ingested yet (it exited between pump windows). */
	private async drain(turn: TurnRow): Promise<void> {
		const sandbox = this.sandbox!;
		const parser = await this.parserFor(turn.id);
		const read = await sandbox.exec(
			["tail", "-c", `+${turn.offset + 1}`, `${ORB_DIR}/turn-${turn.idx}/events.jsonl`],
			{ maxBytes: 8 * 1024 * 1024 },
		);
		const body = read.stdout;
		const complete = body.slice(0, body.lastIndexOf("\n") + 1);
		const lines = complete.split("\n");
		lines.pop();
		const bytes = new TextEncoder().encode(complete).length;
		if (!(await this.ingestLines(turn.id, parser, lines, turn.offset + bytes))) {
			// Exited but never wrote the marker (killed hard): fall back to the exit-code file.
			const code = await sandbox.exec(["cat", `${ORB_DIR}/turn-${turn.idx}/exit-code`]);
			await this.finalizeTurn(turn.id, code.exitCode === 0 ? Number(code.stdout.trim() || 0) : 1);
		}
	}

	private async probeTurn(turn: TurnRow): Promise<"running" | "exited" | "lost"> {
		const dir = `${ORB_DIR}/turn-${turn.idx}`;
		const alive = await this.sandbox!.exec([
			"sh",
			"-c",
			'read -r pid boot < "$1" 2>/dev/null && [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] && kill -0 "$pid"',
			"probe",
			`${dir}/pid`,
		]);
		if (alive.exitCode === 0) return "running";
		const exited = await this.sandbox!.exec(["test", "-f", `${dir}/exit-code`]);
		return exited.exitCode === 0 ? "exited" : "lost";
	}

	private async signalTurn(turn: TurnRow, signal: "TERM" | "KILL"): Promise<void> {
		// The agent runs in its own session (orb-run uses setsid). Signal everything in that
		// group except the wrapper itself: the wrapper must survive to record the exit code and
		// the end-of-stream marker. (bash, not sh: dash's kill cannot address a negative pid.)
		await this.sandbox!.exec([
			"bash",
			"-c",
			'read -r pid boot < "$1" || exit 0; for p in $(pgrep -g "$pid"); do [ "$p" != "$pid" ] && kill -"$2" "$p" 2>/dev/null; done; exit 0',
			"signal",
			`${ORB_DIR}/turn-${turn.idx}/pid`,
			signal,
		]);
	}

	private async finalizeTurn(turnId: string, exitCode: number): Promise<void> {
		const turn = this.store.getTurn(turnId);
		if (!turn || isTerminal(turn.status)) return;

		let outcome: TurnOutcome;
		let result = turn.result;
		let error = turn.error;
		let costUsd = turn.costUsd;
		let usage = turn.usage;

		if (turn.interruptRequestedAt) {
			outcome = "interrupted";
		} else if (turn.resultSeen) {
			outcome = turn.error ? "failed" : "succeeded";
		} else {
			const sandbox = this.sandbox;
			const stderr = sandbox?.running
				? (await sandbox.exec(["tail", "-c", "2000", `${ORB_DIR}/turn-${turn.idx}/stderr.log`])).stdout
				: "";
			const fallback = this.parsers.get(turnId)?.finish(exitCode, stderr);
			outcome = fallback?.outcome ?? (exitCode === 0 ? "succeeded" : "failed");
			result = fallback?.result ?? result;
			error = fallback?.error ?? (exitCode === 0 ? error : `The agent exited with code ${exitCode}`);
			costUsd = fallback?.costUsd ?? costUsd;
			usage = fallback?.usage ?? usage;
		}
		await this.finishTurn(turnId, outcome, { result, error, costUsd, usage });

		// A resume that points at a vanished session: replay the conversation instead.
		if (outcome === "failed" && this.resumeUsed.has(turnId) && /no (conversation|session)/i.test(error ?? "")) {
			this.store.patchState({ sessionValid: false });
			this.store.createTurn(newId("t_"), turn.prompt, false);
			await this.emit({ kind: "system", level: "warn", message: "The agent session could not be resumed. Retrying with the conversation replayed." });
		}
	}

	private async markLost(turn: TurnRow, error: string): Promise<void> {
		await this.finishTurn(turn.id, "lost", { error });
		this.setStatus("failed", error);
	}

	private async finishTurn(
		turnId: string,
		outcome: TurnOutcome,
		details: { result?: string; error?: string; costUsd?: number; usage?: TurnRow["usage"] },
	): Promise<void> {
		const turn = this.store.getTurn(turnId);
		if (!turn || isTerminal(turn.status)) return;
		const now = Date.now();

		this.store.patchTurn(turnId, {
			status: outcome,
			finishedAt: now,
			result: details.result,
			error: details.error,
			costUsd: details.costUsd,
			usage: details.usage,
		});
		this.parsers.delete(turnId);
		this.resumeUsed.delete(turnId);
		await this.expireApprovals();

		await this.emit(
			{
				kind: "turn_finished",
				turnId,
				outcome,
				...(details.result ? { result: details.result } : {}),
				...(details.error ? { error: details.error } : {}),
				...(details.costUsd ? { costUsd: details.costUsd } : {}),
				...(details.usage ? { usage: details.usage } : {}),
				durationMs: now - (turn.startedAt ?? turn.createdAt),
			},
			turnId,
		);
		this.markActivity(true);
		if (this.sandbox?.running) await this.refreshDiff().catch(() => {});

		const config = this.store.getConfig();
		const exceeded = config ? budgetExceeded(config.budget, this.store.usage()) : undefined;
		if (exceeded) {
			this.store.cancelQueued();
			await this.emit({ kind: "system", level: "warn", message: exceeded });
			this.setStatus("budget_exceeded", exceeded);
		} else if (outcome === "failed" || outcome === "lost") {
			this.setStatus("failed", details.error);
		} else {
			this.setStatus(this.sandbox?.running ? "idle" : "sleeping");
		}
		await this.kick();
	}

	private async refreshDiff(): Promise<void> {
		if (!this.sandbox?.running) return;
		const { diff, truncated } = await readDiff(this.sandbox);
		if (new TextEncoder().encode(diff).length > MAX_DIFF_BYTES) {
			this.store.setMisc("diff", { diff: diff.slice(0, MAX_DIFF_BYTES / 2), truncated: true });
		} else {
			this.store.setMisc("diff", { diff, truncated });
		}
	}

	// =========================================================================
	// State, events, fan-out
	// =========================================================================

	private markActivity(force = false): void {
		const now = Date.now();
		if (!force && now - this.lastActivityWrite < ACTIVITY_WRITE_THROTTLE_MS) return;
		this.lastActivityWrite = now;
		const state = this.store.getState();
		if (state) this.store.setState({ ...state, lastActivityAt: now });
	}

	private setStatus(status: OrbSummary["status"], reason?: string): void {
		const state = this.store.getState();
		if (!state || state.status === "archived") return;
		if (state.status === status && state.statusReason === reason) return;
		const changed = state.status !== status;
		this.store.setState({ ...state, status, statusReason: reason, updatedAt: Date.now() });
		// A new reason for the same status updates the header but is not a timeline event.
		if (changed) void this.emit({ kind: "status", status, ...(reason ? { reason } : {}) });
		else this.broadcast({ type: "orb", orb: this.summary() });
		void this.publish();
	}

	/** Persist an event and push it to every connected client. */
	private async emit(event: OrbEvent, turnId?: string): Promise<EventRecord> {
		const record = this.store.appendEvent(event, turnId);
		this.broadcast({ type: "event", record });
		if (event.kind === "status") this.broadcast({ type: "orb", orb: this.summary() });
		return record;
	}

	private broadcast(message: ServerMessage): void {
		const payload = JSON.stringify(message);
		for (const ws of this.ctx.getWebSockets("events")) {
			try {
				ws.send(payload);
			} catch {
				// A dead socket is cleaned up by webSocketClose.
			}
		}
	}

	private summary(): OrbSummary {
		const config = this.config;
		const state = this.store.getState()!;
		return {
			id: config.id,
			title: config.title,
			repoUrl: config.repoUrl,
			ref: config.ref,
			harness: config.harness,
			model: config.model,
			approvalMode: config.approvalMode,
			networkPolicy: config.networkPolicy,
			instance: config.instance,
			status: state.status,
			statusReason: state.statusReason,
			createdAt: config.createdAt,
			updatedAt: state.updatedAt,
			lastActivityAt: state.lastActivityAt,
			budget: config.budget,
			usage: this.store.usage(),
			branch: state.branch,
			prUrl: state.prUrl,
			hasSnapshot: this.store.latestSnapshot() !== undefined,
			nextWakeAt: this.store.nextScheduledAt(),
		};
	}

	private hub() {
		return this.env.USER_HUB.getByName(this.config.ownerKey);
	}

	/** Tell the user's hub about this orb so the thread list and usage totals stay current. */
	private async publish(): Promise<void> {
		if (!this.store.getConfig()) return;
		const summary = this.summary();
		const key = JSON.stringify({ ...summary, usage: { ...summary.usage, containerSeconds: Math.floor(summary.usage.containerSeconds / 60) } });
		if (key === this.lastPublished) return;
		this.lastPublished = key;
		this.ctx.waitUntil(this.hub().upsertOrb(summary).catch((error: unknown) => console.warn("hub update failed", describe(error))));
	}

	// =========================================================================
	// HTTP entry (WebSocket upgrades, terminal, preview) - reached only through the Worker
	// =========================================================================

	async fetch(request: Request): Promise<Response> {
		if (!this.store.getConfig()) return new Response("Not found", { status: 404 });
		const url = new URL(request.url);
		if (url.pathname === "/ws") return this.acceptEventsSocket(request);
		if (url.pathname === "/terminal") return this.openTerminal(request, url);
		if (url.pathname.startsWith("/preview/")) return this.proxyPreview(request, url);
		return new Response("Not found", { status: 404 });
	}

	private acceptEventsSocket(request: Request): Response {
		if (request.headers.get("upgrade") !== "websocket") {
			return new Response("Expected a WebSocket upgrade", { status: 426 });
		}
		const [client, server] = Object.values(new WebSocketPair());
		// Hibernation API: the object can be evicted while the socket stays connected.
		this.ctx.acceptWebSocket(server!, ["events"]);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		const send = (message: ServerMessage) => ws.send(JSON.stringify(message));
		if (typeof raw !== "string") return;

		let message;
		try {
			message = ClientMessageSchema.parse(JSON.parse(raw));
		} catch {
			send({ type: "error", message: "Malformed message" });
			return;
		}

		switch (message.type) {
			case "ping":
				send({ type: "pong" });
				return;
			case "hello": {
				send({
					type: "hello",
					orb: this.summary(),
					lastSeq: this.store.lastSeq(),
					pendingApprovals: this.store.pendingApprovals(),
				});
				let after = message.lastSeq;
				for (;;) {
					const records = this.store.eventsAfter(after, 200);
					if (records.length === 0) break;
					send({ type: "events", records });
					after = records[records.length - 1]!.seq;
					if (records.length < 200) break;
				}
				return;
			}
			case "message": {
				const result = await this.sendMessage(message.text);
				if (!result.ok) send({ type: "error", message: result.error });
				return;
			}
			case "approve": {
				const result = await this.resolveApproval(message.approvalId, message.decision);
				if (!result.ok) send({ type: "error", message: result.error });
				return;
			}
			case "interrupt": {
				const result = await this.interrupt();
				if (!result.ok) send({ type: "error", message: result.error });
				return;
			}
		}
	}

	webSocketClose(ws: WebSocket, code: number, reason: string): void {
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {}
	}

	webSocketError(): void {}

	// ---- terminal --------------------------------------------------------------

	private async openTerminal(request: Request, url: URL): Promise<Response> {
		if (request.headers.get("upgrade") !== "websocket") {
			return new Response("Expected a WebSocket upgrade", { status: 426 });
		}
		const sandbox = this.sandbox!;
		try {
			await this.ensureAwake();
		} catch (error) {
			return new Response(`Could not start the workspace: ${describe(error)}`, { status: 503 });
		}

		const session = /^[a-z0-9][a-z0-9-]{0,62}$/.test(url.searchParams.get("session") ?? "")
			? url.searchParams.get("session")!
			: "main";
		const abort = new AbortController();
		const tmux = await sandbox.container.exec(["tmux", "new-session", "-A", "-s", session], {
			// The tmux client runs on a pty; the session (and its shell) outlives the socket.
			pty: {
				cols: Number(url.searchParams.get("cols")) || 80,
				rows: Number(url.searchParams.get("rows")) || 24,
			},
			env: { ...BASE_ENV, TERM: "xterm-256color" },
			cwd: REPO_DIR,
			signal: abort.signal,
		});

		const [client, server] = Object.values(new WebSocketPair());
		server!.binaryType = "arraybuffer";
		// A live pty process handle cannot survive hibernation, so this socket is not hibernatable.
		server!.accept();
		this.terminals++;
		this.markActivity(true);

		const stdin = tmux.stdin!.getWriter();
		server!.addEventListener("message", (event) => {
			this.markActivity();
			if (typeof event.data === "string") {
				try {
					const { cols, rows } = JSON.parse(event.data) as { cols: number; rows: number };
					tmux.resize(cols, rows);
				} catch {
					// Ignore malformed resize messages; an exception would close the socket without cleanup.
				}
			} else {
				stdin.write(new Uint8Array(event.data as ArrayBuffer)).catch(() => {});
			}
		});

		let exited = false;
		const markExited = () => {
			exited = true;
		};
		tmux.exitCode.then(markExited, markExited);
		server!.addEventListener("close", () => {
			this.terminals = Math.max(0, this.terminals - 1);
			if (!exited) abort.abort();
		});

		const forward = async () => {
			for await (const chunk of tmux.stdout!) server!.send(chunk);
			server!.close(1000, `Terminal closed with code ${await tmux.exitCode}`);
		};
		void forward().catch(() => server!.close(1011, "Terminal output failed"));
		return new Response(null, { status: 101, webSocket: client });
	}

	// ---- preview -----------------------------------------------------------------

	private async proxyPreview(request: Request, url: URL): Promise<Response> {
		const match = /^\/preview\/(\d{4,5})(\/.*)?$/.exec(url.pathname);
		const port = match ? Number(match[1]) : 0;
		if (!match || port < 1024 || port > 65535) return new Response("Invalid preview port", { status: 400 });
		if (!this.sandbox?.running) return new Response("The orb is asleep. Wake it to preview.", { status: 503 });

		this.markActivity();
		const upstream = await this.sandbox.container
			.getTcpPort(port)
			.fetch(`http://container${match[2] ?? "/"}${url.search}`, {
				method: request.method,
				headers: stripHopHeaders(request.headers),
				body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
			})
			.catch((error) => new Response(`Nothing is listening on port ${port} (${describe(error)})`, { status: 502 }));

		// Preview content is untrusted code. Sandbox it into an opaque origin so it cannot
		// read this app's cookies or call its API as the signed-in user.
		const headers = stripHopHeaders(upstream.headers);
		headers.delete("set-cookie");
		headers.set("content-security-policy", "sandbox allow-scripts allow-forms allow-popups allow-modals");
		headers.set("x-content-type-options", "nosniff");
		headers.set("cache-control", "no-store");
		return new Response(upstream.body, { status: upstream.status, headers });
	}
}

function stripHopHeaders(source: Headers): Headers {
	const headers = new Headers(source);
	for (const name of ["connection", "keep-alive", "transfer-encoding", "upgrade", "cookie", "authorization", "host"]) {
		headers.delete(name);
	}
	return headers;
}

/** Without a resumable session, hand the agent the earlier conversation as context. */
function withReplay(history: Array<{ prompt: string; result?: string }>, prompt: string): string {
	if (history.length === 0) return prompt;
	const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
	const earlier = history
		.map(
			(turn, i) =>
				`Request ${i + 1}: ${clip(turn.prompt, 1500)}\nOutcome ${i + 1}: ${clip(turn.result ?? "(no summary)", 1500)}`,
		)
		.join("\n\n");
	return `You are continuing earlier work on this repository. The workspace was rebuilt, so your previous session is gone. Earlier in this conversation:\n\n${earlier}\n\nCurrent request:\n${prompt}`;
}
