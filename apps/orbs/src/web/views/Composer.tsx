import { useEffect, useRef, useState } from "react";
import type { OrbSummary } from "@orbs/protocol/types";
import { Dialog } from "../components/Dialog.tsx";
import { api } from "../lib/api.ts";
import { clockTime } from "../lib/format.ts";
import { useAction } from "../lib/hooks.ts";

type PendingApprovals = Array<{ approvalId: string; toolName: string; input: unknown }>;

export function Composer({ orb, pending }: { orb: OrbSummary; pending: PendingApprovals }) {
	const [text, setText] = useState("");
	const field = useRef<HTMLTextAreaElement>(null);
	const [scheduling, setScheduling] = useState(false);
	const send = useAction((message: string) => api.send(orb.id, message));
	const stop = useAction(() => api.interrupt(orb.id));

	const working = orb.status === "running" || orb.status === "awaiting_approval" || orb.status === "provisioning";
	const asleep = orb.status === "sleeping";

	// Grow with the content, up to a cap.
	useEffect(() => {
		const el = field.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
	}, [text]);

	const submit = async () => {
		const value = text.trim();
		if (!value) return;
		const result = await send.run(value);
		if (result) setText("");
	};

	return (
		<div className="composer">
			{pending.length > 0 && <ApprovalTray orbId={orb.id} pending={pending} />}
			{send.error && (
				<div className="banner banner-error" role="alert">
					{send.error}
				</div>
			)}
			<div className="composer-row">
				<textarea
					ref={field}
					rows={1}
					value={text}
					placeholder={asleep ? "Send a message to wake this orb" : working ? "Queue a follow-up" : "Message the agent"}
					aria-label="Message"
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						// On touch devices Enter is a newline; the button sends.
						const fine = window.matchMedia("(pointer: fine)").matches;
						if (event.key === "Enter" && !event.shiftKey && fine && !event.nativeEvent.isComposing) {
							event.preventDefault();
							void submit();
						}
					}}
				/>
				<div className="composer-actions">
					<button className="icon-btn" onClick={() => setScheduling(true)} title="Schedule a message" aria-label="Schedule a message">
						<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
							<circle cx="10" cy="10" r="7.25" />
							<path d="M10 5.5V10l3 2" strokeLinecap="round" />
						</svg>
					</button>
					{working && (
						<button className="btn btn-quiet" onClick={() => void stop.run()} disabled={stop.busy}>
							Stop
						</button>
					)}
					<button className="btn btn-primary" onClick={() => void submit()} disabled={!text.trim() || send.busy}>
						{asleep ? "Wake & send" : working ? "Queue" : "Send"}
					</button>
				</div>
			</div>
			<ScheduleDialog orb={orb} open={scheduling} onClose={() => setScheduling(false)} initialText={text} />
		</div>
	);
}

function ApprovalTray({ orbId, pending }: { orbId: string; pending: PendingApprovals }) {
	const decide = useAction((approvalId: string, decision: "allow" | "deny" | "allow_always") =>
		api.approve(orbId, approvalId, decision),
	);
	const current = pending[0]!;
	const input = typeof current.input === "string" ? current.input : JSON.stringify(current.input, null, 2);

	return (
		<section className="approval-tray" aria-live="polite">
			<header>
				<strong>{current.toolName}</strong> wants to run
				{pending.length > 1 && <span className="chip">{pending.length - 1} more waiting</span>}
			</header>
			<pre>{input.length > 900 ? `${input.slice(0, 900)}…` : input}</pre>
			{decide.error && <p className="field-error">{decide.error}</p>}
			<div className="approval-actions">
				<button className="btn btn-primary" disabled={decide.busy} onClick={() => void decide.run(current.approvalId, "allow")}>
					Allow
				</button>
				<button className="btn" disabled={decide.busy} onClick={() => void decide.run(current.approvalId, "allow_always")}>
					Always allow {current.toolName}
				</button>
				<button className="btn btn-danger" disabled={decide.busy} onClick={() => void decide.run(current.approvalId, "deny")}>
					Deny
				</button>
			</div>
		</section>
	);
}

function localInputValue(ms: number): string {
	const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
	return date.toISOString().slice(0, 16);
}

function ScheduleDialog({
	orb,
	open,
	onClose,
	initialText,
}: {
	orb: OrbSummary;
	open: boolean;
	onClose: () => void;
	initialText: string;
}) {
	const [when, setWhen] = useState(() => localInputValue(Date.now() + 60 * 60_000));
	const [message, setMessage] = useState(initialText);
	const [existing, setExisting] = useState<Array<{ id: string; runAt: number; text: string }>>([]);
	const schedule = useAction((at: number, text: string) => api.schedule(orb.id, at, text));

	useEffect(() => {
		if (!open) return;
		setMessage(initialText);
		api.scheduled(orb.id).then(setExisting, () => {});
	}, [open, orb.id, initialText]);

	return (
		<Dialog open={open} onClose={onClose} title="Schedule a message">
			<p className="muted">The orb wakes at that time, sends the message to the agent, and goes back to sleep when it is done.</p>
			<label className="field">
				<span>When</span>
				<input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
			</label>
			<label className="field">
				<span>Message</span>
				<textarea rows={4} value={message} onChange={(event) => setMessage(event.target.value)} />
			</label>
			{schedule.error && <p className="field-error">{schedule.error}</p>}
			{existing.length > 0 && (
				<ul className="scheduled-list">
					{existing.map((item) => (
						<li key={item.id}>
							<span>
								<strong>{clockTime(item.runAt)}</strong> {item.text.slice(0, 80)}
							</span>
							<button
								className="btn btn-quiet"
								onClick={async () => {
									await api.unschedule(orb.id, item.id);
									setExisting((list) => list.filter((entry) => entry.id !== item.id));
								}}
							>
								Cancel
							</button>
						</li>
					))}
				</ul>
			)}
			<div className="dialog-actions">
				<button className="btn btn-quiet" onClick={onClose}>
					Close
				</button>
				<button
					className="btn btn-primary"
					disabled={!message.trim() || schedule.busy}
					onClick={async () => {
						const result = await schedule.run(new Date(when).getTime(), message.trim());
						if (result) onClose();
					}}
				>
					Schedule
				</button>
			</div>
		</Dialog>
	);
}
