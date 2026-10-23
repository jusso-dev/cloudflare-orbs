import type {
	AppConfig,
	Budget,
	CreateOrbRequest,
	DiffResponse,
	EventsPage,
	OrbSummary,
	UsageResponse,
	WsTicketResponse,
} from "@orbs/protocol/types";

const TOKEN_KEY = "orbs.token";

export const credentials = {
	get: () => localStorage.getItem(TOKEN_KEY) ?? "",
	set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
	clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiFailure extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const token = credentials.get();
	const response = await fetch(`/api${path}`, {
		method,
		headers: {
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let data: unknown;
	try {
		data = text ? JSON.parse(text) : undefined;
	} catch {
		data = undefined;
	}
	if (!response.ok) {
		const message = (data as { error?: string } | undefined)?.error ?? `Request failed (${response.status})`;
		if (response.status === 401) window.dispatchEvent(new Event("orbs:unauthorized"));
		throw new ApiFailure(response.status, message);
	}
	return data as T;
}

export const api = {
	config: () => request<AppConfig>("GET", "/config"),
	usage: () => request<UsageResponse>("GET", "/usage"),
	list: () => request<OrbSummary[]>("GET", "/orbs"),
	create: (body: Partial<CreateOrbRequest> & Pick<CreateOrbRequest, "repoUrl" | "prompt">) =>
		request<OrbSummary>("POST", "/orbs", body),
	get: (id: string) => request<OrbSummary>("GET", `/orbs/${id}`),
	remove: (id: string) => request<true>("DELETE", `/orbs/${id}`),
	events: (id: string, after: number) => request<EventsPage>("GET", `/orbs/${id}/events?after=${after}&limit=500`),
	send: (id: string, text: string) => request<{ turnId: string; queued: boolean }>("POST", `/orbs/${id}/messages`, { text }),
	interrupt: (id: string) => request<true>("POST", `/orbs/${id}/interrupt`, {}),
	approve: (id: string, approvalId: string, decision: "allow" | "deny" | "allow_always") =>
		request<true>("POST", `/orbs/${id}/approvals/${approvalId}`, { decision }),
	diff: (id: string, fresh = false) => request<DiffResponse>("GET", `/orbs/${id}/diff${fresh ? "?fresh=1" : ""}`),
	wake: (id: string) => request<OrbSummary>("POST", `/orbs/${id}/wake`, {}),
	sleep: (id: string) => request<OrbSummary>("POST", `/orbs/${id}/sleep`, {}),
	snapshot: (id: string) => request<OrbSummary>("POST", `/orbs/${id}/snapshot`, {}),
	budget: (id: string, budget: Budget) => request<OrbSummary>("POST", `/orbs/${id}/budget`, budget),
	pr: (id: string, body: { title?: string; body?: string }) =>
		request<{ url: string; number: number }>("POST", `/orbs/${id}/pr`, body),
	schedule: (id: string, at: number, text: string) =>
		request<{ id: string; at: number }>("POST", `/orbs/${id}/schedule`, { at, text }),
	scheduled: (id: string) => request<Array<{ id: string; runAt: number; text: string }>>("GET", `/orbs/${id}/scheduled`),
	unschedule: (id: string, scheduledId: string) => request<true>("DELETE", `/orbs/${id}/scheduled/${scheduledId}`),
	ticket: (scope: "events" | "terminal" | "preview", id: string) =>
		request<WsTicketResponse>("POST", `/orbs/${id}/ticket`, { scope }),
	hubTicket: () => request<WsTicketResponse>("POST", "/ticket", {}),
};

export function socketUrl(path: string, ticket: string): string {
	const url = new URL(path, window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("ticket", ticket);
	return url.toString();
}
