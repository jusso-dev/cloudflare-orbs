import { useState } from "react";
import { OrbGlyph } from "../components/OrbGlyph.tsx";
import { credentials } from "../lib/api.ts";

export function Login({ onDone }: { onDone: () => void }) {
	const [token, setToken] = useState("");
	return (
		<form
			className="login"
			onSubmit={(event) => {
				event.preventDefault();
				credentials.set(token.trim());
				onDone();
			}}
		>
			<span className="wordmark">
				<OrbGlyph status="idle" size={18} />
				Orbs
			</span>
			<h1>Sign in</h1>
			<p className="muted">Enter the access token for this deployment. If you use Cloudflare Access, reload the page to sign in through it.</p>
			<label className="field">
				<span>Access token</span>
				<input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="current-password" autoFocus required />
			</label>
			<button className="btn btn-primary" type="submit" disabled={!token.trim()}>
				Continue
			</button>
		</form>
	);
}
