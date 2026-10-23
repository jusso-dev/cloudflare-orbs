export interface DiffLine {
	kind: "add" | "del" | "ctx" | "hunk" | "meta";
	text: string;
	oldNo?: number;
	newNo?: number;
}

export interface DiffFile {
	path: string;
	status: "added" | "deleted" | "modified" | "renamed" | "binary";
	added: number;
	removed: number;
	lines: DiffLine[];
}

/** Parse `git diff` output into files and numbered lines. */
export function parseDiff(diff: string): DiffFile[] {
	const files: DiffFile[] = [];
	let file: DiffFile | undefined;
	let oldNo = 0;
	let newNo = 0;
	let inHunk = false;

	for (const raw of diff.split("\n")) {
		if (raw.startsWith("diff --git ")) {
			const match = / b\/(.+)$/.exec(raw);
			file = { path: match?.[1] ?? raw.slice(11), status: "modified", added: 0, removed: 0, lines: [] };
			files.push(file);
			inHunk = false;
			continue;
		}
		if (!file) continue;

		if (!inHunk) {
			if (raw.startsWith("new file mode")) file.status = "added";
			else if (raw.startsWith("deleted file mode")) file.status = "deleted";
			else if (raw.startsWith("rename to ")) {
				file.status = "renamed";
				file.path = raw.slice(10);
			} else if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) file.status = "binary";
			else if (raw.startsWith("@@")) {
				// fallthrough to hunk handling below
			} else continue;
		}

		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
		if (hunk) {
			inHunk = true;
			oldNo = Number(hunk[1]);
			newNo = Number(hunk[2]);
			file.lines.push({ kind: "hunk", text: hunk[3]?.trim() ? `@@ ${hunk[3].trim()}` : "@@" });
			continue;
		}
		if (!inHunk) continue;

		if (raw.startsWith("+")) {
			file.added++;
			file.lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
		} else if (raw.startsWith("-")) {
			file.removed++;
			file.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
		} else if (raw.startsWith("\\")) {
			file.lines.push({ kind: "meta", text: raw });
		} else if (raw.startsWith(" ")) {
			file.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
		}
	}
	return files;
}
