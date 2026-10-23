import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "../components/Markdown.tsx";
import { duration, money } from "../lib/format.ts";
import { toolSummary, type Item, type ToolItem } from "../lib/timeline.ts";

export function Conversation({
	items,
	streaming,
	working,
}: {
	items: Item[];
	streaming: string;
	working: boolean;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const [away, setAway] = useState(false);

	// Follow new output only while the reader is at the bottom; otherwise offer a way back.
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [items, streaming]);

	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const onScroll = () => {
			const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
			pinned.current = near;
			setAway(!near);
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, []);

	return (
		<div className="conversation" ref={scroller}>
			<div className="conversation-inner">
				{items.map((item) => (
					<ItemView key={item.seq} item={item} />
				))}
				{streaming && (
					<div className="agent streaming">
						<Markdown text={streaming} />
					</div>
				)}
				{working && !streaming && <div className="thinking" aria-label="The agent is working" />}
			</div>
			{away && (
				<button
					className="jump"
					onClick={() => {
						const el = scroller.current;
						if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
					}}
				>
					Latest
				</button>
			)}
		</div>
	);
}

function ItemView({ item }: { item: Item }) {
	switch (item.type) {
		case "user":
			return (
				<div className="user">
					{item.scheduled && <span className="chip">Scheduled</span>}
					<p>{item.text}</p>
				</div>
			);
		case "agent":
			return (
				<div className="agent">
					<Markdown text={item.text} />
				</div>
			);
		case "reasoning":
			return (
				<details className="reasoning">
					<summary>Thinking</summary>
					<p>{item.text}</p>
				</details>
			);
		case "tool":
			return <Tool tool={item} />;
		case "approval":
			return (
				<div className={`tool tool-approval approval-${item.state}`}>
					<div className="tool-head">
						<span className="tool-name">{item.toolName}</span>
						<span className="tool-summary">{toolSummary(item.toolName, item.input)}</span>
						<ApprovalChip state={item.state} />
					</div>
				</div>
			);
		case "file":
			return (
				<div className="file-change">
					<span className={`change change-${item.change}`}>{item.change === "add" ? "added" : item.change === "delete" ? "deleted" : "edited"}</span>
					<code>{item.path}</code>
				</div>
			);
		case "turn":
			return <TurnEnd item={item} />;
		case "system":
			return <div className={`system system-${item.level}`}>{item.message}</div>;
		case "sleep":
			return (
				<div className="horizon" role="separator">
					<span>Asleep. Workspace saved.</span>
				</div>
			);
		case "wake":
			return <div className="system system-wake">{item.reason ?? "Waking up…"}</div>;
		case "notice":
			return (
				<div className={`system system-${item.status === "failed" ? "error" : "warn"}`}>
					{item.reason ?? (item.status === "failed" ? "Something went wrong." : "Budget reached.")}
				</div>
			);
	}
}

function ApprovalChip({ state }: { state: NonNullable<ToolItem["approval"]>["state"] }) {
	const label = {
		pending: "Needs approval",
		allow: "Allowed",
		allow_always: "Always allowed",
		deny: "Denied",
		expired: "Not answered",
	}[state];
	return <span className={`chip chip-${state}`}>{label}</span>;
}

function Tool({ tool }: { tool: ToolItem }) {
	const [open, setOpen] = useState(false);
	const summary = toolSummary(tool.name, tool.input);
	const status = tool.result ? (tool.result.isError ? "error" : "done") : "running";
	const input = typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input, null, 2);

	return (
		<div className={`tool tool-${status}`}>
			<button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className="tool-name">{tool.name}</span>
				<span className="tool-summary">{summary}</span>
				{tool.approval && <ApprovalChip state={tool.approval.state} />}
				<span className="tool-state" aria-hidden="true" />
			</button>
			{open && (
				<div className="tool-detail">
					<pre>{input}</pre>
					{tool.result && (
						<pre className={tool.result.isError ? "is-error" : ""}>
							{tool.result.output || "(no output)"}
							{tool.result.truncated ? "\n[output shortened]" : ""}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}

function TurnEnd({ item }: { item: Extract<Item, { type: "turn" }> }) {
	const facts = [
		item.durationMs ? duration(item.durationMs / 1000) : undefined,
		item.costUsd ? money(item.costUsd) : undefined,
	].filter(Boolean);
	const label = { succeeded: "Done", failed: "Failed", interrupted: "Stopped", lost: "Interrupted" }[item.outcome];
	return (
		<div className={`turn-end turn-${item.outcome}`}>
			<span>{label}</span>
			{facts.length > 0 && <span className="facts">{facts.join("  ")}</span>}
			{item.error && <span className="turn-error">{item.error}</span>}
		</div>
	);
}

