import { createRemoteJWKSet, jwtVerify } from "jose";

export interface User {
	id: string;
	label: string;
}

export type TicketScope = "events" | "terminal" | "hub" | "preview";

interface TicketPayload {
	u: string;
	l: string;
	/** Orb id the ticket is for (absent for the hub socket). */
	o?: string;
	s: TicketScope;
	exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---- request authentication ---------------------------------------------------

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function bearer(request: Request): string | undefined {
	const header = request.headers.get("authorization");
	if (!header?.toLowerCase().startsWith("bearer ")) return undefined;
	return header.slice(7).trim() || undefined;
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
	// Compare fixed-length digests so neither length nor content leaks through timing.
	const [x, y] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	const left = new Uint8Array(x);
	const right = new Uint8Array(y);
	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	return diff === 0;
}

export interface AuthEnv {
	AUTH_TOKEN?: string;
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
}

export interface AuthResult {
	user: User;
	/** Credentials a browser attaches on its own (Access cookie); these need CSRF protection. */
	ambient: boolean;
}

/**
 * Cloudflare Access is the primary mechanism. When it is configured, a valid
 * Access JWT identifies the user. A static bearer token (AUTH_TOKEN) is the
 * simple alternative and the break-glass for API clients.
 */
export async function authenticate(request: Request, env: AuthEnv): Promise<AuthResult | null> {
	const presented = bearer(request);
	if (presented && env.AUTH_TOKEN && (await constantTimeEqual(presented, env.AUTH_TOKEN))) {
		return { user: { id: "owner", label: "owner" }, ambient: false };
	}

	if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
		const jwt =
			request.headers.get("cf-access-jwt-assertion") ??
			/(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
		if (jwt) {
			try {
				const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
				let jwks = jwksCache.get(issuer);
				if (!jwks) {
					jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
					jwksCache.set(issuer, jwks);
				}
				const { payload } = await jwtVerify(jwt, jwks, { issuer, audience: env.ACCESS_AUD });
				const id = typeof payload.email === "string" ? payload.email : payload.sub;
				if (id) return { user: { id, label: id }, ambient: true };
			} catch (error) {
				console.warn("access jwt rejected", error instanceof Error ? error.message : error);
			}
		}
	}
	return null;
}

/** Stable, non-reversible key for naming a user's Durable Objects. */
export async function ownerKeyFor(userId: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`orbs:v1:${userId}`));
	return [...new Uint8Array(digest)]
		.slice(0, 10)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

// ---- short-lived socket tickets -------------------------------------------------
// Browsers cannot set headers on a WebSocket, and putting a long-lived credential in
// a URL leaks it into logs. Instead an authenticated REST call mints a ticket that is
// scoped to one orb and one purpose, and expires in a minute.

function b64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string, usage: "sign" | "verify") {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function signTicket(
	secret: string,
	user: User,
	scope: TicketScope,
	orbId: string | undefined,
	ttlMs: number,
	now = Date.now(),
): Promise<{ ticket: string; expiresAt: number }> {
	const payload: TicketPayload = { u: user.id, l: user.label, s: scope, exp: now + ttlMs, ...(orbId ? { o: orbId } : {}) };
	const body = b64url(encoder.encode(JSON.stringify(payload)));
	const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(body));
	return { ticket: `${body}.${b64url(new Uint8Array(mac))}`, expiresAt: payload.exp };
}

export async function verifyTicket(
	secret: string,
	ticket: string,
	scope: TicketScope,
	orbId: string | undefined,
	now = Date.now(),
): Promise<User | null> {
	const [body, mac] = ticket.split(".");
	if (!body || !mac) return null;
	try {
		const valid = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(secret, "verify"),
			fromB64url(mac),
			encoder.encode(body),
		);
		if (!valid) return null;
		const payload = JSON.parse(decoder.decode(fromB64url(body))) as TicketPayload;
		if (payload.s !== scope || payload.exp < now || payload.o !== orbId) return null;
		return { id: payload.u, label: payload.l };
	} catch {
		return null;
	}
}
