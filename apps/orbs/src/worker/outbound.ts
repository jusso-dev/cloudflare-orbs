import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import type { NetworkPolicy } from "@orbs/protocol";
import { parseReceivePackCommands } from "./pktline.ts";
import { GATEWAY_HOST, readSettings } from "./settings.ts";

export interface OutboundProps {
	orbName: string;
	orbId: string;
	ownerKey: string;
	/** `owner/name` of the repository this orb works on. */
	repo: string;
	/** The only branch the container may push to. */
	branch: string;
	policy: NetworkPolicy;
	extraHosts: string[];
}

/** Hosts reachable (anonymously, unmodified) under the `packages` policy. */
const PACKAGE_HOSTS = [
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	"nodejs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"crates.io",
	"static.crates.io",
	"index.crates.io",
	"proxy.golang.org",
	"sum.golang.org",
	"rubygems.org",
	"index.rubygems.org",
	"repo.maven.apache.org",
	"repo1.maven.org",
	"api.nuget.org",
	"github.com",
	"codeload.github.com",
	"objects.githubusercontent.com",
	"raw.githubusercontent.com",
];

const MAX_PUSH_COMMAND_BYTES = 64 * 1024;

const ApprovalBody = z.object({
	toolName: z.string().min(1).max(200),
	toolUseId: z.string().max(200).optional(),
	input: z.unknown().optional(),
});

const deny = (message: string, status = 403) =>
	new Response(`${message}\n`, { status, headers: { "content-type": "text/plain" } });

/**
 * Every HTTP and HTTPS request the container makes arrives here, because the
 * container has no direct internet. This is the egress firewall and the place
 * credentials are added: the container never holds the AI Gateway token or the
 * GitHub token.
 */
export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const props = this.ctx.props;

		if (url.hostname === "orb.internal") return this.control(request, url);

		// Credentials are only ever attached to HTTPS requests.
		if (url.protocol !== "https:") {
			return this.denied(url, "only HTTPS is allowed");
		}
		if (url.hostname === GATEWAY_HOST) return this.gateway(request, url);
		if (url.hostname === "github.com") return this.github(request, url);

		const host = url.hostname.toLowerCase();
		const allowed =
			props.extraHosts.includes(host) ||
			(props.policy === "packages" && PACKAGE_HOSTS.includes(host));
		if (allowed) return fetch(request);

		return this.denied(url, "host is not on this orb's allowlist");
	}

	private denied(url: URL, reason: string): Response {
		console.warn(`egress denied orb=${this.ctx.props.orbId} host=${url.hostname}: ${reason}`);
		return deny(`${url.hostname} is not reachable from this orb (${reason})`);
	}

	// ---- AI Gateway ----------------------------------------------------------

	private gateway(request: Request, url: URL): Response | Promise<Response> {
		const { gatewayPath } = readSettings(this.env);
		if (url.pathname !== gatewayPath && !url.pathname.startsWith(`${gatewayPath}/`)) {
			return this.denied(url, "only this orb's gateway is allowed");
		}
		const headers = new Headers(request.headers);
		// Harnesses send a placeholder key; the real credential is the gateway token.
		headers.delete("x-api-key");
		headers.delete("authorization");
		headers.set("cf-aig-authorization", `Bearer ${this.env.AI_GATEWAY_TOKEN}`);
		// Attribute spend per orb in AI Gateway logs and analytics.
		headers.set(
			"cf-aig-metadata",
			JSON.stringify({ orb: this.ctx.props.orbId, owner: this.ctx.props.ownerKey }),
		);
		return fetch(new Request(request, { headers }));
	}

	// ---- GitHub --------------------------------------------------------------

	private async github(request: Request, url: URL): Promise<Response> {
		const { repo, branch, policy } = this.ctx.props;
		const repoPath = `/${repo}.git`.toLowerCase();
		const path = url.pathname.toLowerCase();

		const isRepo = path.startsWith(`${repoPath}/`);
		if (!isRepo) {
			// Other GitHub repos: anonymous read access only, and only if packages are allowed.
			if (policy === "packages" && (request.method === "GET" || request.method === "POST")) {
				const headers = new Headers(request.headers);
				headers.delete("authorization");
				return fetch(new Request(request, { headers }));
			}
			return this.denied(url, "only this orb's repository is allowed");
		}

		const service = url.searchParams.get("service");
		const rest = path.slice(repoPath.length);
		const upload =
			(request.method === "GET" && rest === "/info/refs" && service === "git-upload-pack") ||
			(request.method === "POST" && rest === "/git-upload-pack");
		const receiveAdvert =
			request.method === "GET" && rest === "/info/refs" && service === "git-receive-pack";
		const receive = request.method === "POST" && rest === "/git-receive-pack";

		if (!upload && !receiveAdvert && !receive) {
			return this.denied(url, "unsupported git operation");
		}

		const headers = new Headers(request.headers);
		const token = this.env.GITHUB_TOKEN;
		if (token) headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
		else headers.delete("authorization");

		if (!receive) return fetch(new Request(request, { headers }));

		// A push may only touch this orb's own branch.
		if (headers.get("content-encoding")) return this.denied(url, "compressed pushes are not allowed");
		if (!request.body) return this.denied(url, "empty push");
		const [peek, forward] = request.body.tee();
		const refs = await readPushRefs(peek);
		const allowedRef = `refs/heads/${branch}`;
		if (!refs || refs.length === 0 || refs.some((ref) => ref !== allowedRef)) {
			await forward.cancel().catch(() => {});
			return this.denied(url, `pushes are limited to ${allowedRef}`);
		}
		return fetch(new Request(request.url, { method: "POST", headers, body: forward }));
	}

	// ---- control plane (approvals) ---------------------------------------------

	private async control(request: Request, url: URL): Promise<Response> {
		const orb = this.env.ORB.getByName(this.ctx.props.orbName);

		if (request.method === "POST" && url.pathname === "/approvals") {
			const body = ApprovalBody.safeParse(await request.json().catch(() => null));
			if (!body.success) return Response.json({ error: "invalid approval request" }, { status: 400 });
			return Response.json(await orb.requestApproval(body.data));
		}

		const match = /^\/approvals\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
		if (request.method === "GET" && match?.[1]) {
			const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 0) || 0, 0), 25);
			return Response.json(await orb.waitApproval(match[1], wait * 1000));
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}
}

async function readPushRefs(stream: ReadableStream<Uint8Array>): Promise<string[] | null> {
	const reader = stream.getReader();
	let buffered = new Uint8Array(0);
	try {
		while (buffered.length < MAX_PUSH_COMMAND_BYTES) {
			const parsed = parseReceivePackCommands(buffered);
			if (parsed === null) return null;
			if (parsed.complete) return parsed.refs;
			const { done, value } = await reader.read();
			if (done) return null;
			const next = new Uint8Array(buffered.length + value.length);
			next.set(buffered);
			next.set(value, buffered.length);
			buffered = next;
		}
		return null;
	} finally {
		await reader.cancel().catch(() => {});
	}
}
