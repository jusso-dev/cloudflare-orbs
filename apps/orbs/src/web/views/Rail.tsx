import { Link, useRoute } from "wouter";
import type { OrbSummary } from "@orbs/protocol/types";
import { ConnectionBanner } from "../components/Banner.tsx";
import { OrbGlyph, STATUS_LABEL } from "../components/OrbGlyph.tsx";
import { compact, money, relativeTime, repoName } from "../lib/format.ts";
import type { ConnectionState } from "../lib/socket.ts";
import { useConfig } from "../lib/context.ts";

export function Rail({
	orbs,
	error,
	connection,
}: {
	orbs: OrbSummary[] | undefined;
	error: string | undefined;
	connection: ConnectionState;
}) {
	const config = useConfig();
	const awake = (orbs ?? []).filter((orb) => ["provisioning", "idle", "running", "awaiting_approval"].includes(orb.status)).length;

	return (
		<aside className="rail">
			<div className="rail-head">
				<Link href="/" className="wordmark">
					<OrbGlyph status="idle" size={16} />
					Orbs
				</Link>
				<Link href="/new" className="btn btn-primary">
					New orb
				</Link>
			</div>
			<ConnectionBanner state={connection} />
			{error && <div className="banner banner-error">{error}</div>}
			<nav className="rail-list" aria-label="Your orbs">
				{orbs === undefined && !error && <p className="rail-note">Loading…</p>}
				{orbs?.length === 0 && (
					<p className="rail-note">
						No orbs yet. An orb is a remote workspace for a coding agent. It sleeps when idle and costs nothing until you wake it.
					</p>
				)}
				{orbs?.map((orb) => <RailItem key={orb.id} orb={orb} />)}
			</nav>
			<footer className="rail-foot">
				<Link href="/usage">
					{awake} of {config.limits.maxConcurrentOrbs} awake
				</Link>
				<span title={config.user.label}>{config.user.label}</span>
			</footer>
		</aside>
	);
}

function RailItem({ orb }: { orb: OrbSummary }) {
	const [active] = useRoute(`/orbs/${orb.id}`);
	const quiet = orb.status === "sleeping" ? `Asleep ${relativeTime(orb.lastActivityAt)}` : STATUS_LABEL[orb.status];
	return (
		<Link href={`/orbs/${orb.id}`} className={active ? "rail-item rail-item-active" : "rail-item"} aria-current={active ? "page" : undefined}>
			<OrbGlyph status={orb.status} size={14} />
			<span className="rail-item-body">
				<span className="rail-item-title">{orb.title}</span>
				<span className="rail-item-sub">{repoName(orb.repoUrl)}</span>
				<span className="rail-item-meta">
					<span className={`status-text status-${orb.status}`}>{orb.statusReason && orb.status !== "sleeping" ? orb.statusReason : quiet}</span>
					{orb.usage.costUsd > 0 && <span>{money(orb.usage.costUsd)}</span>}
					{orb.usage.inputTokens + orb.usage.outputTokens > 0 && <span>{compact(orb.usage.inputTokens + orb.usage.outputTokens)} tokens</span>}
				</span>
			</span>
		</Link>
	);
}
