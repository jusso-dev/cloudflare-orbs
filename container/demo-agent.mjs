#!/usr/bin/env node
// Scripted stand-in for a coding agent. Emits Claude Code-shaped stream-json so
// the whole orb pipeline can be exercised without model credentials. It really
// edits the repo (writes ORB_DEMO.md) so diffs, snapshots and PRs have content.
//
//   "slow"  in the prompt -> keeps working for ~90s (for sleep/wake/alarm tests)
//   "fail"  in the prompt -> ends with an error result
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const CONTROL = (process.env.ORB_CONTROL_URL ?? "http://orb.internal").replace(/\/$/, "");
const askMode = process.env.ORB_APPROVAL_MODE === "ask";
const resumeIndex = process.argv.indexOf("--resume");
const sessionId = resumeIndex > -1 ? process.argv[resumeIndex + 1] : randomUUID();
const prompt = readFileSync(0, "utf8").trim();

const emit = (message) => process.stdout.write(`${JSON.stringify({ ...message, session_id: sessionId })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function say(text) {
	for (const chunk of text.match(/.{1,6}/gs) ?? []) {
		emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: chunk } } });
		await sleep(25);
	}
	emit({ type: "assistant", message: { id: randomUUID(), role: "assistant", content: [{ type: "text", text }] } });
}

async function tool(name, input, run) {
	const id = `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
	emit({ type: "assistant", message: { id: randomUUID(), role: "assistant", content: [{ type: "tool_use", id, name, input }] } });

	let output;
	let isError = false;
	if (askMode) {
		const created = await (await fetch(`${CONTROL}/approvals`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ toolName: name, toolUseId: id, input }),
		})).json();
		for (;;) {
			const state = await (await fetch(`${CONTROL}/approvals/${created.id}?wait=20`)).json();
			if (state.status === "allowed") break;
			if (state.status !== "pending") {
				output = state.note || "The user denied this action.";
				isError = true;
				break;
			}
		}
	}
	if (!isError) {
		try {
			output = run();
		} catch (error) {
			output = String(error);
			isError = true;
		}
	}
	emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: isError }] } });
}

emit({ type: "system", subtype: "init", model: "scripted-1" });
await say(`Looking at the repo for: ${prompt.slice(0, 120)}\n`);

const note = `\n## Demo run ${new Date().toISOString()}\n\n${prompt}\n`;
await tool("Write", { file_path: "ORB_DEMO.md", content: note }, () => {
	appendFileSync("ORB_DEMO.md", existsSync("ORB_DEMO.md") ? note : `# Orb demo\n${note}`);
	return "Wrote ORB_DEMO.md";
});

await tool("Bash", { command: "git status --short" }, () =>
	execFileSync("git", ["status", "--short"], { encoding: "utf8" }).trim() || "(clean)",
);

if (/slow/i.test(prompt)) {
	for (let i = 1; i <= 18; i++) {
		await sleep(5000);
		await say(`Still working… step ${i}/18\n`);
	}
}

if (/fail/i.test(prompt)) {
	emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "Scripted failure", total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5 } });
	process.exit(1);
}

await say("Done. I wrote ORB_DEMO.md with the request, and checked git status.");
emit({
	type: "result",
	subtype: "success",
	is_error: false,
	result: "Done. I wrote ORB_DEMO.md with the request, and checked git status.",
	total_cost_usd: 0.0123,
	usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 },
});
