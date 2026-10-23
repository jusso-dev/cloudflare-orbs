import { useEffect, useState } from "react";
import { Link } from "wouter";
import type { UsageResponse } from "@orbs/protocol/types";
import { OrbGlyph } from "../components/OrbGlyph.tsx";
import { api } from "../lib/api.ts";
import { compact, duration, money } from "../lib/format.ts";

export function Usage() {
	const [usage, setUsage] = useState<UsageResponse>();
	const [error, setError] = useState<string>();

	useEffect(() => {
		api.usage().then(setUsage, (cause: Error) => setError(cause.message));
	}, []);

	return (
		<div className="form-page">
			<header>
				<Link href="/" className="back" aria-label="All orbs">
					<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
						<path d="M12.5 4.5 7 10l5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</Link>
				<h1>Usage</h1>
			</header>
			{error && <div className="banner banner-error">{error}</div>}
			{usage && (
				<>
					<dl className="totals">
						<div>
							<dt>Model spend</dt>
							<dd>{money(usage.total.costUsd)}</dd>
						</div>
						<div>
							<dt>Awake time</dt>
							<dd>{duration(usage.total.containerSeconds)}</dd>
						</div>
						<div>
							<dt>Tokens</dt>
							<dd>{compact(usage.total.inputTokens + usage.total.outputTokens)}</dd>
						</div>
						<div>
							<dt>Awake now</dt>
							<dd>
								{usage.awakeOrbs} of {usage.maxConcurrentOrbs}
							</dd>
						</div>
					</dl>
					<p className="muted">
						Sleeping orbs have no running container, so they add no awake time. Model spend comes from the agents' own reports; AI Gateway has the authoritative per-orb breakdown.
					</p>
					<table className="usage-table">
						<thead>
							<tr>
								<th>Orb</th>
								<th>Spend</th>
								<th>Awake</th>
								<th>Turns</th>
							</tr>
						</thead>
						<tbody>
							{usage.orbs.map((orb) => (
								<tr key={orb.id}>
									<td>
										<Link href={`/orbs/${orb.id}`}>
											<OrbGlyph status={orb.status} size={11} /> {orb.title}
										</Link>
									</td>
									<td>{money(orb.usage.costUsd)}</td>
									<td>{duration(orb.usage.containerSeconds)}</td>
									<td>{orb.usage.turns}</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
		</div>
	);
}
