import { DurableObject } from "cloudflare:workers";
import { EMPTY_USAGE, addUsage, isAwake, type HubServerMessage, type OrbSummary, type UsageResponse } from "@orbs/protocol";
import { readSettings } from "./settings.ts";

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

/**
 * One per user. Holds the thread list, aggregates usage across orbs, and enforces
 * the per-user cap on concurrently awake orbs. Orbs push their summaries here.
 */
export class UserHub extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS orbs (
				id TEXT PRIMARY KEY,
				summary TEXT NOT NULL,
				awake INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL
			)`);
		});
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
	}

	upsertOrb(summary: OrbSummary): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO orbs (id, summary, awake, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, awake = excluded.awake, updated_at = excluded.updated_at`,
			summary.id,
			JSON.stringify(summary),
			isAwake(summary.status) ? 1 : 0,
			summary.updatedAt,
		);
		this.broadcast({ type: "orb", orb: summary });
	}

	removeOrb(id: string): void {
		this.ctx.storage.sql.exec("DELETE FROM orbs WHERE id = ?", id);
		this.broadcast({ type: "removed", id });
	}

	/**
	 * Reserve one of the user's awake slots for `id`. Atomic because this object
	 * serialises calls, so two orbs waking at once cannot both take the last slot.
	 */
	claimSlot(id: string, max: number): boolean {
		const sql = this.ctx.storage.sql;
		const mine = sql.exec<{ awake: number }>("SELECT awake FROM orbs WHERE id = ?", id).toArray()[0];
		if (mine?.awake === 1) return true;
		const others = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM orbs WHERE awake = 1 AND id != ?", id).one().n;
		if (others >= max) return false;
		sql.exec("UPDATE orbs SET awake = 1 WHERE id = ?", id);
		return true;
	}

	list(): OrbSummary[] {
		return this.ctx.storage.sql
			.exec<{ summary: string }>("SELECT summary FROM orbs ORDER BY updated_at DESC")
			.toArray()
			.map((row) => JSON.parse(row.summary) as OrbSummary);
	}

	usage(): UsageResponse {
		const orbs = this.list();
		return {
			total: orbs.reduce((sum, orb) => addUsage(sum, orb.usage), EMPTY_USAGE),
			orbs: orbs.map((orb) => ({ id: orb.id, title: orb.title, status: orb.status, usage: orb.usage })),
			awakeOrbs: orbs.filter((orb) => isAwake(orb.status)).length,
			maxConcurrentOrbs: readSettings(this.env).maxConcurrentOrbs,
		};
	}

	// ---- live thread list ----------------------------------------------------------

	fetch(request: Request): Response {
		if (request.headers.get("upgrade") !== "websocket") {
			return new Response("Expected a WebSocket upgrade", { status: 426 });
		}
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server!, ["hub"]);
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
		if (typeof raw !== "string") return;
		try {
			const message = JSON.parse(raw) as { type?: string };
			if (message.type === "hello") ws.send(JSON.stringify({ type: "orbs", orbs: this.list() } satisfies HubServerMessage));
			if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" } satisfies HubServerMessage));
		} catch {
			// Ignore malformed frames.
		}
	}

	webSocketClose(ws: WebSocket, code: number, reason: string): void {
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {}
	}

	webSocketError(): void {}

	private broadcast(message: HubServerMessage): void {
		const payload = JSON.stringify(message);
		for (const ws of this.ctx.getWebSockets("hub")) {
			try {
				ws.send(payload);
			} catch {}
		}
	}
}
