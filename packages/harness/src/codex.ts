import type { EventParser, Harness, ParsedLine, TurnResult } from "./types.ts";
import { clip, emptyParsed, isRecord, MAX_TEXT_CHARS, num, safeJson, str } from "./util.ts";

export const CODEX_MODELS = ["gpt-6-sol"];

export function createCodexParser(): EventParser {
	let sawResult = false;
	let lastMessage = "";
	let lastError = "";
	const started = new Set<string>();

	return {
		parse(line: string): ParsedLine {
			const out = emptyParsed();
			const msg = safeJson(line);
			if (!isRecord(msg)) return out;

			switch (msg.type) {
				case "thread.started":
					out.sessionId = str(msg.thread_id);
					break;

				case "item.started":
				case "item.completed": {
					const item = msg.item;
					if (!isRecord(item)) break;
					const id = str(item.id) ?? `item-${started.size}`;
					const done = msg.type === "item.completed";

					switch (item.type) {
						case "agent_message": {
							const text = str(item.text);
							if (done && text?.trim()) {
								lastMessage = text;
								out.events.push({ kind: "agent_message", text: clip(text, MAX_TEXT_CHARS).text });
							}
							break;
						}
						case "reasoning": {
							const text = str(item.text);
							if (done && text?.trim()) out.events.push({ kind: "reasoning", text: clip(text).text });
							break;
						}
						case "command_execution": {
							if (!started.has(id)) {
								started.add(id);
								out.events.push({
									kind: "tool_call",
									toolId: id,
									name: "shell",
									input: { command: str(item.command) ?? "" },
								});
							}
							if (done) {
								const { text, truncated } = clip(str(item.aggregated_output) ?? "");
								const exit = typeof item.exit_code === "number" ? item.exit_code : 0;
								out.events.push({
									kind: "tool_result",
									toolId: id,
									output: text,
									isError: exit !== 0 || item.status === "failed",
									...(truncated ? { truncated } : {}),
								});
							}
							break;
						}
						case "file_change": {
							if (!done || !Array.isArray(item.changes)) break;
							for (const change of item.changes) {
								if (!isRecord(change) || typeof change.path !== "string") continue;
								const kind = change.kind === "add" || change.kind === "delete" ? change.kind : "update";
								out.events.push({ kind: "file_change", path: change.path, change: kind });
							}
							break;
						}
						case "mcp_tool_call": {
							const name = `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "tool"}`;
							if (!started.has(id)) {
								started.add(id);
								out.events.push({
									kind: "tool_call",
									toolId: id,
									name,
									input: item.arguments ?? {},
								});
							}
							if (done) {
								const { text, truncated } = clip(JSON.stringify(item.result ?? item.error ?? ""));
								out.events.push({
									kind: "tool_result",
									toolId: id,
									output: text,
									isError: item.status === "failed" || item.error != null,
									...(truncated ? { truncated } : {}),
								});
							}
							break;
						}
						case "web_search": {
							if (!started.has(id)) {
								started.add(id);
								out.events.push({
									kind: "tool_call",
									toolId: id,
									name: "web_search",
									input: { query: str(item.query) ?? "" },
								});
							}
							break;
						}
						case "error": {
							const message = str(item.message);
							if (done && message) {
								out.events.push({ kind: "system", level: "warn", message });
							}
							break;
						}
					}
					break;
				}

				case "turn.completed": {
					sawResult = true;
					const usage = isRecord(msg.usage) ? msg.usage : {};
					const result: TurnResult = {
						outcome: "succeeded",
						usage: {
							inputTokens: num(usage.input_tokens),
							outputTokens: num(usage.output_tokens) + num(usage.reasoning_output_tokens),
							cachedTokens: num(usage.cached_input_tokens),
						},
					};
					if (lastMessage) result.result = lastMessage;
					out.result = result;
					break;
				}

				case "turn.failed": {
					sawResult = true;
					const error = isRecord(msg.error) ? str(msg.error.message) : undefined;
					out.result = { outcome: "failed", error: error ?? lastError ?? "Codex turn failed" };
					break;
				}

				case "error":
					lastError = str(msg.message) ?? lastError;
					break;
			}
			return out;
		},

		finish(exitCode, stderrTail) {
			if (sawResult) return undefined;
			if (exitCode === 0) {
				return { outcome: "succeeded", ...(lastMessage ? { result: lastMessage } : {}) };
			}
			const detail = lastError || stderrTail.trim().slice(-2000);
			return {
				outcome: "failed",
				error: `codex exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
			};
		},
	};
}

export const codex: Harness = {
	id: "codex",
	label: "Codex",
	provider: "openai",
	defaultModels: CODEX_MODELS,
	// Non-interactive `codex exec` has no approval callback, so approvals are unsupported.
	capabilities: { approvals: false, resume: true },

	command(input) {
		const baseUrl = `${input.gatewayUrl}/openai`;
		const common = [
			"--json",
			"--dangerously-bypass-approvals-and-sandbox",
			"--model",
			input.model,
			"--config",
			'model_provider="cloudflare-ai-gateway"',
			"--config",
			`model_providers.cloudflare-ai-gateway={ name = "Cloudflare AI Gateway", base_url = ${JSON.stringify(baseUrl)}, wire_api = "responses" }`,
			"--config",
			"analytics.enabled=false",
			"--config",
			"check_for_update_on_startup=false",
			"--config",
			"features.plugins=false",
		];
		// "-" tells codex to read the prompt from stdin.
		const argv = input.resumeSessionId
			? ["codex", "exec", "resume", ...common, input.resumeSessionId, "-"]
			: ["codex", "exec", ...common, "-"];
		return { argv, env: {} };
	},

	createParser: createCodexParser,
};
