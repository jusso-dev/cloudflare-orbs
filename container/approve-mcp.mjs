#!/usr/bin/env node
// Minimal MCP stdio server with one tool, `approve`.
//
// Claude Code calls it for every permission prompt (--permission-prompt-tool
// mcp__orb__approve). The request goes to the orb control plane, which asks a
// human over the orb's WebSocket and answers here. State lives in the Durable
// Object, so this shim just creates the request once (idempotent on
// tool_use_id) and long-polls until it is decided.
import { createInterface } from "node:readline";

const CONTROL = (process.env.ORB_CONTROL_URL ?? "http://orb.internal").replace(/\/$/, "");
const POLL_WAIT_SECONDS = 20;
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function control(method, path, body) {
	const response = await fetch(`${CONTROL}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`control plane answered ${response.status}`);
	return response.json();
}

async function decide(args) {
	const input = args?.input ?? {};
	const deadline = Date.now() + GIVE_UP_AFTER_MS;
	let id;
	let backoff = 500;

	while (Date.now() < deadline) {
		try {
			if (!id) {
				const created = await control("POST", "/approvals", {
					toolName: String(args?.tool_name ?? "unknown"),
					toolUseId: args?.tool_use_id ? String(args.tool_use_id) : undefined,
					input,
				});
				id = created.id;
			}
			const state = await control("GET", `/approvals/${id}?wait=${POLL_WAIT_SECONDS}`);
			if (state.status === "allowed") return { behavior: "allow", updatedInput: input };
			if (state.status === "denied" || state.status === "expired") {
				return { behavior: "deny", message: state.note || "The user denied this action." };
			}
			backoff = 500;
		} catch {
			await sleep(backoff);
			backoff = Math.min(backoff * 2, 10_000);
		}
	}
	return { behavior: "deny", message: "No approval decision was received." };
}

const TOOL = {
	name: "approve",
	description: "Ask the human operator whether a tool call may run.",
	inputSchema: {
		type: "object",
		properties: {
			tool_name: { type: "string" },
			input: { type: "object" },
			tool_use_id: { type: "string" },
		},
		required: ["tool_name", "input"],
	},
};

async function handle(message) {
	const { id, method, params } = message;
	if (method === undefined || id === undefined) return; // responses and notifications

	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "orb", version: "1.0.0" },
			},
		});
	} else if (method === "ping") {
		send({ jsonrpc: "2.0", id, result: {} });
	} else if (method === "tools/list") {
		send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
	} else if (method === "tools/call" && params?.name === "approve") {
		const decision = await decide(params.arguments);
		send({
			jsonrpc: "2.0",
			id,
			result: { content: [{ type: "text", text: JSON.stringify(decision) }] },
		});
	} else {
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
	}
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	handle(message).catch((error) => {
		if (message?.id !== undefined) {
			send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error) } });
		}
	});
});
lines.on("close", () => process.exit(0));
