import type { ParsedLine } from "./types.ts";

export function emptyParsed(): ParsedLine {
	return { events: [], deltas: [] };
}

export function safeJson(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export const MAX_OUTPUT_CHARS = 16_000;
export const MAX_TEXT_CHARS = 64_000;

/** Keep the head and tail of long output; the middle is rarely what matters. */
export function clip(text: string, max = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	const head = Math.floor(max * 0.6);
	const tail = max - head;
	const omitted = text.length - max;
	return {
		text: `${text.slice(0, head)}\n… [${omitted} characters omitted] …\n${text.slice(text.length - tail)}`,
		truncated: true,
	};
}
