import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/jetbrains-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
	navigator.serviceWorker.register("/sw.js").catch(() => {});
}
