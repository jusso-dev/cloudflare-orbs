import type { Harness, ParsedLine, EventParser, TurnResult } from "./types.ts";
import { clip, emptyParsed, isRecord, MAX_TEXT_CHARS, num, safeJson, str } from "./util.ts";

/** Pinned in the container image; flags and event format can change between releases. */
export const CLAUDE_CODE_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"];

export function createClaudeParser(): EventParser {
	let sawResult = false;

	function toolResultText(content: unknown): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
				.filter(Boolean)
				.join("\n");
		}
		return "";
	}

	return {
		parse(line: string): ParsedLine {
			const out = emptyParsed();
			const msg = safeJson(line);
			if (!isRecord(msg)) return out;

			switch (msg.type) {
				case "system": {
					if (msg.subtype === "init") {
						out.sessionId = str(msg.session_id);
					} else if (msg.subtype === "permission_denied") {
						out.events.push({
							kind: "system",
							level: "warn",
							message: `Permission denied for ${str(msg.tool_name) ?? "tool"}: ${str(msg.message) ?? "requires approval"}`,
						});
					}
					break;
				}
				case "stream_event": {
					const event = msg.event;
					if (isRecord(event) && event.type === "content_block_delta" && isRecord(event.delta)) {
						const delta = event.delta;
						if (delta.type === "text_delta" && typeof delta.text === "string") {
							out.deltas.push(delta.text);
						}
					}
					break;
				}
				case "assistant": {
					const message = msg.message;
					if (!isRecord(message) || !Array.isArray(message.content)) break;
					for (const block of message.content) {
						if (!isRecord(block)) continue;
						if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
							out.events.push({
								kind: "agent_message",
								text: clip(block.text, MAX_TEXT_CHARS).text,
							});
						} else if (block.type === "tool_use" && typeof block.id === "string") {
							out.events.push({
								kind: "tool_call",
								toolId: block.id,
								name: str(block.name) ?? "tool",
								input: block.input ?? {},
							});
						} else if (
							block.type === "thinking" &&
							typeof block.thinking === "string" &&
							block.thinking.trim()
						) {
							out.events.push({ kind: "reasoning", text: clip(block.thinking).text });
						}
					}
					break;
				}
				case "user": {
					const message = msg.message;
					if (!isRecord(message) || !Array.isArray(message.content)) break;
					for (const block of message.content) {
						if (!isRecord(block) || block.type !== "tool_result") continue;
						const toolId = str(block.tool_use_id);
						if (!toolId) continue;
						const { text, truncated } = clip(toolResultText(block.content));
						out.events.push({
							kind: "tool_result",
							toolId,
							output: text,
							isError: block.is_error === true,
							...(truncated ? { truncated } : {}),
						});
					}
					break;
				}
				case "result": {
					sawResult = true;
					out.sessionId = str(msg.session_id);
					const usage = isRecord(msg.usage) ? msg.usage : {};
					const result: TurnResult = {
						outcome: msg.is_error === true || msg.subtype !== "success" ? "failed" : "succeeded",
						costUsd: num(msg.total_cost_usd),
						usage: {
							inputTokens: num(usage.input_tokens) + num(usage.cache_creation_input_tokens),
							outputTokens: num(usage.output_tokens),
							cachedTokens: num(usage.cache_read_input_tokens),
						},
					};
					const text = str(msg.result);
					if (result.outcome === "succeeded") {
						if (text) result.result = text;
					} else {
						result.error = text || str(msg.subtype) || "Claude Code reported an error";
					}
					out.result = result;
					break;
				}
			}
			return out;
		},

		finish(exitCode, stderrTail) {
			if (sawResult) return undefined;
			const detail = stderrTail.trim().slice(-2000);
			return {
				outcome: "failed",
				error: `claude exited with code ${exitCode} without a result${detail ? `: ${detail}` : ""}`,
			};
		},
	};
}

export const claudeCode: Harness = {
	id: "claude-code",
	label: "Claude Code",
	provider: "anthropic",
	defaultModels: CLAUDE_CODE_MODELS,
	capabilities: { approvals: true, resume: true },

	command(input) {
		const argv = [
			"claude",
			"--print",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			input.model,
		];
		if (input.resumeSessionId) argv.push("--resume", input.resumeSessionId);
		if (input.maxBudgetUsd !== undefined && input.maxBudgetUsd > 0) {
			argv.push("--max-budget-usd", input.maxBudgetUsd.toFixed(2));
		}
		if (input.approvalMode === "auto") {
			// The sandbox (no direct egress, no secrets) is the boundary, not Claude's prompts.
			argv.push("--dangerously-skip-permissions");
		} else {
			argv.push(
				"--permission-mode",
				"default",
				"--permission-prompt-tool",
				"mcp__orb__approve",
				"--mcp-config",
				"/opt/orb/mcp.json",
				"--strict-mcp-config",
			);
		}
		return {
			argv,
			env: {
				ANTHROPIC_BASE_URL: `${input.gatewayUrl}/anthropic`,
				// Claude Code refuses to start without a key. The Worker strips this and adds the gateway token.
				ANTHROPIC_API_KEY: "provided-by-worker",
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				IS_SANDBOX: "1",
			},
		};
	},

	createParser: createClaudeParser,
};
