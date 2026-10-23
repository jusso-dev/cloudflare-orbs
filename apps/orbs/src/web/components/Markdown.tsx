import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small Markdown renderer for agent output: paragraphs, lists, fenced
 * code, inline code, bold and http(s) links. It builds React elements only, so there is
 * no HTML injection path.
 */
export function Markdown({ text }: { text: string }) {
	const blocks: ReactNode[] = [];
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let i = 0;
	let key = 0;

	while (i < lines.length) {
		const line = lines[i]!;
		const fence = /^```(\w*)\s*$/.exec(line);
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
			i++;
			blocks.push(
				<pre key={key++} className="code-block">
					<code>{body.join("\n")}</code>
				</pre>,
			);
		} else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
			const ordered = /^\s*\d+\./.test(line);
			const items: string[] = [];
			while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) {
				items.push(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, ""));
			}
			const List = ordered ? "ol" : "ul";
			blocks.push(
				<List key={key++}>
					{items.map((item, n) => (
						<li key={n}>{inline(item)}</li>
					))}
				</List>,
			);
		} else if (/^#{1,4}\s+/.test(line)) {
			blocks.push(
				<p key={key++} className="md-heading">
					{inline(line.replace(/^#{1,4}\s+/, ""))}
				</p>,
			);
			i++;
		} else if (line.trim() === "") {
			i++;
		} else {
			const para: string[] = [];
			while (
				i < lines.length &&
				lines[i]!.trim() !== "" &&
				!/^```/.test(lines[i]!) &&
				!/^\s*([-*]|\d+\.)\s+/.test(lines[i]!) &&
				!/^#{1,4}\s+/.test(lines[i]!)
			) {
				para.push(lines[i++]!);
			}
			blocks.push(<p key={key++}>{inline(para.join("\n"))}</p>);
		}
	}
	return <div className="md">{blocks}</div>;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<)]+)/g;

function inline(text: string): ReactNode {
	const out: ReactNode[] = [];
	let last = 0;
	let key = 0;
	for (const match of text.matchAll(INLINE)) {
		const at = match.index ?? 0;
		if (at > last) out.push(<Fragment key={key++}>{text.slice(last, at)}</Fragment>);
		const [token] = match;
		if (token.startsWith("`")) out.push(<code key={key++}>{token.slice(1, -1)}</code>);
		else if (token.startsWith("**")) out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
		else if (token.startsWith("[")) {
			const link = /^\[([^\]]+)\]\((.+)\)$/.exec(token)!;
			out.push(
				<a key={key++} href={link[2]} target="_blank" rel="noopener noreferrer">
					{link[1]}
				</a>,
			);
		} else {
			out.push(
				<a key={key++} href={token} target="_blank" rel="noopener noreferrer">
					{token}
				</a>,
			);
		}
		last = at + token.length;
	}
	if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
	return out;
}
