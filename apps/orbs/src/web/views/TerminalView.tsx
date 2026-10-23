import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, socketUrl } from "../lib/api.ts";

/**
 * A shell inside the orb's workspace. It runs in tmux on the container, so closing the
 * tab (or losing signal on a train) leaves the session, and any running command, intact.
 */
export function TerminalView({ orbId, asleep }: { orbId: string; asleep: boolean }) {
	const host = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
	const [attempt, setAttempt] = useState(0);
	const [note, setNote] = useState("");

	useEffect(() => {
		const el = host.current;
		if (!el) return;
		const style = getComputedStyle(document.documentElement);
		const terminal = new Terminal({
			fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
			fontSize: 13,
			cursorBlink: true,
			macOptionClickForcesSelection: true,
			theme: {
				background: style.getPropertyValue("--surface-deep").trim() || "#0a0d1c",
				foreground: style.getPropertyValue("--text").trim() || "#e9ebf5",
				cursor: style.getPropertyValue("--accent").trim() || "#93a4ff",
			},
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(el);
		fit.fit();

		let socket: WebSocket | undefined;
		let disposed = false;
		const encoder = new TextEncoder();
		setState("connecting");
		setNote(asleep ? "Waking the workspace…" : "");

		void (async () => {
			try {
				const { ticket } = await api.ticket("terminal", orbId);
				if (disposed) return;
				const url = new URL(socketUrl(`/api/orbs/${orbId}/terminal`, ticket));
				url.searchParams.set("cols", String(terminal.cols));
				url.searchParams.set("rows", String(terminal.rows));
				socket = new WebSocket(url);
				socket.binaryType = "arraybuffer";
				socket.addEventListener("open", () => {
					setState("open");
					setNote("");
					terminal.focus();
				});
				socket.addEventListener("message", (event) => terminal.write(new Uint8Array(event.data as ArrayBuffer)));
				socket.addEventListener("close", (event) => {
					if (disposed) return;
					setState("closed");
					setNote(event.reason || "Disconnected");
				});
				socket.addEventListener("error", () => {
					if (!disposed) setNote("Could not open a terminal");
				});
			} catch (cause) {
				setState("closed");
				setNote(cause instanceof Error ? cause.message : "Could not open a terminal");
			}
		})();

		const data = terminal.onData((input) => {
			if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(input));
		});
		const resize = terminal.onResize(({ cols, rows }) => {
			if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ cols, rows }));
		});
		const observer = new ResizeObserver(() => fit.fit());
		observer.observe(el);

		return () => {
			disposed = true;
			observer.disconnect();
			data.dispose();
			resize.dispose();
			socket?.close();
			terminal.dispose();
		};
		// `asleep` only changes the message shown while connecting.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [orbId, attempt]);

	return (
		<div className="panel terminal">
			<div className="panel-bar">
				<strong>Terminal</strong>
				<span className="muted">{state === "open" ? "Connected to the workspace" : note}</span>
				<div className="panel-actions">
					{state === "closed" && (
						<button className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
							Reconnect
						</button>
					)}
				</div>
			</div>
			<div className="terminal-host" ref={host} />
		</div>
	);
}
