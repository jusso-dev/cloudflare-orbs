import { useCallback, useEffect, useMemo, useState } from "react";
import type { DiffResponse, OrbSummary } from "@orbs/protocol/types";
import { Dialog } from "../components/Dialog.tsx";
import { api } from "../lib/api.ts";
import { parseDiff, type DiffFile } from "../lib/diff.ts";
import { useAction } from "../lib/hooks.ts";

export function DiffView({ orb }: { orb: OrbSummary }) {
	const [data, setData] = useState<DiffResponse>();
	const [error, setError] = useState<string>();
	const [prOpen, setPrOpen] = useState(false);
	const files = useMemo(() => parseDiff(data?.diff ?? ""), [data]);

	const load = useCallback(
		(fresh: boolean) => {
			api.diff(orb.id, fresh).then(setData, (cause: Error) => setError(cause.message));
		},
		[orb.id],
	);

	// The server caches the diff after every turn, so it is readable while the orb sleeps.
	useEffect(() => load(false), [load, orb.usage.turns, orb.status === "idle"]);

	const refresh = useAction(async () => {
		load(true);
	});

	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);

	return (
		<div className="panel diff">
			<div className="panel-bar">
				<div>
					<strong>{files.length === 0 ? "No changes yet" : `${files.length} file${files.length === 1 ? "" : "s"} changed`}</strong>
					{files.length > 0 && (
						<span className="facts">
							<span className="plus">+{added}</span> <span className="minus">−{removed}</span>
						</span>
					)}
				</div>
				<div className="panel-actions">
					<button className="btn btn-quiet" onClick={() => void refresh.run()} disabled={orb.status === "sleeping" || refresh.busy}>
						Refresh
					</button>
					{orb.prUrl ? (
						<a className="btn" href={orb.prUrl} target="_blank" rel="noopener noreferrer">
							View pull request
						</a>
					) : (
						<button className="btn btn-primary" onClick={() => setPrOpen(true)} disabled={files.length === 0}>
							Open pull request
						</button>
					)}
				</div>
			</div>
			{error && <div className="banner banner-error">{error}</div>}
			{data?.truncated && <div className="banner banner-warn">The diff is large, so only the start is shown.</div>}
			{files.length === 0 && !error && (
				<p className="empty">Changes the agent makes to the repository show up here, even while the orb sleeps.</p>
			)}
			<div className="diff-files">
				{files.map((file) => (
					<FileDiff key={file.path} file={file} startOpen={files.length <= 6} />
				))}
			</div>
			<PrDialog orb={orb} open={prOpen} onClose={() => setPrOpen(false)} />
		</div>
	);
}

function FileDiff({ file, startOpen }: { file: DiffFile; startOpen: boolean }) {
	const [open, setOpen] = useState(startOpen);
	return (
		<section className="file-diff">
			<button className="file-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className={`file-status file-${file.status}`}>{file.status}</span>
				<code>{file.path}</code>
				<span className="facts">
					<span className="plus">+{file.added}</span> <span className="minus">−{file.removed}</span>
				</span>
			</button>
			{open && file.status === "binary" && <p className="empty">Binary file</p>}
			{open && file.status !== "binary" && (
				<div className="lines" role="table">
					{file.lines.map((line, index) => (
						<div key={index} className={`line line-${line.kind}`} role="row">
							<span className="no" aria-hidden="true">{line.oldNo ?? ""}</span>
							<span className="no" aria-hidden="true">{line.newNo ?? ""}</span>
							<span className="sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span>
							<code>{line.text}</code>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

function PrDialog({ orb, open, onClose }: { orb: OrbSummary; open: boolean; onClose: () => void }) {
	const [title, setTitle] = useState(orb.title);
	const [body, setBody] = useState("");
	const create = useAction((titleValue: string, bodyValue: string) =>
		api.pr(orb.id, { title: titleValue, ...(bodyValue ? { body: bodyValue } : {}) }),
	);

	return (
		<Dialog open={open} onClose={onClose} title="Open a pull request">
			<p className="muted">
				Commits the changes to <code>{orb.branch ?? `orb/${orb.id}`}</code>, pushes it, and opens a pull request. The agent never holds your GitHub token.
			</p>
			<label className="field">
				<span>Title</span>
				<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={256} />
			</label>
			<label className="field">
				<span>Description</span>
				<textarea rows={5} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Leave blank to use the agent's summary" />
			</label>
			{create.error && <p className="field-error">{create.error}</p>}
			<div className="dialog-actions">
				<button className="btn btn-quiet" onClick={onClose}>
					Cancel
				</button>
				<button
					className="btn btn-primary"
					disabled={!title.trim() || create.busy}
					onClick={async () => {
						const result = (await create.run(title.trim(), body.trim())) as { url: string } | undefined;
						if (result) {
							onClose();
							window.open(result.url, "_blank", "noopener");
						}
					}}
				>
					{create.busy ? "Opening…" : "Open pull request"}
				</button>
			</div>
		</Dialog>
	);
}
