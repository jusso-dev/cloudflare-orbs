export function relativeTime(ms: number, now = Date.now()): string {
	const seconds = Math.round((now - ms) / 1000);
	if (seconds < 45) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 14) return `${days}d ago`;
	return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function money(usd: number): string {
	if (usd === 0) return "$0";
	return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function duration(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function compact(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function repoName(url: string): string {
	return url.replace(/^https:\/\/github\.com\//, "");
}

export function clockTime(ms: number): string {
	return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}
