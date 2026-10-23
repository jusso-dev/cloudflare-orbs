import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { parseGitHubRepo, type ApprovalMode, type HarnessId, type InstanceType, type NetworkPolicy } from "@orbs/protocol/types";
import { api } from "../lib/api.ts";
import { useConfig } from "../lib/context.ts";
import { useAction } from "../lib/hooks.ts";

const INSTANCE_NOTES: Record<InstanceType, string> = {
	lite: "1/16 vCPU, 256 MiB. For light edits only.",
	"standard-1": "1/2 vCPU, 4 GiB. A good default.",
	"standard-2": "1 vCPU, 6 GiB.",
	"standard-3": "2 vCPU, 8 GiB.",
	"standard-4": "4 vCPU, 12 GiB. Big builds and test suites.",
};

export function NewOrb() {
	const config = useConfig();
	const [, navigate] = useLocation();
	const [repoUrl, setRepoUrl] = useState("");
	const [ref, setRef] = useState("");
	const [prompt, setPrompt] = useState("");
	const [harnessId, setHarnessId] = useState<HarnessId>(config.harnesses[0]?.id ?? "claude-code");
	const harness = config.harnesses.find((h) => h.id === harnessId) ?? config.harnesses[0]!;
	const [model, setModel] = useState<string>("");
	const [approvalMode, setApprovalMode] = useState<ApprovalMode>("auto");
	const [networkPolicy, setNetworkPolicy] = useState<NetworkPolicy>("packages");
	const [instance, setInstance] = useState<InstanceType>("standard-1");
	const [cost, setCost] = useState(config.limits.defaultBudget.maxCostUsd?.toString() ?? "");
	const [minutes, setMinutes] = useState(config.limits.defaultBudget.maxRuntimeMinutes?.toString() ?? "");

	const repoOk = useMemo(() => parseGitHubRepo(repoUrl) !== null, [repoUrl]);
	const create = useAction(async () => {
		const budget = {
			...(cost.trim() ? { maxCostUsd: Number(cost) } : {}),
			...(minutes.trim() ? { maxRuntimeMinutes: Math.round(Number(minutes)) } : {}),
		};
		const orb = await api.create({
			repoUrl: repoUrl.trim(),
			prompt: prompt.trim(),
			harness: harnessId,
			model: model || harness.defaultModel,
			approvalMode: harness.capabilities.approvals ? approvalMode : "auto",
			networkPolicy,
			instance,
			...(ref.trim() ? { ref: ref.trim() } : {}),
			budget,
		});
		navigate(`/orbs/${orb.id}`);
	});

	return (
		<form
			className="form-page"
			onSubmit={(event) => {
				event.preventDefault();
				void create.run();
			}}
		>
			<header>
				<Link href="/" className="back" aria-label="All orbs">
					<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
						<path d="M12.5 4.5 7 10l5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</Link>
				<h1>New orb</h1>
			</header>

			<label className="field">
				<span>GitHub repository</span>
				<input
					value={repoUrl}
					onChange={(event) => setRepoUrl(event.target.value)}
					placeholder="https://github.com/owner/repo"
					inputMode="url"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					required
					aria-invalid={repoUrl !== "" && !repoOk}
				/>
				{repoUrl !== "" && !repoOk && <em className="field-error">Use a URL like https://github.com/owner/repo</em>}
			</label>
			<label className="field">
				<span>Branch or tag <small>optional, defaults to the repository's default branch</small></span>
				<input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="main" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
			</label>
			<label className="field">
				<span>What should the agent do?</span>
				<textarea rows={6} value={prompt} onChange={(event) => setPrompt(event.target.value)} required placeholder="Fix the flaky test in the checkout flow and explain the cause" />
			</label>

			<div className="field-row">
				<label className="field">
					<span>Agent</span>
					<select
						value={harnessId}
						onChange={(event) => {
							setHarnessId(event.target.value as HarnessId);
							setModel("");
							if (!config.harnesses.find((h) => h.id === event.target.value)?.capabilities.approvals) setApprovalMode("auto");
						}}
					>
						{config.harnesses.map((h) => (
							<option key={h.id} value={h.id}>
								{h.label}
							</option>
						))}
					</select>
				</label>
				<label className="field">
					<span>Model</span>
					<select value={model || harness.defaultModel} onChange={(event) => setModel(event.target.value)}>
						{harness.models.map((m) => (
							<option key={m} value={m}>
								{m}
							</option>
						))}
					</select>
				</label>
			</div>

			<fieldset className="choice">
				<legend>Approvals</legend>
				<label className={approvalMode === "auto" ? "choice-item choice-on" : "choice-item"}>
					<input type="radio" name="approvals" checked={approvalMode === "auto"} onChange={() => setApprovalMode("auto")} />
					<span>
						<strong>Run freely</strong>
						<small>The agent works without asking. The workspace is isolated and has no secrets.</small>
					</span>
				</label>
				<label className={approvalMode === "ask" ? "choice-item choice-on" : "choice-item"}>
					<input type="radio" name="approvals" checked={approvalMode === "ask"} disabled={!harness.capabilities.approvals} onChange={() => setApprovalMode("ask")} />
					<span>
						<strong>Ask me first</strong>
						<small>{harness.capabilities.approvals ? "Edits and commands wait for your approval." : `${harness.label} cannot ask for approval.`}</small>
					</span>
				</label>
			</fieldset>

			<fieldset className="choice">
				<legend>Network</legend>
				<label className={networkPolicy === "packages" ? "choice-item choice-on" : "choice-item"}>
					<input type="radio" name="network" checked={networkPolicy === "packages"} onChange={() => setNetworkPolicy("packages")} />
					<span>
						<strong>Packages allowed</strong>
						<small>Model gateway, GitHub, and common package registries (npm, PyPI, crates.io, Go).</small>
					</span>
				</label>
				<label className={networkPolicy === "strict" ? "choice-item choice-on" : "choice-item"}>
					<input type="radio" name="network" checked={networkPolicy === "strict"} onChange={() => setNetworkPolicy("strict")} />
					<span>
						<strong>Model and repository only</strong>
						<small>Nothing else is reachable, so dependencies must already be in the repo.</small>
					</span>
				</label>
			</fieldset>

			<details className="advanced">
				<summary>Size and budget</summary>
				<label className="field">
					<span>Workspace size</span>
					<select value={instance} onChange={(event) => setInstance(event.target.value as InstanceType)}>
						{config.instances.map((i) => (
							<option key={i} value={i}>
								{i}
							</option>
						))}
					</select>
					<small>{INSTANCE_NOTES[instance]}</small>
				</label>
				<div className="field-row">
					<label className="field">
						<span>Model spend limit (USD)</span>
						<input inputMode="decimal" value={cost} onChange={(event) => setCost(event.target.value)} placeholder="No limit" />
					</label>
					<label className="field">
						<span>Awake time limit (minutes)</span>
						<input inputMode="numeric" value={minutes} onChange={(event) => setMinutes(event.target.value)} placeholder="No limit" />
					</label>
				</div>
				<p className="muted">The orb sleeps after {config.limits.idleSleepMinutes} idle minutes and costs nothing while it sleeps.</p>
			</details>

			{create.error && (
				<div className="banner banner-error" role="alert">
					{create.error}
				</div>
			)}
			<div className="form-actions">
				<Link href="/" className="btn btn-quiet">
					Cancel
				</Link>
				<button className="btn btn-primary" type="submit" disabled={!repoOk || !prompt.trim() || create.busy}>
					{create.busy ? "Creating…" : "Create orb"}
				</button>
			</div>
		</form>
	);
}
