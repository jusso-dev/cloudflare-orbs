import { useEffect, useState } from "react";
import { Route, Switch, useLocation } from "wouter";
import type { AppConfig } from "@orbs/protocol/types";
import { OrbGlyph } from "./components/OrbGlyph.tsx";
import { api, credentials } from "./lib/api.ts";
import { ConfigContext } from "./lib/context.ts";
import { useOrbList } from "./lib/hooks.ts";
import { Login } from "./views/Login.tsx";
import { NewOrb } from "./views/NewOrb.tsx";
import { OrbView } from "./views/OrbView.tsx";
import { Rail } from "./views/Rail.tsx";
import { Usage } from "./views/Usage.tsx";

export function App() {
	const [config, setConfig] = useState<AppConfig>();
	const [signedOut, setSignedOut] = useState(false);
	const [error, setError] = useState<string>();

	useEffect(() => {
		const onUnauthorized = () => {
			credentials.clear();
			setSignedOut(true);
		};
		window.addEventListener("orbs:unauthorized", onUnauthorized);
		api.config().then(setConfig, (cause: Error & { status?: number }) => {
			if (cause.status !== 401) setError(cause.message);
		});
		return () => window.removeEventListener("orbs:unauthorized", onUnauthorized);
	}, []);

	if (signedOut) return <Login onDone={() => window.location.reload()} />;
	if (error) {
		return (
			<div className="login">
				<h1>Orbs could not load</h1>
				<p className="field-error">{error}</p>
				<button className="btn" onClick={() => window.location.reload()}>
					Try again
				</button>
			</div>
		);
	}
	if (!config) {
		return (
			<div className="splash" role="status">
				<OrbGlyph status="running" size={22} />
			</div>
		);
	}
	return (
		<ConfigContext.Provider value={config}>
			<Shell />
		</ConfigContext.Provider>
	);
}

function Shell() {
	const [location] = useLocation();
	const { orbs, error, connection } = useOrbList();
	// On a phone the list and the detail are separate screens; on a wide screen they sit side by side.
	const detail = location !== "/";

	return (
		<div className={detail ? "app has-detail" : "app"}>
			<Rail orbs={orbs} error={error} connection={connection} />
			<main className="main">
				<Switch>
					<Route path="/new" component={NewOrb} />
					<Route path="/usage" component={Usage} />
					<Route path="/orbs/:id">{(params) => <OrbView key={params.id} id={params.id} />}</Route>
					<Route>
						<div className="empty-state">
							<OrbGlyph status="sleeping" size={44} />
							<h2>Pick an orb, or start a new one</h2>
							<p>Orbs keep working while you are away and sleep, for free, when they have nothing to do.</p>
						</div>
					</Route>
				</Switch>
			</main>
		</div>
	);
}
