import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventRecord, HubServerMessage, OrbSummary, ServerMessage } from "@orbs/protocol/types";
import { api, socketUrl } from "./api.ts";
import { ReconnectingSocket, type ConnectionState } from "./socket.ts";
import { buildTimeline, pendingApprovals, type Item } from "./timeline.ts";

export interface OrbStream {
	summary: OrbSummary | undefined;
	items: Item[];
	pending: Array<{ approvalId: string; toolName: string; input: unknown }>;
	/** Live, not-yet-persisted text of the message the agent is writing. */
	streaming: string;
	connection: ConnectionState;
	ready: boolean;
	missing: boolean;
}

/**
 * The live conversation for one orb. The server owns the log; this keeps a cursor,
 * replays whatever was missed on every (re)connect, and de-duplicates by sequence.
 */
export function useOrbStream(id: string): OrbStream {
	const [summary, setSummary] = useState<OrbSummary>();
	const [connection, setConnection] = useState<ConnectionState>("connecting");
	const [ready, setReady] = useState(false);
	const [missing, setMissing] = useState(false);
	const [streaming, setStreaming] = useState("");
	const [version, setVersion] = useState(0);
	const records = useRef(new Map<number, EventRecord>());
	const frame = useRef(0);
	const lastSeq = useRef(0);

	useEffect(() => {
		records.current = new Map();
		lastSeq.current = 0;
		setSummary(undefined);
		setReady(false);
		setMissing(false);
		setStreaming("");

		const bump = () => {
			if (frame.current) return;
			frame.current = requestAnimationFrame(() => {
				frame.current = 0;
				setVersion((v) => v + 1);
			});
		};
		const add = (record: EventRecord) => {
			records.current.set(record.seq, record);
			lastSeq.current = Math.max(lastSeq.current, record.seq);
			const kind = record.event.kind;
			if (kind === "agent_message" || kind === "turn_finished" || kind === "turn_started") setStreaming("");
		};

		const socket = new ReconnectingSocket({
			url: async () => socketUrl(`/api/orbs/${id}/ws`, (await api.ticket("events", id)).ticket),
			hello: () => ({ type: "hello", lastSeq: lastSeq.current }),
			onState: setConnection,
			onMessage: (message: ServerMessage) => {
				switch (message.type) {
					case "hello":
						setSummary(message.orb);
						if (message.lastSeq < lastSeq.current) {
							// The server's log is behind our cursor (orb was recreated): start over.
							records.current = new Map();
							lastSeq.current = 0;
							socket.send({ type: "hello", lastSeq: 0 });
						}
						setReady(true);
						bump();
						break;
					case "events":
						message.records.forEach(add);
						bump();
						break;
					case "event":
						add(message.record);
						bump();
						break;
					case "delta":
						setStreaming((text) => text + message.text);
						break;
					case "orb":
						setSummary(message.orb);
						break;
				}
			},
		});

		// A deleted or foreign orb never delivers a hello; the REST lookup tells us why.
		api.get(id).catch((error) => {
			if (error?.status === 404) setMissing(true);
		});

		return () => {
			socket.close();
			if (frame.current) cancelAnimationFrame(frame.current);
			frame.current = 0;
		};
	}, [id]);

	const items = useMemo(() => {
		const sorted = [...records.current.values()].sort((a, b) => a.seq - b.seq);
		return buildTimeline(sorted);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [version]);
	const pending = useMemo(() => pendingApprovals(items), [items]);

	return { summary, items, pending, streaming, connection, ready, missing };
}

/** The user's thread list: REST for the first paint, a hub socket to keep it live. */
export function useOrbList(): { orbs: OrbSummary[] | undefined; error: string | undefined; connection: ConnectionState } {
	const [orbs, setOrbs] = useState<OrbSummary[]>();
	const [error, setError] = useState<string>();
	const [connection, setConnection] = useState<ConnectionState>("connecting");

	useEffect(() => {
		api.list().then(setOrbs, (cause: Error) => setError(cause.message));
		const socket = new ReconnectingSocket({
			url: async () => socketUrl("/api/ws", (await api.hubTicket()).ticket),
			hello: () => ({ type: "hello" }),
			onState: setConnection,
			onMessage: (message: HubServerMessage) => {
				if (message.type === "orbs") setOrbs(message.orbs);
				else if (message.type === "orb") {
					setOrbs((current) => [message.orb, ...(current ?? []).filter((orb) => orb.id !== message.orb.id)]);
				} else if (message.type === "removed") {
					setOrbs((current) => (current ?? []).filter((orb) => orb.id !== message.id));
				}
			},
		});
		return () => socket.close();
	}, []);

	const sorted = useMemo(() => orbs && [...orbs].sort((a, b) => b.updatedAt - a.updatedAt), [orbs]);
	return { orbs: sorted, error, connection };
}

/** Run an async action with pending/error state, for buttons. */
export function useAction<Args extends unknown[]>(action: (...args: Args) => Promise<unknown>) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const run = useCallback(
		async (...args: Args) => {
			setBusy(true);
			setError(undefined);
			try {
				return await action(...args);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
				return undefined;
			} finally {
				setBusy(false);
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[action],
	);
	return { run, busy, error, clear: () => setError(undefined) };
}
