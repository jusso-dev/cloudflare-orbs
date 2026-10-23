import type { EventRecord, OrbStatus, PendingApproval, TurnOutcome } from "@orbs/protocol/types";

export type ApprovalState = "pending" | "allow" | "deny" | "allow_always" | "expired";

export interface ToolItem {
	type: "tool";
	seq: number;
	toolId: string;
	name: string;
	input: unknown;
	result?: { output: string; isError: boolean; truncated: boolean };
	approval?: { id: string; state: ApprovalState };
}

export type Item =
	| { type: "user"; seq: number; text: string; scheduled: boolean }
	| { type: "agent"; seq: number; text: string }
	| { type: "reasoning"; seq: number; text: string }
	| ToolItem
	| { type: "approval"; seq: number; approvalId: string; toolName: string; input: unknown; state: ApprovalState }
	| { type: "file"; seq: number; path: string; change: "add" | "update" | "delete" }
	| {
			type: "turn";
			seq: number;
			outcome: TurnOutcome;
			result?: string;
			error?: string;
			costUsd?: number;
			durationMs?: number;
	  }
	| { type: "system"; seq: number; level: "info" | "warn" | "error"; message: string }
	| { type: "sleep"; seq: number }
	| { type: "wake"; seq: number; reason?: string }
	| { type: "notice"; seq: number; status: OrbStatus; reason?: string };

/** Fold the persisted event log into what the conversation view renders. */
export function buildTimeline(records: EventRecord[]): Item[] {
	const items: Item[] = [];
	const tools = new Map<string, ToolItem>();
	let lastStatus: OrbStatus | undefined;

	// The approval request travels over the control plane and can reach the log before the
	// tool call it is about (which travels over the agent's output stream). Resolve approvals
	// up front so they attach to their tool call whichever arrived first.
	const toolIds = new Set<string>();
	for (const { event } of records) if (event.kind === "tool_call") toolIds.add(event.toolId);
	const approvalByTool = new Map<string, { id: string; state: ApprovalState }>();
	const approvalById = new Map<string, { id: string; state: ApprovalState; item?: Extract<Item, { type: "approval" }> }>();

	for (const { seq, event } of records) {
		switch (event.kind) {
			case "user_message":
				items.push({ type: "user", seq, text: event.text, scheduled: event.scheduled === true });
				break;
			case "agent_message":
				items.push({ type: "agent", seq, text: event.text });
				break;
			case "reasoning":
				items.push({ type: "reasoning", seq, text: event.text });
				break;
			case "tool_call": {
				const tool: ToolItem = { type: "tool", seq, toolId: event.toolId, name: event.name, input: event.input };
				const approval = approvalByTool.get(event.toolId);
				if (approval) tool.approval = approval;
				tools.set(event.toolId, tool);
				items.push(tool);
				break;
			}
			case "tool_result": {
				const tool = tools.get(event.toolId);
				const result = { output: event.output, isError: event.isError, truncated: event.truncated === true };
				if (tool) tool.result = result;
				else items.push({ type: "tool", seq, toolId: event.toolId, name: "result", input: {}, result });
				break;
			}
			case "file_change":
				items.push({ type: "file", seq, path: event.path, change: event.change });
				break;
			case "approval_requested": {
				const approval = { id: event.approvalId, state: "pending" as ApprovalState };
				approvalById.set(event.approvalId, approval);
				if (event.toolUseId && toolIds.has(event.toolUseId)) {
					// Shared by reference, so a later resolution updates the tool whether or not it exists yet.
					approvalByTool.set(event.toolUseId, approval);
					const tool = tools.get(event.toolUseId);
					if (tool) tool.approval = approval;
				} else {
					const item = {
						type: "approval" as const,
						seq,
						approvalId: event.approvalId,
						toolName: event.toolName,
						input: event.input,
						state: "pending" as ApprovalState,
					};
					items.push(item);
					approvalById.set(event.approvalId, { ...approval, item });
				}
				break;
			}
			case "approval_resolved": {
				const target = approvalById.get(event.approvalId);
				if (target) {
					target.state = event.decision;
					if (target.item) target.item.state = event.decision;
				}
				break;
			}
			case "turn_finished":
				items.push({
					type: "turn",
					seq,
					outcome: event.outcome,
					result: event.result,
					error: event.error,
					costUsd: event.costUsd,
					durationMs: event.durationMs,
				});
				break;
			case "system":
				items.push({ type: "system", seq, level: event.level, message: event.message });
				break;
			case "status": {
				const previous = lastStatus;
				lastStatus = event.status;
				if (event.status === "sleeping") items.push({ type: "sleep", seq });
				else if (event.status === "provisioning" && previous !== "provisioning") {
					items.push({ type: "wake", seq, reason: event.reason });
				} else if (event.status === "failed" || event.status === "budget_exceeded") {
					items.push({ type: "notice", seq, status: event.status, reason: event.reason });
				}
				break;
			}
			case "turn_started":
				break;
		}
	}
	return items;
}

export function pendingApprovals(items: Item[]): Array<{ approvalId: string; toolName: string; input: unknown }> {
	const pending: Array<{ approvalId: string; toolName: string; input: unknown }> = [];
	for (const item of items) {
		if (item.type === "tool" && item.approval?.state === "pending") {
			pending.push({ approvalId: item.approval.id, toolName: item.name, input: item.input });
		} else if (item.type === "approval" && item.state === "pending") {
			pending.push({ approvalId: item.approvalId, toolName: item.toolName, input: item.input });
		}
	}
	return pending;
}

export function fromPendingList(list: PendingApproval[]) {
	return list.map((a) => ({ approvalId: a.approvalId, toolName: a.toolName, input: a.input }));
}

/** One-line description of a tool call, drawn from the inputs agents commonly use. */
export function toolSummary(name: string, input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const fields = input as Record<string, unknown>;
	const pick = (...keys: string[]) => keys.map((key) => fields[key]).find((value) => typeof value === "string") as string | undefined;
	const text = pick("command", "file_path", "path", "pattern", "url", "query", "description") ?? "";
	return text.replace(/\s+/g, " ").slice(0, 200);
}
