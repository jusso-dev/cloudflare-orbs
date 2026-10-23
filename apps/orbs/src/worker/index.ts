import {
	ApprovalRequestSchema,
	BudgetSchema,
	CreateOrbRequestSchema,
	CreatePrRequestSchema,
	ORB_ID_PATTERN,
	ScheduleMessageRequestSchema,
	SendMessageRequestSchema,
	parseGitHubRepo,
	titleFromPrompt,
	INSTANCE_TYPES,
	type AppConfig,
	type ApiError,
} from "@orbs/protocol";
import { listHarnesses } from "@orbs/harness";
import { authenticate, ownerKeyFor, signTicket, verifyTicket, type TicketScope, type User } from "./auth.ts";
import { readSettings } from "./settings.ts";
import type { OrbConfig, Result } from "./types.ts";

export { Orb } from "./orb.ts";
export { Outbound } from "./outbound.ts";
export { UserHub } from "./user-hub.ts";

const MAX_BODY_BYTES = 512 * 1024;
const TICKET_TTL_MS = 60_000;
const PREVIEW_TICKET_TTL_MS = 60 * 60_000;

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
	Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const error = (status: number, message: string) => json({ error: message } satisfies ApiError, status);

function fromResult<T>(result: Result<T>, status = 200): Response {
	return result.ok ? json(result.value, status) : error(result.status, result.error);
}

async function readJson<T>(request: Request, schema: { parse(input: unknown): T }): Promise<T> {
	if (!request.headers.get("content-type")?.includes("application/json")) {
		throw new HttpError(415, "Send application/json");
	}
	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
	try {
		return schema.parse(JSON.parse(text));
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : "invalid body";
		throw new HttpError(400, detail.length > 300 ? `${detail.slice(0, 300)}…` : detail);
	}
}

function newOrbId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/** Browsers send Origin on cross-site writes and on WebSocket upgrades; reject foreign ones. */
function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	return !origin || new URL(origin).host === new URL(request.url).host;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
			return await route(request, env, url);
		} catch (cause) {
			if (cause instanceof HttpError) return error(cause.status, cause.message);
			console.error("unhandled error", cause);
			return error(500, "Internal error");
		}
	},
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL): Promise<Response> {
	const path = url.pathname.slice("/api".length);
	const method = request.method;

	if (path === "/health") return json({ ok: true });

	// Sockets and previews authenticate with a short-lived ticket instead of headers.
	if (path === "/ws") return hubSocket(request, env, url);
	const socketRoute = /^\/orbs\/([a-z0-9]{12})\/(ws|terminal)$/.exec(path);
	if (socketRoute) return orbSocket(request, env, url, socketRoute[1]!, socketRoute[2] as "ws" | "terminal");
	const previewRoute = /^\/orbs\/([a-z0-9]{12})\/preview\/(\d{4,5})(\/.*)?$/.exec(path);
	if (previewRoute) return preview(request, env, url, previewRoute[1]!, previewRoute[2]!, previewRoute[3] ?? "/");

	const auth = await authenticate(request, env);
	if (!auth) return error(401, "Authentication required");
	const { user } = auth;
	// Cookie-based credentials ride along on cross-site requests, so writes must come from this origin.
	if (auth.ambient && method !== "GET" && method !== "HEAD" && !sameOrigin(request)) {
		return error(403, "Cross-origin request blocked");
	}

	const settings = readSettings(env);
	const ownerKey = await ownerKeyFor(user.id);
	const hub = env.USER_HUB.getByName(ownerKey);

	if (path === "/config" && method === "GET") {
		return json({
			user,
			harnesses: listHarnesses({ models: settings.models, demoEnabled: settings.demoEnabled }),
			instances: [...INSTANCE_TYPES],
			limits: {
				maxConcurrentOrbs: settings.maxConcurrentOrbs,
				defaultBudget: settings.defaultBudget,
				idleSleepMinutes: settings.idleSleepMs / 60_000,
			},
		} satisfies AppConfig);
	}

	if (path === "/usage" && method === "GET") return json(await hub.usage());

	if (path === "/ticket" && method === "POST") {
		return json(await signTicket(env.SESSION_SECRET, user, "hub", undefined, TICKET_TTL_MS));
	}

	if (path === "/orbs" && method === "GET") return json(await hub.list());

	if (path === "/orbs" && method === "POST") {
		const body = await readJson(request, CreateOrbRequestSchema);
		const harnesses = listHarnesses({ models: settings.models, demoEnabled: settings.demoEnabled });
		const harness = harnesses.find((candidate) => candidate.id === body.harness);
		if (!harness) return error(400, `Harness "${body.harness}" is not available`);
		const model = body.model ?? harness.defaultModel;
		if (!harness.models.includes(model)) return error(400, `Model "${model}" is not allowed for ${harness.label}`);
		if (body.approvalMode === "ask" && !harness.capabilities.approvals) {
			return error(400, `${harness.label} does not support per-action approvals`);
		}
		const repo = parseGitHubRepo(body.repoUrl)!;
		const id = newOrbId();
		const config: OrbConfig = {
			id,
			name: `${ownerKey}:${id}`,
			ownerKey,
			ownerLabel: user.label,
			title: body.title ?? titleFromPrompt(body.prompt),
			repoUrl: `https://github.com/${repo.owner}/${repo.name}`,
			repo,
			ref: body.ref,
			harness: body.harness,
			model,
			approvalMode: body.approvalMode,
			networkPolicy: body.networkPolicy,
			instance: body.instance,
			budget: { ...settings.defaultBudget, ...body.budget },
			createdAt: Date.now(),
		};
		return fromResult(await env.ORB.getByName(config.name).init(config, body.prompt), 201);
	}

	const orbRoute = /^\/orbs\/([a-z0-9]{12})(?:\/([a-z-]+)(?:\/([A-Za-z0-9_-]+))?)?$/.exec(path);
	if (!orbRoute) return error(404, "Not found");
	const [, id, action, arg] = orbRoute;
	if (!id || !ORB_ID_PATTERN.test(id)) return error(404, "Not found");
	const orb = env.ORB.getByName(`${ownerKey}:${id}`);

	if (!action) {
		if (method === "GET") {
			const summary = await orb.getSummary();
			return summary ? json(summary) : error(404, "Orb not found");
		}
		if (method === "DELETE") return fromResult(await orb.destroyOrb());
		return error(405, "Method not allowed");
	}

	if (method === "GET") {
		switch (action) {
			case "events": {
				const after = Math.max(Number(url.searchParams.get("after") ?? 0) || 0, 0);
				const limit = Number(url.searchParams.get("limit") ?? 200) || 200;
				return json(await orb.getEvents(after, limit));
			}
			case "diff":
				return fromResult(await orb.getDiff(url.searchParams.get("fresh") === "1"));
			case "scheduled":
				return json(await orb.listScheduled());
		}
	}

	if (method === "POST") {
		switch (action) {
			case "messages": {
				const body = await readJson(request, SendMessageRequestSchema);
				return fromResult(await orb.sendMessage(body.text), 202);
			}
			case "schedule": {
				const body = await readJson(request, ScheduleMessageRequestSchema);
				return fromResult(await orb.scheduleMessage(body.at, body.text), 201);
			}
			case "interrupt":
				return fromResult(await orb.interrupt());
			case "approvals": {
				if (!arg) return error(404, "Not found");
				const body = await readJson(request, ApprovalRequestSchema);
				return fromResult(await orb.resolveApproval(arg, body.decision));
			}
			case "budget": {
				const body = await readJson(request, BudgetSchema);
				return fromResult(await orb.setBudget(body));
			}
			case "wake":
				return fromResult(await orb.wakeUp());
			case "sleep":
				return fromResult(await orb.sleepNow());
			case "snapshot":
				return fromResult(await orb.snapshotNow());
			case "pr": {
				const body = await readJson(request, CreatePrRequestSchema);
				return fromResult(await orb.createPullRequest(body));
			}
			case "ticket": {
				const body = await readJson(request, { parse: (input: unknown) => input as { scope?: string } });
				const scope = body.scope;
				if (scope !== "events" && scope !== "terminal" && scope !== "preview") return error(400, "Unknown ticket scope");
				if (!(await orb.getSummary())) return error(404, "Orb not found");
				const ttl = scope === "preview" ? PREVIEW_TICKET_TTL_MS : TICKET_TTL_MS;
				return json(await signTicket(env.SESSION_SECRET, user, scope, id, ttl));
			}
		}
	}

	if (method === "DELETE" && action === "scheduled" && arg) {
		return fromResult(await orb.cancelScheduled(arg));
	}

	return error(404, "Not found");
}

// ---- sockets & preview (ticket-authenticated) ------------------------------------

async function ticketUser(
	request: Request,
	env: Env,
	scope: TicketScope,
	orbId: string | undefined,
	ticket: string | null | undefined,
): Promise<User | null> {
	if (!ticket) return null;
	return verifyTicket(env.SESSION_SECRET, ticket, scope, orbId);
}

async function hubSocket(request: Request, env: Env, url: URL): Promise<Response> {
	if (request.headers.get("upgrade") !== "websocket") return error(426, "Expected a WebSocket upgrade");
	if (!sameOrigin(request)) return error(403, "Cross-origin request blocked");
	const user = await ticketUser(request, env, "hub", undefined, url.searchParams.get("ticket"));
	if (!user) return error(401, "Invalid or expired ticket");
	const hub = env.USER_HUB.getByName(await ownerKeyFor(user.id));
	return hub.fetch(request);
}

async function orbSocket(
	request: Request,
	env: Env,
	url: URL,
	id: string,
	kind: "ws" | "terminal",
): Promise<Response> {
	if (request.headers.get("upgrade") !== "websocket") return error(426, "Expected a WebSocket upgrade");
	if (!sameOrigin(request)) return error(403, "Cross-origin request blocked");
	const scope: TicketScope = kind === "ws" ? "events" : "terminal";
	const user = await ticketUser(request, env, scope, id, url.searchParams.get("ticket"));
	if (!user) return error(401, "Invalid or expired ticket");

	const orb = env.ORB.getByName(`${await ownerKeyFor(user.id)}:${id}`);
	const target = new URL(request.url);
	target.pathname = kind === "ws" ? "/ws" : "/terminal";
	target.searchParams.delete("ticket");
	return orb.fetch(new Request(target, request));
}

async function preview(
	request: Request,
	env: Env,
	url: URL,
	id: string,
	port: string,
	rest: string,
): Promise<Response> {
	const cookieName = `orb_preview_${id}`;
	const cookie = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`).exec(request.headers.get("cookie") ?? "")?.[1];
	const fromQuery = url.searchParams.get("ticket");
	const user = await ticketUser(request, env, "preview", id, fromQuery ?? cookie);
	if (!user) return error(401, "Open the preview from the Orbs app");

	// First hit carries the ticket in the URL; trade it for a path-scoped cookie and drop it from the address bar.
	if (fromQuery) {
		const clean = new URL(request.url);
		clean.searchParams.delete("ticket");
		return new Response(null, {
			status: 302,
			headers: {
				location: `${clean.pathname}${clean.search}`,
				"set-cookie": `${cookieName}=${fromQuery}; Path=/api/orbs/${id}/preview; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`,
				"cache-control": "no-store",
			},
		});
	}

	const orb = env.ORB.getByName(`${await ownerKeyFor(user.id)}:${id}`);
	const target = new URL(request.url);
	target.pathname = `/preview/${port}${rest}`;
	return orb.fetch(new Request(target, request));
}
