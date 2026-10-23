import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import type { OrbSummary } from "@orbs/protocol/types";
import { ConnectionBanner } from "../components/Banner.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { OrbGlyph, STATUS_LABEL } from "../components/OrbGlyph.tsx";
import { api } from "../lib/api.ts";
import { clockTime, compact, duration, money, relativeTime, repoName } from "../lib/format.ts";
import { useAction, useOrbStream } from "../lib/hooks.ts";
import { Composer } from "./Composer.tsx";
import { Conversation } from "./Conversation.tsx";
import { DiffView } from "./DiffView.tsx";
import { TerminalView } from "./TerminalView.tsx";

type Tab = "chat" | "changes" | "terminal";

export function OrbView({ id }: { id: string }) {
	const stream = useOrbStream(id);
	const [tab, setTab] = useState<Tab>("chat");
	const { summary } = stream;

	useEffect(() => {
		if (summary) document.title = `${summary.title} · Orbs`;
		return () => {
			document.title = "Orbs";
		};
	}, [summary?.title]);

	if (stream.missing) {
		return (
			<div className="empty-state">
				<h2>This orb does not exist</h2>
				<p>It may have been deleted.</p>
				<Link className="btn" href="/">
					Back to your orbs
				</Link>
			</div>
		);
	}
	if (!summary) {
		return (
			<div className="orb-view">
				<ConnectionBanner state={stream.connection} />
				<div className="loading" role="status">Loading…</div>
			</div>
		);
	}

	const working = summary.status === "running" || summary.status === "awaiting_approval" || summary.status === "provisioning";

	return (
		<div className="orb-view">
			<Header orb={summary} />
			<ConnectionBanner state={stream.connection} />
			<nav className="tabs" role="tablist">
				{(
					[
						["chat", "Conversation"],
						["changes", "Changes"],
						["terminal", "Terminal"],
					] as const
				).map(([key, label]) => (
					<button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "tab tab-active" : "tab"} onClick={() => setTab(key)}>
						{label}
						{key === "chat" && stream.pending.length > 0 && <span className="tab-dot" aria-label="Needs approval" />}
					</button>
				))}
			</nav>
			{tab === "chat" && (
				<>
					<Conversation items={stream.items} streaming={stream.streaming} working={working && stream.pending.length === 0} />
					<Composer orb={summary} pending={stream.pending} />
				</>
			)}
			{tab === "changes" && <DiffView orb={summary} />}
			{tab === "terminal" && <TerminalView orbId={id} asleep={summary.status === "sleeping"} />}
		</div>
	);
}

function Header({ orb }: { orb: OrbSummary }) {
	const [, navigate] = useLocation();
	const [dialog, setDialog] = useState<"budget" | "preview" | "delete" | undefined>();
	const sleep = useAction(() => api.sleep(orb.id));
	const wake = useAction(() => api.wake(orb.id));
	const snapshot = useAction(() => api.snapshot(orb.id));
	const awake = orb.status !== "sleeping" && orb.status !== "failed" && orb.status !== "budget_exceeded";
	const canSleep = orb.status === "idle";
	const busyError = sleep.error ?? wake.error ?? snapshot.error;

	return (
		<header className="orb-header">
			<Link href="/" className="back" aria-label="All orbs">
				<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
					<path d="M12.5 4.5 7 10l5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</Link>
			<div className="orb-title">
				<h1>{orb.title}</h1>
				<p className="orb-sub">
					<a href={orb.repoUrl} target="_blank" rel="noopener noreferrer">
						{repoName(orb.repoUrl)}
					</a>
					{orb.branch && <code>{orb.branch}</code>}
					<span>{orb.harness === "claude-code" ? "Claude Code" : orb.harness === "codex" ? "Codex" : "Demo"}</span>
				</p>
			</div>
			<div className="orb-state">
				<span className="state-line">
					<OrbGlyph status={orb.status} size={12} />
					{STATUS_LABEL[orb.status]}
				</span>
				<span className="state-detail" title={orb.statusReason}>
					{orb.statusReason ?? (orb.status === "sleeping" ? `since ${relativeTime(orb.updatedAt)}` : "")}
					{orb.nextWakeAt && orb.status === "sleeping" ? `Wakes ${clockTime(orb.nextWakeAt)}` : ""}
				</span>
			</div>
			<div className="orb-actions">
				{orb.status === "sleeping" && (
					<button className="btn" onClick={() => void wake.run()} disabled={wake.busy}>
						Wake
					</button>
				)}
				{canSleep && (
					<button className="btn" onClick={() => void sleep.run()} disabled={sleep.busy}>
						{sleep.busy ? "Saving…" : "Sleep"}
					</button>
				)}
				<details className="menu">
					<summary className="icon-btn" aria-label="More actions">
						<svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true">
							<circle cx="4.5" cy="10" r="1.5" />
							<circle cx="10" cy="10" r="1.5" />
							<circle cx="15.5" cy="10" r="1.5" />
						</svg>
					</summary>
					<div className="menu-list" onClick={(event) => (event.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}>
						<button onClick={() => void snapshot.run()} disabled={!awake || snapshot.busy}>
							Save a snapshot now
						</button>
						<button onClick={() => setDialog("preview")} disabled={!awake}>
							Open a preview port…
						</button>
						<button onClick={() => setDialog("budget")}>Budget…</button>
						<button className="danger" onClick={() => setDialog("delete")}>
							Delete orb…
						</button>
					</div>
				</details>
			</div>
			<ul className="chips" aria-label="Usage">
				<li>{money(orb.usage.costUsd)}{orb.budget.maxCostUsd ? ` of ${money(orb.budget.maxCostUsd)}` : ""}</li>
				<li>{duration(orb.usage.containerSeconds)} awake</li>
				<li>{orb.usage.turns} turn{orb.usage.turns === 1 ? "" : "s"}</li>
				<li>{compact(orb.usage.inputTokens + orb.usage.outputTokens)} tokens</li>
				{orb.hasSnapshot && <li>Snapshot saved</li>}
			</ul>
			{busyError && (
				<div className="banner banner-error header-banner" role="alert">
					{busyError}
				</div>
			)}
			<BudgetDialog orb={orb} open={dialog === "budget"} onClose={() => setDialog(undefined)} />
			<PreviewDialog orb={orb} open={dialog === "preview"} onClose={() => setDialog(undefined)} />
			<DeleteDialog
				orb={orb}
				open={dialog === "delete"}
				onClose={() => setDialog(undefined)}
				onDeleted={() => navigate("/")}
			/>
		</header>
	);
}

function BudgetDialog({ orb, open, onClose }: { orb: OrbSummary; open: boolean; onClose: () => void }) {
	const [cost, setCost] = useState("");
	const [minutes, setMinutes] = useState("");
	const save = useAction((body: { maxCostUsd?: number; maxRuntimeMinutes?: number }) => api.budget(orb.id, body));

	useEffect(() => {
		if (!open) return;
		setCost(orb.budget.maxCostUsd?.toString() ?? "");
		setMinutes(orb.budget.maxRuntimeMinutes?.toString() ?? "");
	}, [open, orb.budget.maxCostUsd, orb.budget.maxRuntimeMinutes]);

	return (
		<Dialog open={open} onClose={onClose} title="Budget">
			<p className="muted">
				The orb stops when it reaches either limit. So far: {money(orb.usage.costUsd)} in model costs and {duration(orb.usage.containerSeconds)} awake. Leave a field empty for no limit.
			</p>
			<label className="field">
				<span>Model spend limit (USD)</span>
				<input inputMode="decimal" value={cost} onChange={(event) => setCost(event.target.value)} placeholder="No limit" />
			</label>
			<label className="field">
				<span>Awake time limit (minutes)</span>
				<input inputMode="numeric" value={minutes} onChange={(event) => setMinutes(event.target.value)} placeholder="No limit" />
			</label>
			{save.error && <p className="field-error">{save.error}</p>}
			<div className="dialog-actions">
				<button className="btn btn-quiet" onClick={onClose}>
					Cancel
				</button>
				<button
					className="btn btn-primary"
					disabled={save.busy}
					onClick={async () => {
						const maxCostUsd = cost.trim() ? Number(cost) : undefined;
						const maxRuntimeMinutes = minutes.trim() ? Math.round(Number(minutes)) : undefined;
						if ((maxCostUsd !== undefined && !(maxCostUsd > 0)) || (maxRuntimeMinutes !== undefined && !(maxRuntimeMinutes > 0))) return;
						if (await save.run({ maxCostUsd, maxRuntimeMinutes })) onClose();
					}}
				>
					Save
				</button>
			</div>
		</Dialog>
	);
}

function PreviewDialog({ orb, open, onClose }: { orb: OrbSummary; open: boolean; onClose: () => void }) {
	const [port, setPort] = useState("3000");
	const openPreview = useAction(async (value: number) => {
		const { ticket } = await api.ticket("preview", orb.id);
		window.open(`/api/orbs/${orb.id}/preview/${value}/?ticket=${encodeURIComponent(ticket)}`, "_blank", "noopener");
		return true;
	});

	return (
		<Dialog open={open} onClose={onClose} title="Open a preview">
			<p className="muted">
				Opens a web server running in the workspace. The page is sandboxed, so scripts that depend on cookies or local storage will not work.
			</p>
			<label className="field">
				<span>Port</span>
				<input inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} />
			</label>
			{openPreview.error && <p className="field-error">{openPreview.error}</p>}
			<div className="dialog-actions">
				<button className="btn btn-quiet" onClick={onClose}>
					Cancel
				</button>
				<button
					className="btn btn-primary"
					disabled={openPreview.busy}
					onClick={async () => {
						const value = Number(port);
						if (Number.isInteger(value) && value >= 1024 && value <= 65535 && (await openPreview.run(value))) onClose();
					}}
				>
					Open preview
				</button>
			</div>
		</Dialog>
	);
}

function DeleteDialog({
	orb,
	open,
	onClose,
	onDeleted,
}: {
	orb: OrbSummary;
	open: boolean;
	onClose: () => void;
	onDeleted: () => void;
}) {
	const remove = useAction(() => api.remove(orb.id));
	return (
		<Dialog open={open} onClose={onClose} title="Delete this orb?">
			<p className="muted">
				This removes the conversation, the saved workspace and any recovery data. Changes that were not pushed to GitHub are lost.
			</p>
			{remove.error && <p className="field-error">{remove.error}</p>}
			<div className="dialog-actions">
				<button className="btn btn-quiet" onClick={onClose}>
					Keep it
				</button>
				<button
					className="btn btn-danger"
					disabled={remove.busy}
					onClick={async () => {
						if (await remove.run()) onDeleted();
					}}
				>
					Delete orb
				</button>
			</div>
		</Dialog>
	);
}
