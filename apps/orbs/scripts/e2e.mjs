#!/usr/bin/env node
// End-to-end check of a running dev server, using the scripted "demo" harness so no
// model credentials are needed.
//
//   ENABLE_DEMO_HARNESS=true AI_GATEWAY_ACCOUNT_ID=dev cf dev     # with .dev.vars (AUTH_TOKEN=dev-token)
//   node scripts/e2e.mjs [base-url] [only-step-substring]
//
// Needs Docker (the dev server runs real containers) and network access to github.com.
const BASE = process.argv[2] ?? "http://localhost:5173";
const ONLY = process.argv[3];
const TOKEN = process.env.AUTH_TOKEN ?? "dev-token";
const REPO = process.env.E2E_REPO ?? "https://github.com/octocat/Hello-World";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function api(method, path, body) {
	const response = await fetch(`${BASE}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = text;
	}
	return { status: response.status, data };
}

async function until(label, check, timeoutMs = 90_000, everyMs = 500) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(everyMs);
	}
}

/** A WebSocket client that behaves like the web app: replays from a cursor, de-duplicates by seq. */
class Watcher {
	records = new Map();
	helloSeq = undefined;
	deltas = 0;
	approvals = [];
	orb = undefined;
	errors = [];

	async connect(id, lastSeq = 0) {
		const ticket = (await api("POST", `/orbs/${id}/ticket`, { scope: "events" })).data.ticket;
		const url = `${BASE.replace(/^http/, "ws")}/api/orbs/${id}/ws?ticket=${encodeURIComponent(ticket)}`;
		this.socket = new WebSocket(url);
		this.socket.addEventListener("message", (event) => this.onMessage(JSON.parse(event.data)));
		await new Promise((resolve, reject) => {
			this.socket.addEventListener("open", resolve, { once: true });
			this.socket.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
		});
		this.socket.send(JSON.stringify({ type: "hello", lastSeq }));
		// Wait for the summary and for the replay to catch up with the server's last seq.
		await until("hello + replay", () => this.helloSeq !== undefined && this.lastSeq >= this.helloSeq, 15_000, 50);
		return this;
	}

	onMessage(message) {
		if (message.type === "hello") {
			this.helloSeq = message.lastSeq;
			this.orb = message.orb;
			this.approvals = message.pendingApprovals;
		} else if (message.type === "events") {
			for (const record of message.records) this.records.set(record.seq, record);
		} else if (message.type === "event") {
			this.records.set(message.record.seq, message.record);
			if (message.record.event.kind === "approval_requested") this.approvals.push({ approvalId: message.record.event.approvalId });
		} else if (message.type === "delta") {
			this.deltas++;
		} else if (message.type === "orb") {
			this.orb = message.orb;
		} else if (message.type === "error") {
			this.errors.push(message.message);
		}
	}

	get lastSeq() {
		return Math.max(0, ...this.records.keys());
	}
	events(kind) {
		return [...this.records.values()].map((r) => r.event).filter((e) => !kind || e.kind === kind);
	}
	send(message) {
		this.socket.send(JSON.stringify(message));
	}
	close() {
		this.socket.close();
	}
	finished(afterSeq = 0) {
		return [...this.records.values()].find((r) => r.seq > afterSeq && r.event.kind === "turn_finished");
	}
}

async function createOrb(extra = {}) {
	const { status, data } = await api("POST", "/orbs", {
		repoUrl: REPO,
		prompt: "Add a short note about this repo",
		harness: "demo",
		...extra,
	});
	if (status !== 201) throw new Error(`create failed: ${status} ${JSON.stringify(data)}`);
	return data;
}

let failures = 0;
async function step(name, fn) {
	if (ONLY && !name.includes(ONLY)) return;
	const started = Date.now();
	try {
		await fn();
		console.log(`  ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
	} catch (error) {
		failures++;
		console.log(`  FAIL ${name}: ${error.message}`);
	}
}
const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};

const created = [];
console.log(`e2e against ${BASE}`);

await step("auth rejects anonymous callers and accepts the token", async () => {
	const anonymous = await fetch(`${BASE}/api/orbs`);
	assert(anonymous.status === 401, `expected 401, got ${anonymous.status}`);
	assert((await api("GET", "/orbs")).status === 200, "token rejected");
});

let main;
await step("create → clone → stream events over WebSocket → finish", async () => {
	main = await createOrb();
	created.push(main.id);
	const watcher = await new Watcher().connect(main.id);
	main.watcher = watcher;
	await until("turn_finished", () => watcher.finished());
	const kinds = new Set(watcher.events().map((e) => e.kind));
	for (const kind of ["user_message", "turn_started", "agent_message", "tool_call", "tool_result", "turn_finished", "status"]) {
		assert(kinds.has(kind), `missing event kind ${kind}`);
	}
	assert(watcher.deltas > 0, "no live text deltas were streamed");
	assert(watcher.finished().event.outcome === "succeeded", "turn did not succeed");
	const seqs = [...watcher.records.keys()];
	assert(new Set(seqs).size === seqs.length, "duplicate seq");
});

await step("a reconnecting client catches up from its cursor without duplicates", async () => {
	const first = main.watcher;
	const cursor = [...first.records.keys()].sort((a, b) => a - b)[4];
	first.close();
	const again = await new Watcher().connect(main.id, cursor);
	await until("replay", () => again.lastSeq === first.lastSeq);
	assert(Math.min(...again.records.keys()) === cursor + 1, "replay should start right after the cursor");
	assert(again.orb?.id === main.id, "hello did not carry the summary");
	main.watcher = again;
});

await step("diff shows the agent's change and usage is recorded", async () => {
	const diff = (await api("GET", `/orbs/${main.id}/diff`)).data;
	assert(diff.diff.includes("ORB_DEMO.md"), "diff missing the new file");
	const summary = (await api("GET", `/orbs/${main.id}`)).data;
	assert(summary.usage.turns === 1 && summary.usage.costUsd > 0, `usage not recorded: ${JSON.stringify(summary.usage)}`);
	assert(summary.branch === `orb/${main.id}`, "branch not recorded");
});

await step("sleep snapshots the workspace and stops the container", async () => {
	const result = await api("POST", `/orbs/${main.id}/sleep`, {});
	assert(result.status === 200, `sleep failed: ${JSON.stringify(result.data)}`);
	assert(result.data.status === "sleeping" && result.data.hasSnapshot, "orb should be sleeping with a snapshot");
});

await step("a message wakes the orb from its snapshot with files intact", async () => {
	const seq = main.watcher.lastSeq;
	const sent = await api("POST", `/orbs/${main.id}/messages`, { text: "Now add a second note" });
	assert(sent.status === 202, `send failed: ${JSON.stringify(sent.data)}`);
	await until("second turn", () => main.watcher.finished(seq), 120_000);
	assert(main.watcher.events().some((e) => e.kind === "system" && /restoring the workspace snapshot/.test(e.message)), "did not restore from snapshot");
	const diff = (await api("GET", `/orbs/${main.id}/diff?fresh=1`)).data.diff;
	assert((diff.match(/Demo run/g) ?? []).length === 2, "both runs should be in the restored file");
});

await step("approvals: ask mode blocks until a human decides; deny and always-allow work", async () => {
	const orb = await createOrb({ approvalMode: "ask" });
	created.push(orb.id);
	const watcher = await new Watcher().connect(orb.id);
	const pending = await until("first approval", () => watcher.events("approval_requested")[0]);
	assert(watcher.orb?.status === "awaiting_approval" || (await api("GET", `/orbs/${orb.id}`)).data.status === "awaiting_approval", "status should be awaiting_approval");
	assert(!watcher.finished(), "turn must not finish before approval");

	// Allow the first tool call over the socket, deny the second over REST.
	watcher.send({ type: "approve", approvalId: pending.approvalId, decision: "allow" });
	const second = await until("second approval", () => watcher.events("approval_requested")[1]);
	const denied = await api("POST", `/orbs/${orb.id}/approvals/${second.approvalId}`, { decision: "deny" });
	assert(denied.status === 200, `deny failed: ${JSON.stringify(denied.data)}`);
	await until("turn_finished", () => watcher.finished());

	const results = watcher.events("tool_result");
	assert(results.length === 2 && !results[0].isError && results[1].isError, "first tool should run, second should be denied");
	const resolved = watcher.events("approval_resolved").map((e) => e.decision);
	assert(resolved.join() === "allow,deny", `unexpected decisions ${resolved}`);
	assert((await api("POST", `/orbs/${orb.id}/approvals/${second.approvalId}`, { decision: "allow" })).status === 409, "re-resolving should conflict");

	// allow_always: after approving Write permanently, the next turn only asks about Bash.
	const writes = () => watcher.events("approval_requested").filter((e) => e.toolName === "Write").length;
	const bashes = () => watcher.events("approval_requested").filter((e) => e.toolName === "Bash").length;
	assert(writes() === 1 && bashes() === 1, "first turn should have asked once per tool");

	let seq = watcher.lastSeq;
	await api("POST", `/orbs/${orb.id}/messages`, { text: "again" });
	const again = await until("Write approval on turn 2", () => watcher.events("approval_requested")[2]);
	assert(again.toolName === "Write", `expected Write, got ${again.toolName}`);
	watcher.send({ type: "approve", approvalId: again.approvalId, decision: "allow_always" });
	const bash2 = await until("Bash approval on turn 2", () => watcher.events("approval_requested")[3]);
	watcher.send({ type: "approve", approvalId: bash2.approvalId, decision: "allow" });
	await until("turn 2 finished", () => watcher.finished(seq), 90_000);

	seq = watcher.lastSeq;
	await api("POST", `/orbs/${orb.id}/messages`, { text: "and again" });
	const bash3 = await until("Bash approval on turn 3", () => watcher.events("approval_requested")[4]);
	assert(bash3.toolName === "Bash", "Write should no longer need approval");
	watcher.send({ type: "approve", approvalId: bash3.approvalId, decision: "allow" });
	await until("turn 3 finished", () => watcher.finished(seq), 90_000);
	assert(writes() === 2, `Write should have been asked exactly twice in total, was ${writes()}`);
});

await step("interrupt stops a running turn", async () => {
	const orb = await createOrb({ prompt: "slow task please" });
	created.push(orb.id);
	const watcher = await new Watcher().connect(orb.id);
	await until("running", () => watcher.events("turn_started")[0] && watcher.events("agent_message").length >= 2, 60_000);
	const result = await api("POST", `/orbs/${orb.id}/interrupt`, {});
	assert(result.status === 200, `interrupt failed: ${JSON.stringify(result.data)}`);
	const finished = await until("turn_finished", () => watcher.finished(), 60_000);
	assert(finished.event.outcome === "interrupted", `expected interrupted, got ${finished.event.outcome}`);
	await until("idle after the stop", async () => (await api("GET", `/orbs/${orb.id}`)).data.status === "idle", 10_000);
});

await step("a scheduled message wakes a sleeping orb", async () => {
	const orb = created[0];
	const slept = await api("POST", `/orbs/${orb}/sleep`, {});
	assert(slept.status === 200, `sleep failed: ${JSON.stringify(slept.data)}`);
	const watcher = await new Watcher().connect(orb);
	const seq = watcher.lastSeq;
	const at = Date.now() + 8_000;
	assert((await api("POST", `/orbs/${orb}/schedule`, { at, text: "scheduled follow-up" })).status === 201, "schedule failed");
	assert((await api("GET", `/orbs/${orb}`)).data.nextWakeAt === at, "nextWakeAt not reported");
	await until("scheduled turn", () => watcher.finished(seq), 120_000);
	assert(watcher.events("user_message").some((e) => e.scheduled && e.text === "scheduled follow-up"), "scheduled message not delivered");
});

await step("terminal: a shell in the workspace over WebSocket", async () => {
	const orb = created[0];
	const ticket = (await api("POST", `/orbs/${orb}/ticket`, { scope: "terminal" })).data.ticket;
	const socket = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/orbs/${orb}/terminal?ticket=${encodeURIComponent(ticket)}&cols=100&rows=30`);
	socket.binaryType = "arraybuffer";
	let output = "";
	socket.addEventListener("message", (event) => {
		output += new TextDecoder().decode(event.data);
	});
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", () => reject(new Error("terminal socket failed")), { once: true });
	});
	await sleep(1500);
	socket.send(new TextEncoder().encode("pwd; ls ORB_DEMO.md; echo marker-$((6*7))\n"));
	await until("shell output", () => output.includes("marker-42") && output.includes("/workspace/repo"), 20_000);
	socket.close();
});

await step("tickets are scoped: wrong scope, wrong orb and garbage are rejected", async () => {
	const ticket = (await api("POST", `/orbs/${created[0]}/ticket`, { scope: "events" })).data.ticket;
	const outcome = (path) =>
		new Promise((resolve) => {
			const socket = new WebSocket(`${BASE.replace(/^http/, "ws")}${path}`);
			socket.addEventListener("open", () => {
				socket.close();
				resolve("accepted");
			});
			socket.addEventListener("error", () => resolve("rejected"));
		});
	assert((await outcome(`/api/orbs/${created[0]}/ws?ticket=${encodeURIComponent(ticket)}`)) === "accepted", "valid ticket rejected");
	assert((await outcome(`/api/orbs/${created[0]}/terminal?ticket=${encodeURIComponent(ticket)}`)) === "rejected", "events ticket accepted for terminal");
	assert((await outcome(`/api/orbs/${created[1] ?? "aaaaaaaaaaaa"}/ws?ticket=${encodeURIComponent(ticket)}`)) === "rejected", "ticket accepted for another orb");
	assert((await outcome(`/api/orbs/${created[0]}/ws?ticket=garbage`)) === "rejected", "garbage ticket accepted");
	assert((await outcome(`/api/orbs/${created[0]}/ws`)) === "rejected", "missing ticket accepted");
});

await step("budget: a runtime limit stops the orb and a raise lifts it", async () => {
	const orb = await createOrb({ budget: { maxCostUsd: 0.005 } });
	created.push(orb.id);
	const watcher = await new Watcher().connect(orb.id);
	await until("turn_finished", () => watcher.finished());
	await until("budget stop", async () => (await api("GET", `/orbs/${orb.id}`)).data.status === "budget_exceeded", 20_000);
	const blocked = await api("POST", `/orbs/${orb.id}/messages`, { text: "more" });
	assert(blocked.status === 402, `expected 402, got ${blocked.status}`);
	const raised = await api("POST", `/orbs/${orb.id}/budget`, { maxCostUsd: 5 });
	assert(raised.status === 200 && raised.data.status !== "budget_exceeded", "raising the budget should lift the stop");
});

await step("thread list and usage totals reflect all orbs", async () => {
	const list = (await api("GET", "/orbs")).data;
	for (const id of created) assert(list.some((o) => o.id === id), `orb ${id} missing from list`);
	const usage = (await api("GET", "/usage")).data;
	assert(usage.total.turns >= created.length && usage.total.costUsd > 0, `usage total looks wrong: ${JSON.stringify(usage.total)}`);
});

for (const id of created) await api("DELETE", `/orbs/${id}`);
await step("deleted orbs disappear", async () => {
	const list = (await api("GET", "/orbs")).data;
	assert(!created.some((id) => list.some((o) => o.id === id)), "deleted orb still listed");
});

console.log(failures === 0 ? "all steps passed" : `${failures} step(s) failed`);
process.exit(failures === 0 ? 0 : 1);
