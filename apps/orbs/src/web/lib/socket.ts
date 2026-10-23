export type ConnectionState = "connecting" | "open" | "reconnecting";

interface Options {
	/** Resolve the full ws(s):// URL, minting a fresh ticket each attempt. */
	url: () => Promise<string>;
	/** Sent right after the socket opens (e.g. a `hello` with the replay cursor). */
	hello: () => unknown;
	onMessage: (message: any) => void;
	onState: (state: ConnectionState) => void;
}

const PING = '{"type":"ping"}';
const HEARTBEAT_MS = 20_000;
const PONG_DEADLINE_MS = 10_000;

/**
 * A WebSocket that survives flaky mobile networks: exponential backoff with jitter,
 * a heartbeat that notices half-dead connections, and an immediate retry when the
 * page becomes visible or the network returns.
 */
export class ReconnectingSocket {
	private socket: WebSocket | undefined;
	private attempts = 0;
	private closed = false;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private pongTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly options: Options) {
		window.addEventListener("online", this.nudge);
		document.addEventListener("visibilitychange", this.nudge);
		void this.connect();
	}

	private nudge = () => {
		if (this.closed || document.visibilityState === "hidden") return;
		if (this.socket?.readyState === WebSocket.OPEN) return;
		clearTimeout(this.retryTimer);
		void this.connect();
	};

	private async connect(): Promise<void> {
		if (this.closed || this.socket?.readyState === WebSocket.CONNECTING) return;
		this.options.onState(this.attempts === 0 ? "connecting" : "reconnecting");
		try {
			const url = await this.options.url();
			if (this.closed) return;
			const socket = new WebSocket(url);
			this.socket = socket;
			socket.addEventListener("open", () => {
				this.attempts = 0;
				this.options.onState("open");
				socket.send(JSON.stringify(this.options.hello()));
				this.startHeartbeat(socket);
			});
			socket.addEventListener("message", (event) => {
				if (typeof event.data !== "string") return;
				const message = JSON.parse(event.data);
				if (message.type === "pong") clearTimeout(this.pongTimer);
				else this.options.onMessage(message);
			});
			socket.addEventListener("close", () => this.lost(socket));
			socket.addEventListener("error", () => socket.close());
		} catch {
			this.scheduleRetry();
		}
	}

	private startHeartbeat(socket: WebSocket): void {
		this.stopHeartbeat();
		this.heartbeat = setInterval(() => {
			if (socket.readyState !== WebSocket.OPEN) return;
			socket.send(PING);
			this.pongTimer = setTimeout(() => socket.close(), PONG_DEADLINE_MS);
		}, HEARTBEAT_MS);
	}

	private stopHeartbeat(): void {
		clearInterval(this.heartbeat);
		clearTimeout(this.pongTimer);
	}

	private lost(socket: WebSocket): void {
		if (this.socket !== socket) return;
		this.stopHeartbeat();
		if (!this.closed) this.scheduleRetry();
	}

	private scheduleRetry(): void {
		if (this.closed) return;
		this.options.onState("reconnecting");
		const delay = Math.min(30_000, 500 * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
		this.attempts++;
		clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => void this.connect(), delay);
	}

	/** Drop the connection and reconnect from scratch (e.g. after the cursor was reset). */
	restart(): void {
		this.socket?.close();
	}

	send(message: unknown): void {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
	}

	close(): void {
		this.closed = true;
		this.stopHeartbeat();
		clearTimeout(this.retryTimer);
		window.removeEventListener("online", this.nudge);
		document.removeEventListener("visibilitychange", this.nudge);
		this.socket?.close();
	}
}
