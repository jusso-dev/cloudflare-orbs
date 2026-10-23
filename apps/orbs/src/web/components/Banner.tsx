import type { ConnectionState } from "../lib/socket.ts";

export function ConnectionBanner({ state }: { state: ConnectionState }) {
	if (state === "open") return null;
	return (
		<div className="banner banner-warn" role="status">
			{state === "connecting" ? "Connecting…" : "Connection lost. Reconnecting; nothing is lost, the orb keeps working."}
		</div>
	);
}
