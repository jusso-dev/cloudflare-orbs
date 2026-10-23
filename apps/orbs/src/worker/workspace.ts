import type { Sandbox } from "./sandbox.ts";
import { describe, ORB_DIR, REPO_DIR, WORKSPACE } from "./sandbox.ts";

const MAX_PATCH_BYTES = 16 * 1024 * 1024;
const recoveryKey = (orbName: string) => `recovery/${orbName}/latest.patch`;

function git(sandbox: Sandbox, args: string[], opts: { timeoutMs?: number; maxBytes?: number } = {}) {
	return sandbox.exec(["git", "-C", REPO_DIR, ...args], { timeoutMs: 120_000, ...opts });
}

/**
 * Make sure /workspace/repo holds the orb's checkout. Derived from filesystem
 * state, not memory, so it is safe after restores, restarts and half-finished
 * attempts: if the repo is there, nothing happens.
 */
export async function provisionWorkspace(sandbox: Sandbox): Promise<void> {
	const { config, store } = sandbox;
	const present = await sandbox.exec(["test", "-d", `${REPO_DIR}/.git`]);
	if (present.exitCode === 0) return;

	const state = store.getState();
	const rebuilding = state?.baseCommit !== undefined;
	const branch = `orb/${config.id}`;
	const url = `https://github.com/${config.repo.owner}/${config.repo.name}.git`;

	await sandbox.exec(["mkdir", "-p", WORKSPACE, ORB_DIR]);
	sandbox.emit({ kind: "system", level: "info", message: `Cloning ${config.repo.owner}/${config.repo.name}…` });

	// A rebuilt workspace must start from the commit the old one was based on.
	const clone = await sandbox.exec(
		["git", "clone", "--depth", "1", ...(config.ref && !rebuilding ? ["--branch", config.ref] : []), "--", url, REPO_DIR],
		{ cwd: WORKSPACE, timeoutMs: 600_000 },
	);
	if (clone.exitCode !== 0) {
		throw new Error(`git clone failed: ${clone.stderr.trim().slice(-600) || `exit ${clone.exitCode}`}`);
	}

	if (rebuilding && state?.baseCommit) {
		const base = state.baseCommit;
		await git(sandbox, ["fetch", "--depth", "1", "origin", base], { timeoutMs: 300_000 });
		const checkout = await git(sandbox, ["checkout", "-q", "-B", branch, base]);
		if (checkout.exitCode !== 0) {
			// The base commit is gone upstream (force-push). Stay on the fresh tip.
			await git(sandbox, ["checkout", "-q", "-B", branch]);
		}
		const restored = await restoreRecoveryPatch(sandbox);
		store.patchState({ sessionValid: false });
		sandbox.emit({
			kind: "system",
			level: restored ? "info" : "warn",
			message: restored
				? "Workspace rebuilt from git and the last recovery patch. The agent keeps the conversation history but not its internal session."
				: "Workspace rebuilt from git. No recovery patch was available, so uncommitted work from before is lost.",
		});
		return;
	}

	await git(sandbox, ["checkout", "-q", "-b", branch]);
	const head = (await git(sandbox, ["rev-parse", "HEAD"])).stdout.trim();
	const baseRef =
		config.ref ?? (await git(sandbox, ["rev-parse", "--abbrev-ref", "origin/HEAD"])).stdout.trim().replace(/^origin\//, "");
	store.patchState({
		baseCommit: head || undefined,
		baseRef: baseRef && baseRef !== "HEAD" ? baseRef : undefined,
		branch,
		sessionValid: true,
	});
}

/** Diff of everything since the clone, including untracked files, as text. */
export async function readDiff(sandbox: Sandbox): Promise<{ diff: string; truncated: boolean }> {
	const base = sandbox.store.getState()?.baseCommit ?? "HEAD";
	await git(sandbox, ["add", "-N", "."]);
	const result = await git(sandbox, ["diff", "--no-color", base], { maxBytes: 900_000 });
	if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git diff failed");
	return { diff: result.stdout, truncated: result.truncated };
}

/**
 * Snapshots can be lost (30-day expiry, image change, restore failure). A patch
 * of the work since the clone, kept in R2, lets a rebuilt workspace catch up.
 */
export async function saveRecoveryPatch(sandbox: Sandbox): Promise<void> {
	const bucket = sandbox.env().ARTIFACTS;
	const base = sandbox.store.getState()?.baseCommit;
	if (!bucket || !base) return;

	await git(sandbox, ["add", "-N", "."]);
	const result = await git(sandbox, ["diff", "--binary", "--no-color", base], { maxBytes: MAX_PATCH_BYTES });
	if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git diff failed");
	const key = recoveryKey(sandbox.config.name);
	if (result.truncated) {
		throw new Error("workspace changes exceed the recovery patch size limit");
	}
	if (result.stdout.length === 0) {
		await bucket.delete(key);
		return;
	}
	await bucket.put(key, result.stdout, { customMetadata: { baseCommit: base } });
}

async function restoreRecoveryPatch(sandbox: Sandbox): Promise<boolean> {
	const bucket = sandbox.env().ARTIFACTS;
	if (!bucket) return false;
	const object = await bucket.get(recoveryKey(sandbox.config.name));
	if (!object) return false;
	try {
		await sandbox.files.writeFile(`${WORKSPACE}/recovery.patch`, await object.text());
		const applied = await git(sandbox, ["apply", "--index", "--whitespace=nowarn", `${WORKSPACE}/recovery.patch`]);
		await sandbox.exec(["rm", "-f", `${WORKSPACE}/recovery.patch`]);
		return applied.exitCode === 0;
	} catch (error) {
		console.warn("recovery patch failed to apply", describe(error));
		return false;
	}
}

export async function deleteRecoveryPatch(env: Env, orbName: string): Promise<void> {
	await env.ARTIFACTS?.delete(recoveryKey(orbName));
}

export interface PullRequest {
	url: string;
	number: number;
	existing: boolean;
}

/** Commit, push the orb's branch (through the credential-injecting Outbound), and open a PR from the Worker. */
export async function openPullRequest(
	sandbox: Sandbox,
	input: { title: string; body: string },
): Promise<PullRequest> {
	const { config, store, } = sandbox;
	const token = sandbox.env().GITHUB_TOKEN;
	if (!token) throw new Error("GITHUB_TOKEN is not configured");
	const state = store.getState();
	const branch = state?.branch ?? `orb/${config.id}`;

	const commit = await sandbox.exec(
		[
			"sh",
			"-c",
			'git add -A && { git diff --cached --quiet || git commit -q -m "$1"; }',
			"commit",
			input.title,
		],
		{ cwd: REPO_DIR, timeoutMs: 60_000 },
	);
	if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr.trim().slice(-400)}`);

	const push = await git(sandbox, ["push", "origin", `HEAD:refs/heads/${branch}`], { timeoutMs: 300_000 });
	if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr.trim().slice(-600)}`);

	const repo = `${config.repo.owner}/${config.repo.name}`;
	const headers = {
		authorization: `Bearer ${token}`,
		accept: "application/vnd.github+json",
		"user-agent": "cloudflare-orbs",
		"x-github-api-version": "2022-11-28",
	};

	let base = state?.baseRef;
	if (!base) {
		const info = await fetch(`https://api.github.com/repos/${repo}`, { headers });
		if (!info.ok) throw new Error(`GitHub API ${info.status} reading ${repo}`);
		base = ((await info.json()) as { default_branch: string }).default_branch;
	}

	const created = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify({ title: input.title, head: branch, base, body: input.body }),
	});
	if (created.ok) {
		const pr = (await created.json()) as { html_url: string; number: number };
		return { url: pr.html_url, number: pr.number, existing: false };
	}

	if (created.status === 422) {
		const existing = await fetch(
			`https://api.github.com/repos/${repo}/pulls?head=${encodeURIComponent(`${config.repo.owner}:${branch}`)}&state=open`,
			{ headers },
		);
		if (existing.ok) {
			const [pr] = (await existing.json()) as Array<{ html_url: string; number: number }>;
			if (pr) return { url: pr.html_url, number: pr.number, existing: true };
		}
	}
	const detail = (await created.text()).slice(0, 400);
	throw new Error(`GitHub API ${created.status} creating the pull request: ${detail}`);
}
