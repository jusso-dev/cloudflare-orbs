import { describe, expect, it } from "vitest";
import { budgetExceeded } from "../src/worker/store.ts";
import { createStore } from "./helpers.ts";

describe("events", () => {
	it("assigns increasing sequence numbers and replays after a cursor", () => {
		const { store } = createStore();
		const a = store.appendEvent({ kind: "user_message", text: "one" }, "t1", 1000);
		const b = store.appendEvent({ kind: "agent_message", text: "two" }, "t1", 1001);
		store.appendEvent({ kind: "system", level: "info", message: "three" });

		expect([a.seq, b.seq]).toEqual([1, 2]);
		expect(store.lastSeq()).toBe(3);
		expect(store.eventsAfter(0).map((r) => r.seq)).toEqual([1, 2, 3]);
		expect(store.eventsAfter(1).map((r) => r.event.kind)).toEqual(["agent_message", "system"]);
		expect(store.eventsAfter(3)).toEqual([]);
		expect(store.eventsAfter(0, 2)).toHaveLength(2);
		expect(a.turnId).toBe("t1");
	});

	it("round-trips event payloads exactly", () => {
		const { store } = createStore();
		const event = { kind: "tool_call", toolId: "x", name: "Bash", input: { command: "ls -la", n: 1 } } as const;
		store.appendEvent(event);
		expect(store.eventsAfter(0)[0]?.event).toEqual(event);
	});
});

describe("turns", () => {
	it("queues in order and tracks the active turn", () => {
		const { store } = createStore();
		const first = store.createTurn("t1", "do a", false);
		const second = store.createTurn("t2", "do b", true);
		expect([first.idx, second.idx]).toEqual([1, 2]);
		expect(second.scheduled).toBe(true);
		expect(store.nextQueuedTurn()?.id).toBe("t1");
		expect(store.queuedCount()).toBe(2);
		expect(store.activeTurn()).toBeUndefined();

		store.patchTurn("t1", { status: "running", startedAt: 5 });
		expect(store.activeTurn()?.id).toBe("t1");
		expect(store.nextQueuedTurn()?.id).toBe("t2");

		store.patchTurn("t1", { status: "succeeded", finishedAt: 9, result: "done" });
		expect(store.activeTurn()).toBeUndefined();
		expect(store.getTurn("t1")).toMatchObject({ status: "succeeded", result: "done", startedAt: 5 });
	});

	it("patching leaves unspecified columns alone", () => {
		const { store } = createStore();
		store.createTurn("t1", "p", false);
		store.patchTurn("t1", { sessionId: "s-1", costUsd: 0.5 });
		store.patchTurn("t1", { offset: 99 });
		expect(store.getTurn("t1")).toMatchObject({ sessionId: "s-1", costUsd: 0.5, offset: 99 });
	});

	it("ingest persists events and the offset together, or neither", () => {
		const { store } = createStore();
		store.createTurn("t1", "p", false);
		const records = store.ingest("t1", 120, [
			{ kind: "agent_message", text: "hi" },
			{ kind: "agent_message", text: "there" },
		], { sessionId: "sess" });
		expect(records.map((r) => r.seq)).toEqual([1, 2]);
		expect(store.getTurn("t1")).toMatchObject({ offset: 120, sessionId: "sess" });

		// A failure mid-batch must leave neither the events nor the new offset behind.
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() =>
			store.ingest("t1", 500, [
				{ kind: "agent_message", text: "ok" },
				{ kind: "tool_call", toolId: "x", name: "n", input: circular },
			]),
		).toThrow();
		expect(store.getTurn("t1")?.offset).toBe(120);
		expect(store.lastSeq()).toBe(2);
	});

	it("cancels only queued turns", () => {
		const { store } = createStore();
		store.createTurn("t1", "a", false);
		store.createTurn("t2", "b", false);
		store.patchTurn("t1", { status: "running" });
		expect(store.cancelQueued()).toBe(1);
		expect(store.getTurn("t1")?.status).toBe("running");
		expect(store.getTurn("t2")?.status).toBe("interrupted");
	});

	it("resumes from the latest session id and builds a transcript of finished turns", () => {
		const { store } = createStore();
		store.createTurn("t1", "first", false);
		store.patchTurn("t1", { status: "succeeded", sessionId: "s1", result: "did first" });
		store.createTurn("t2", "second", false);
		store.patchTurn("t2", { status: "failed", sessionId: "s2", result: undefined });
		store.createTurn("t3", "pending", false);

		expect(store.latestSessionId()).toBe("s2");
		expect(store.transcript()).toEqual([
			{ prompt: "first", result: "did first" },
			{ prompt: "second", result: undefined },
		]);
	});
});

describe("approvals", () => {
	it("is idempotent on tool_use_id so a retrying shim gets the same approval", () => {
		const { store } = createStore();
		const first = store.createApproval({ id: "a1", toolUseId: "tu1", toolName: "Bash", input: { command: "ls" } });
		const retry = store.createApproval({ id: "a2", toolUseId: "tu1", toolName: "Bash", input: { command: "ls" } });
		expect(first.created).toBe(true);
		expect(retry).toMatchObject({ created: false, approval: { id: "a1" } });
		expect(store.pendingApprovals()).toHaveLength(1);
	});

	it("resolves exactly once", () => {
		const { store } = createStore();
		store.createApproval({ id: "a1", toolName: "Edit", input: {} });
		expect(store.resolveApproval("a1", "allowed")).toBe(true);
		expect(store.resolveApproval("a1", "denied")).toBe(false);
		expect(store.getApproval("a1")?.status).toBe("allowed");
		expect(store.pendingApprovals()).toHaveLength(0);
	});

	it("expires everything pending", () => {
		const { store } = createStore();
		store.createApproval({ id: "a1", toolName: "Edit", input: {} });
		store.createApproval({ id: "a2", toolName: "Bash", input: {} });
		store.resolveApproval("a1", "allowed");
		expect(store.expirePendingApprovals()).toEqual(["a2"]);
		expect(store.getApproval("a2")?.status).toBe("expired");
	});
});

describe("scheduled messages", () => {
	it("returns due items in order and reports the next wake time", () => {
		const { store } = createStore();
		store.addScheduled("s2", 2000, "later");
		store.addScheduled("s1", 1000, "sooner");
		store.addScheduled("s3", 9000, "much later");
		expect(store.nextScheduledAt()).toBe(1000);
		expect(store.dueScheduled(2500).map((s) => s.id)).toEqual(["s1", "s2"]);

		store.markScheduled("s1", "sent");
		expect(store.nextScheduledAt()).toBe(2000);
		expect(store.cancelScheduled("s2")).toBe(true);
		expect(store.cancelScheduled("s2")).toBe(false);
		expect(store.pendingScheduled().map((s) => s.id)).toEqual(["s3"]);
	});
});

describe("runtime metering", () => {
	it("sums closed and open container sessions", () => {
		const { store } = createStore();
		store.openSession("standard-1", 0);
		store.closeSession("idle", 60_000);
		store.openSession("standard-1", 100_000);
		expect(store.hasOpenSession()).toBe(true);
		expect(store.containerSeconds(130_000)).toBe(90);
		store.closeSession("idle", 160_000);
		expect(store.hasOpenSession()).toBe(false);
		expect(store.containerSeconds(999_999)).toBe(120);
	});

	it("opening a session closes a dangling one instead of double counting", () => {
		const { store } = createStore();
		store.openSession("lite", 0);
		store.openSession("lite", 10_000);
		store.closeSession("x", 20_000);
		expect(store.containerSeconds(50_000)).toBe(20);
	});
});

describe("snapshots", () => {
	it("returns the newest and prunes old handles", () => {
		const { store } = createStore();
		for (let i = 1; i <= 25; i++) {
			store.addSnapshot({ id: `s${i}`, createdAt: i, size: i, imageVersion: "1", reason: "idle" });
		}
		expect(store.latestSnapshot()?.id).toBe("s25");
		expect(store.listSnapshots()).toHaveLength(20);
		store.clearSnapshots();
		expect(store.latestSnapshot()).toBeUndefined();
	});
});

describe("usage and budgets", () => {
	it("aggregates finished turns only", () => {
		const { store } = createStore();
		store.createTurn("t1", "a", false);
		store.patchTurn("t1", { status: "succeeded", costUsd: 1.25, usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 10 } });
		store.createTurn("t2", "b", false);
		store.patchTurn("t2", { status: "failed", costUsd: 0.25, usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 3 } });
		store.createTurn("t3", "c", false);
		store.patchTurn("t3", { status: "running", costUsd: 99 });
		store.openSession("lite", 0);

		expect(store.usage(30_000)).toEqual({
			costUsd: 1.5,
			inputTokens: 101,
			outputTokens: 52,
			cachedTokens: 13,
			turns: 2,
			containerSeconds: 30,
		});
	});

	it("budgetExceeded reports cost and runtime limits", () => {
		const usage = { costUsd: 5, inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 1, containerSeconds: 600 };
		expect(budgetExceeded({}, usage)).toBeUndefined();
		expect(budgetExceeded({ maxCostUsd: 10 }, usage)).toBeUndefined();
		expect(budgetExceeded({ maxCostUsd: 5 }, usage)).toMatch(/Cost limit/);
		expect(budgetExceeded({ maxRuntimeMinutes: 10 }, usage)).toMatch(/Runtime limit/);
		expect(budgetExceeded({ maxRuntimeMinutes: 11 }, usage)).toBeUndefined();
	});
});

describe("state", () => {
	it("patchState merges and requires initialisation", () => {
		const { store } = createStore();
		expect(() => store.patchState({ status: "idle" })).toThrow();
		store.setState({ status: "sleeping", updatedAt: 1, lastActivityAt: 1, autoAllow: [], sessionValid: true });
		store.patchState({ status: "idle", branch: "orb/x" });
		expect(store.getState()).toMatchObject({ status: "idle", branch: "orb/x", sessionValid: true });
	});
});
