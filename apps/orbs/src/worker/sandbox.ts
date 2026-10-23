import { Files } from "@cloudflare/sandbox";
import type { OrbEvent } from "@orbs/protocol";
import type { OrbStore } from "./store.ts";
import type { Settings } from "./settings.ts";
import type { OrbConfig } from "./types.ts";
import { provisionWorkspace, saveRecoveryPatch } from "./workspace.ts";
import type { OutboundProps } from "./outbound.ts";

export const WORKSPACE = "/workspace";
export const REPO_DIR = "/workspace/repo";
export const ORB_DIR = "/workspace/.orb";

const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/**
 * Every HTTPS request from the container is re-signed by the Containers CA so
 * the Outbound entrypoint can read and rewrite it. Pointing the common tools at
 * that CA (alone) is what makes them trust it.
 */
const TRUST_ENV: Record<string, string> = {
	NODE_EXTRA_CA_CERTS: CA_PATH,
	SSL_CERT_FILE: CA_PATH,
	GIT_SSL_CAINFO: CA_PATH,
	CURL_CA_BUNDLE: CA_PATH,
	REQUESTS_CA_BUNDLE: CA_PATH,
	PIP_CERT: CA_PATH,
	CARGO_HTTP_CAINFO: CA_PATH,
	DENO_CERT: CA_PATH,
};

/** Environment for every process we start. `exec()` does not inherit the image's ENV. */
export const BASE_ENV: Record<string, string> = {
	HOME: "/root",
	LANG: "C.UTF-8",
	CI: "true",
	GIT_TERMINAL_PROMPT: "0",
	PIP_BREAK_SYSTEM_PACKAGES: "1",
	ORB_CONTROL_URL: "http://orb.internal",
	...TRUST_ENV,
};

/** Longer than the alarm check interval, so a live orb never idles out between checks. */
export const INACTIVITY_TIMEOUT_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 120_000;

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
}

export interface ExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	stdin?: string;
	/** Output cap per stream, in bytes. */
	maxBytes?: number;
	timeoutMs?: number;
}

export class Sandbox {
	readonly container: Container;
	readonly files: Files;
	private setupPromise: Promise<void> | undefined;
	/** True while we are deliberately stopping the container, so monitor() exits are not crashes. */
	private expectedStop = false;
	/** Bumped per container start, so a late exit callback from an earlier container is ignored. */
	private generation = 0;
	private readonly decoder = new TextDecoder();
	private readonly encoder = new TextEncoder();

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly workerEnv: Env,
		readonly store: OrbStore,
		readonly config: OrbConfig,
		readonly settings: Settings,
		readonly emit: (event: OrbEvent) => void,
		private readonly onUnexpectedExit: (reason: string) => void,
	) {
		if (!ctx.container) throw new Error("No container is configured for this Durable Object");
		this.container = ctx.container;
		this.files = new Files(ctx.container);
	}

	get running(): boolean {
		return this.container.running;
	}

	env(): Env {
		return this.workerEnv;
	}

	/**
	 * Make the workspace usable: start the container (from the last snapshot when
	 * possible, else a fresh image), route its egress through the Worker, and
	 * ensure the repo is checked out. Idempotent and single-flight; safe to call
	 * on every request and after a Durable Object restart.
	 */
	ensureRunning(): Promise<void> {
		if (this.setupPromise === undefined || !this.container.running) {
			this.setupPromise = this.setUp().catch((error) => {
				this.setupPromise = undefined;
				throw error;
			});
		}
		return this.setupPromise;
	}

	private async setUp(): Promise<void> {
		if (!this.container.running) {
			await this.startContainer();
		} else {
			// Durable Object restarted while the container kept running: intercepts and
			// the inactivity timeout belong to this instance of the object, so redo them.
			await this.configureRunning();
			this.watch();
		}
		await provisionWorkspace(this);
	}

	private async startContainer(): Promise<void> {
		const snapshot = this.store.latestSnapshot();
		const usable = snapshot !== undefined && snapshot.imageVersion === this.settings.imageVersion;

		if (snapshot && !usable) {
			this.emit({
				kind: "system",
				level: "warn",
				message: "The saved snapshot was taken with an older image, so the workspace is rebuilt from git.",
			});
		}

		if (usable) {
			this.emit({ kind: "system", level: "info", message: "Waking: restoring the workspace snapshot…" });
			try {
				await this.launch({ containerSnapshot: { id: snapshot.id } });
				return;
			} catch (error) {
				this.emit({
					kind: "system",
					level: "warn",
					message: `Snapshot restore failed (${describe(error)}). Starting from a clean image instead.`,
				});
				this.store.clearSnapshots();
				await this.stopQuietly("restore-failed");
			}
		}
		const image = this.container.images?.workspace;
		if (!image) throw new Error("The workspace image is not configured for this container");
		await this.launch({ image });
	}

	private async launch(source: { image: string } | { containerSnapshot: { id: string } }): Promise<void> {
		this.expectedStop = false;
		this.generation++;
		this.container.start({
			...source,
			instance: this.config.instance,
			enableInternet: false,
			labels: { orb: this.config.id },
		});
		this.store.openSession(this.config.instance);
		try {
			await this.configureRunning();
			await this.waitReady();
		} catch (error) {
			await this.stopQuietly("start-failed");
			throw error;
		}
		this.watch();
	}

	private async configureRunning(): Promise<void> {
		const props: OutboundProps = {
			orbName: this.config.name,
			orbId: this.config.id,
			ownerKey: this.config.ownerKey,
			repo: `${this.config.repo.owner}/${this.config.repo.name}`,
			branch: `orb/${this.config.id}`,
			policy: this.config.networkPolicy,
			extraHosts: this.settings.extraAllowedHosts,
		};
		const outbound = this.ctx.exports.Outbound({ props });
		// Hostname rules must be registered before the catch-all.
		await this.container.interceptOutboundHttp("orb.internal", outbound);
		await this.container.interceptAllOutboundHttp(outbound);
		await this.container.interceptOutboundHttps("*", outbound);
		await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
	}

	/** Keep the instance alive; call from every alarm tick while the orb is awake. */
	async touch(): Promise<void> {
		if (this.container.running) await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
	}

	private async waitReady(): Promise<void> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		let lastError: unknown;
		while (Date.now() < deadline) {
			if (!this.container.running) {
				throw new Error(`container stopped during startup${lastError ? `: ${describe(lastError)}` : ""}`);
			}
			try {
				const result = await this.exec(["true"], { timeoutMs: 15_000 });
				if (result.exitCode === 0) return;
			} catch (error) {
				lastError = error;
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		throw new Error(`container did not become ready: ${describe(lastError)}`);
	}

	private watch(): void {
		const generation = this.generation;
		this.ctx.waitUntil(
			this.container.monitor().then(
				() => this.handleExit("exited", generation),
				(error) => this.handleExit(describe(error), generation),
			),
		);
	}

	private handleExit(reason: string, generation: number): void {
		if (generation !== this.generation) return; // an earlier container; the current one is unaffected
		this.store.closeSession(this.expectedStop ? "stopped" : reason);
		if (this.expectedStop) return;
		this.setupPromise = undefined;
		this.onUnexpectedExit(reason);
	}

	// ---- stopping -----------------------------------------------------------

	/** Save a snapshot of the root filesystem. Does not stop the container. */
	async snapshot(reason: string): Promise<void> {
		await saveRecoveryPatch(this).catch((error) => console.warn("recovery patch failed", describe(error)));
		const handle = await this.container.snapshotContainer({ name: `${this.config.id}-${reason}` });
		this.store.addSnapshot({
			id: handle.id,
			size: handle.size,
			createdAt: Date.now(),
			imageVersion: this.settings.imageVersion,
			reason,
		});
	}

	/** Snapshot, then stop: the orb costs nothing until the next wake. */
	async sleep(reason: string): Promise<void> {
		if (!this.container.running) return;
		await this.snapshot(reason);
		await this.stop(reason);
	}

	async stop(reason: string): Promise<void> {
		this.expectedStop = true;
		this.setupPromise = undefined;
		this.store.closeSession(reason);
		if (this.container.running) await this.container.destroy(reason);
	}

	private async stopQuietly(reason: string): Promise<void> {
		try {
			await this.stop(reason);
		} catch (error) {
			console.warn("stop failed", describe(error));
		}
	}

	// ---- running commands ---------------------------------------------------

	/** Run a command to completion. Output is capped so a chatty process cannot exhaust memory. */
	async exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
		const maxBytes = options.maxBytes ?? 256 * 1024;
		const controller = new AbortController();
		let exited = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const proc = await this.container.exec(argv, {
			cwd: options.cwd,
			env: { ...BASE_ENV, ...options.env },
			stdin: options.stdin === undefined ? undefined : "pipe",
			signal: controller.signal,
		});
		const settled = () => {
			exited = true;
			if (timer) clearTimeout(timer);
		};
		proc.exitCode.then(settled, settled);
		if (options.timeoutMs) {
			timer = setTimeout(() => {
				// Signalling a process that already exited raises an uncaught error.
				if (!exited) controller.abort();
			}, options.timeoutMs);
		}

		if (options.stdin !== undefined && proc.stdin) {
			const writer = proc.stdin.getWriter();
			await writer.write(this.encoder.encode(options.stdin));
			await writer.close();
		}

		const [stdout, stderr] = await Promise.all([
			this.readCapped(proc.stdout, maxBytes),
			this.readCapped(proc.stderr, maxBytes),
		]);
		let exitCode: number;
		try {
			exitCode = await proc.exitCode;
		} catch {
			exitCode = 137;
		}
		return {
			exitCode,
			stdout: stdout.text,
			stderr: stderr.text,
			truncated: stdout.truncated || stderr.truncated,
		};
	}

	private async readCapped(
		stream: ReadableStream<Uint8Array> | null | undefined,
		maxBytes: number,
	): Promise<{ text: string; truncated: boolean }> {
		if (!stream) return { text: "", truncated: false };
		const chunks: Uint8Array[] = [];
		let size = 0;
		let truncated = false;
		for await (const chunk of stream) {
			if (size >= maxBytes) {
				truncated = true; // keep draining so the process is not blocked on a full pipe
				continue;
			}
			const room = maxBytes - size;
			const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
			if (piece.length < chunk.length) truncated = true;
			chunks.push(piece);
			size += piece.length;
		}
		const merged = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		return { text: this.decoder.decode(merged), truncated };
	}
}

export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
