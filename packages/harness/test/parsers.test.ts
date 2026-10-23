import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OrbEvent } from "@orbs/protocol";
import { claudeCode, codex, getHarness, listHarnesses } from "../src/index.ts";

function fixture(name: string): string[] {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
		.split("\n")
		.filter(Boolean);
}

function run(harness: "claude-code" | "codex", lines: string[]) {
	const parser = getHarness(harness).createParser();
	const events: OrbEvent[] = [];
	const deltas: string[] = [];
	let sessionId: string | undefined;
	let result;
	for (const line of lines) {
		const parsed = parser.parse(line);
		events.push(...parsed.events);
		deltas.push(...parsed.deltas);
		sessionId = parsed.sessionId ?? sessionId;
		result = parsed.result ?? result;
	}
	return { events, deltas, sessionId, result, parser };
}

describe("claude-code parser (real captured output)", () => {
	const { events, deltas, sessionId, result, parser } = run("claude-code", fixture("claude-code.jsonl"));

	it("captures the session id from system/init", () => {
		expect(sessionId).toBe("13b65004-8a34-42b7-bada-abb905d9aeac");
	});

	it("emits tool calls and matching results", () => {
		const calls = events.filter((e) => e.kind === "tool_call");
		expect(calls.map((c) => c.kind === "tool_call" && c.name)).toEqual(["Write", "Bash"]);
		const results = events.filter((e) => e.kind === "tool_result");
		expect(results).toHaveLength(2);
		const first = calls[0];
		const firstResult = results[0];
		expect(first?.kind === "tool_call" && firstResult?.kind === "tool_result" && firstResult.toolId).toBe(
			first?.kind === "tool_call" ? first.toolId : "",
		);
	});

	it("surfaces permission denials as warnings", () => {
		const warn = events.find((e) => e.kind === "system");
		expect(warn).toMatchObject({ kind: "system", level: "warn" });
	});

	it("keeps text deltas ephemeral and the final text persisted", () => {
		expect(deltas.length).toBeGreaterThan(0);
		expect(events.some((e) => e.kind === "agent_message")).toBe(true);
		expect(events.some((e) => (e as { kind: string }).kind === "delta")).toBe(false);
	});

	it("reports cost and usage on result", () => {
		expect(result?.outcome).toBe("succeeded");
		expect(result?.costUsd).toBeGreaterThan(0);
		expect(result?.usage?.outputTokens).toBeGreaterThan(0);
		expect(parser.finish(0, "")).toBeUndefined();
	});

	it("ignores malformed lines", () => {
		const p = getHarness("claude-code").createParser();
		expect(p.parse("not json")).toEqual({ events: [], deltas: [] });
		expect(p.parse("")).toEqual({ events: [], deltas: [] });
	});

	it("fails the turn when the process dies without a result", () => {
		const p = getHarness("claude-code").createParser();
		expect(p.finish(137, "Killed")).toMatchObject({ outcome: "failed" });
	});

	it("treats error subtypes as failures", () => {
		const p = getHarness("claude-code").createParser();
		const parsed = p.parse(
			JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false, session_id: "s" }),
		);
		expect(parsed.result).toMatchObject({ outcome: "failed", error: "error_max_turns" });
	});
});

describe("codex parser (real captured output)", () => {
	const { events, sessionId, result } = run("codex", fixture("codex.jsonl"));

	it("captures the thread id", () => {
		expect(sessionId).toBe("01a16a9c-cb9c-74d3-8c1b-f2612c90a58f");
	});

	it("pairs command executions into call + result exactly once", () => {
		const calls = events.filter((e) => e.kind === "tool_call");
		const results = events.filter((e) => e.kind === "tool_result");
		expect(calls).toHaveLength(2);
		expect(results).toHaveLength(2);
		const failed = results.filter((e) => e.kind === "tool_result" && e.isError);
		expect(failed).toHaveLength(0);
	});

	it("uses the last agent message as the result and reads token usage", () => {
		expect(result).toMatchObject({ outcome: "succeeded", result: "done" });
		expect(result?.usage?.inputTokens).toBe(45779);
		expect(result?.usage?.cachedTokens).toBe(22016);
	});

	it("handles completed-only items and file changes", () => {
		const p = codex.createParser();
		const done = p.parse(
			JSON.stringify({
				type: "item.completed",
				item: { id: "x", type: "command_execution", command: "ls", aggregated_output: "a", exit_code: 1, status: "failed" },
			}),
		);
		expect(done.events.map((e) => e.kind)).toEqual(["tool_call", "tool_result"]);
		expect(done.events[1]).toMatchObject({ isError: true });
		const fc = p.parse(
			JSON.stringify({
				type: "item.completed",
				item: { id: "y", type: "file_change", changes: [{ path: "a.ts", kind: "add" }], status: "completed" },
			}),
		);
		expect(fc.events).toEqual([{ kind: "file_change", path: "a.ts", change: "add" }]);
	});

	it("reports turn.failed and crashes", () => {
		const p = codex.createParser();
		expect(p.parse(JSON.stringify({ type: "turn.failed", error: { message: "boom" } })).result).toEqual({
			outcome: "failed",
			error: "boom",
		});
		const q = codex.createParser();
		expect(q.finish(2, "stderr text")).toMatchObject({ outcome: "failed" });
	});
});

describe("commands", () => {
	const base = {
		model: "m",
		gatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw",
		taskDir: "/workspace/.orb/t1",
	};

	it("claude auto mode skips permissions and never puts the prompt or a real key in argv/env", () => {
		const { argv, env } = claudeCode.command({ ...base, approvalMode: "auto" });
		expect(argv).toContain("--dangerously-skip-permissions");
		expect(argv).not.toContain("--permission-prompt-tool");
		expect(env.ANTHROPIC_API_KEY).toBe("provided-by-worker");
		expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic");
	});

	it("claude ask mode routes permissions through the orb MCP tool", () => {
		const { argv } = claudeCode.command({ ...base, approvalMode: "ask", resumeSessionId: "abc" });
		expect(argv).not.toContain("--dangerously-skip-permissions");
		expect(argv.join(" ")).toContain("--permission-prompt-tool mcp__orb__approve");
		expect(argv.join(" ")).toContain("--resume abc");
	});

	it("codex reads the prompt from stdin and supports resume", () => {
		const fresh = codex.command({ ...base, approvalMode: "auto" }).argv;
		expect(fresh.slice(0, 2)).toEqual(["codex", "exec"]);
		expect(fresh.at(-1)).toBe("-");
		const resumed = codex.command({ ...base, approvalMode: "auto", resumeSessionId: "tid" }).argv;
		expect(resumed.slice(0, 3)).toEqual(["codex", "exec", "resume"]);
		expect(resumed.slice(-2)).toEqual(["tid", "-"]);
	});
});

describe("catalog", () => {
	it("hides the demo harness unless enabled and honours model overrides", () => {
		expect(listHarnesses().map((h) => h.id)).toEqual(["claude-code", "codex"]);
		expect(listHarnesses({ demoEnabled: true }).map((h) => h.id)).toContain("demo");
		const info = listHarnesses({ models: { codex: "a, b" } }).find((h) => h.id === "codex");
		expect(info?.models).toEqual(["a", "b"]);
		expect(info?.defaultModel).toBe("a");
	});
});
