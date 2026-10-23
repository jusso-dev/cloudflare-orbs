import { describe, expect, it } from "vitest";
import type { EventRecord, OrbEvent } from "@orbs/protocol/types";
import { buildTimeline, pendingApprovals, toolSummary } from "../src/web/lib/timeline.ts";
import { parseDiff } from "../src/web/lib/diff.ts";

let seq = 0;
const rec = (event: OrbEvent): EventRecord => ({ seq: ++seq, ts: seq, event });

describe("buildTimeline", () => {
	it("pairs tool results with their calls and attaches approvals", () => {
		seq = 0;
		const items = buildTimeline([
			rec({ kind: "user_message", text: "go" }),
			rec({ kind: "tool_call", toolId: "t1", name: "Bash", input: { command: "ls" } }),
			rec({ kind: "approval_requested", approvalId: "a1", toolName: "Bash", input: { command: "ls" }, toolUseId: "t1" }),
			rec({ kind: "approval_resolved", approvalId: "a1", decision: "allow" }),
			rec({ kind: "tool_result", toolId: "t1", output: "a\nb", isError: false }),
		]);
		expect(items.map((i) => i.type)).toEqual(["user", "tool"]);
		const tool = items[1];
		expect(tool).toMatchObject({ name: "Bash", result: { output: "a\nb", isError: false }, approval: { id: "a1", state: "allow" } });
	});

	it("attaches an approval to its tool call even when the approval reached the log first", () => {
		seq = 0;
		const items = buildTimeline([
			rec({ kind: "approval_requested", approvalId: "a1", toolName: "Write", input: {}, toolUseId: "t1" }),
			rec({ kind: "agent_message", text: "working" }),
			rec({ kind: "tool_call", toolId: "t1", name: "Write", input: {} }),
			rec({ kind: "approval_resolved", approvalId: "a1", decision: "deny" }),
		]);
		expect(items.map((i) => i.type)).toEqual(["agent", "tool"]);
		expect(items[1]).toMatchObject({ approval: { id: "a1", state: "deny" } });
	});

	it("keeps an approval as its own item when no tool call matches", () => {
		seq = 0;
		const items = buildTimeline([
			rec({ kind: "approval_requested", approvalId: "a1", toolName: "Edit", input: {} }),
		]);
		expect(items).toEqual([{ type: "approval", seq: 1, approvalId: "a1", toolName: "Edit", input: {}, state: "pending" }]);
		expect(pendingApprovals(items)).toHaveLength(1);
		expect(pendingApprovals(buildTimeline([...[rec({ kind: "approval_requested", approvalId: "b", toolName: "x", input: {} })], rec({ kind: "approval_resolved", approvalId: "b", decision: "deny" })]))).toHaveLength(0);
	});

	it("collapses repeated provisioning statuses into one wake marker and shows sleep as a band", () => {
		seq = 0;
		const items = buildTimeline([
			rec({ kind: "status", status: "sleeping" }),
			rec({ kind: "status", status: "provisioning", reason: "Waking up…" }),
			rec({ kind: "status", status: "provisioning", reason: "Starting the workspace…" }),
			rec({ kind: "status", status: "running" }),
			rec({ kind: "status", status: "idle" }),
			rec({ kind: "status", status: "failed", reason: "boom" }),
		]);
		expect(items.map((i) => i.type)).toEqual(["sleep", "wake", "notice"]);
	});

	it("shows a turn summary with cost", () => {
		seq = 0;
		const [turn] = buildTimeline([rec({ kind: "turn_finished", turnId: "t", outcome: "succeeded", result: "done", costUsd: 0.5, durationMs: 1200 })]);
		expect(turn).toMatchObject({ type: "turn", outcome: "succeeded", costUsd: 0.5 });
	});
});

describe("toolSummary", () => {
	it("prefers the most descriptive field", () => {
		expect(toolSummary("Bash", { command: "git  status\n--short", description: "x" })).toBe("git status --short");
		expect(toolSummary("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
		expect(toolSummary("x", null)).toBe("");
		expect(toolSummary("x", { n: 1 })).toBe("");
	});
});

describe("parseDiff", () => {
	const diff = [
		"diff --git a/src/a.ts b/src/a.ts",
		"index 111..222 100644",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1,3 +1,4 @@ function f() {",
		" keep",
		"-old",
		"+new",
		"+extra",
		" tail",
		"diff --git a/new.md b/new.md",
		"new file mode 100644",
		"--- /dev/null",
		"+++ b/new.md",
		"@@ -0,0 +1,2 @@",
		"+# Title",
		"+body",
		"diff --git a/img.png b/img.png",
		"Binary files a/img.png and b/img.png differ",
		"",
	].join("\n");

	it("splits files, counts changes, and numbers lines", () => {
		const files = parseDiff(diff);
		expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
			["src/a.ts", "modified", 2, 1],
			["new.md", "added", 2, 0],
			["img.png", "binary", 0, 0],
		]);
		const a = files[0]!;
		expect(a.lines[0]).toMatchObject({ kind: "hunk", text: "@@ function f() {" });
		expect(a.lines[1]).toMatchObject({ kind: "ctx", oldNo: 1, newNo: 1 });
		expect(a.lines[2]).toMatchObject({ kind: "del", oldNo: 2 });
		expect(a.lines[3]).toMatchObject({ kind: "add", newNo: 2 });
		expect(a.lines.at(-1)).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 4 });
	});

	it("returns nothing for an empty diff", () => {
		expect(parseDiff("")).toEqual([]);
	});
});
