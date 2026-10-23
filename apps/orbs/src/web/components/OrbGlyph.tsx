import type { OrbStatus } from "@orbs/protocol/types";

type Look = "awake" | "running" | "ask" | "asleep" | "waking" | "failed" | "limit";

const LOOK: Record<OrbStatus, Look> = {
	provisioning: "waking",
	idle: "awake",
	running: "running",
	awaiting_approval: "ask",
	sleeping: "asleep",
	failed: "failed",
	budget_exceeded: "limit",
	archived: "asleep",
};

export const STATUS_LABEL: Record<OrbStatus, string> = {
	provisioning: "Waking",
	idle: "Awake",
	running: "Working",
	awaiting_approval: "Needs approval",
	sleeping: "Asleep",
	failed: "Needs attention",
	budget_exceeded: "Budget reached",
	archived: "Deleted",
};

/** The orb itself: a lit sphere while awake, a hollow ring while it sleeps. */
export function OrbGlyph({ status, size = 14 }: { status: OrbStatus; size?: number }) {
	return (
		<span
			className={`orb orb-${LOOK[status]}`}
			style={{ width: size, height: size }}
			role="img"
			aria-label={STATUS_LABEL[status]}
		/>
	);
}
