const decoder = new TextDecoder();

export interface ReceivePackCommands {
	/** Ref names the client wants to create, update or delete. */
	refs: string[];
	/** True once the flush-pkt that ends the command list has been seen. */
	complete: boolean;
}

/**
 * Read the command list at the start of a `git-receive-pack` request body:
 *
 *   [shallow <oid>]*  <old> <new> <ref>\0<capabilities>  ...  0000  PACK...
 *
 * Returns null when the bytes are not valid pkt-lines. `complete: false` means
 * the buffer ended before the flush-pkt, so more bytes are needed.
 */
export function parseReceivePackCommands(bytes: Uint8Array): ReceivePackCommands | null {
	const refs: string[] = [];
	let offset = 0;

	while (true) {
		if (offset + 4 > bytes.length) return { refs, complete: false };
		const header = decoder.decode(bytes.subarray(offset, offset + 4));
		if (!/^[0-9a-f]{4}$/i.test(header)) return null;
		const length = Number.parseInt(header, 16);

		if (length === 0) return { refs, complete: true }; // flush-pkt
		if (length < 4) return null;
		if (offset + length > bytes.length) return { refs, complete: false };

		const payload = decoder.decode(bytes.subarray(offset + 4, offset + length));
		offset += length;

		// A push from a shallow clone announces its shallow boundary first.
		if (payload.startsWith("shallow ")) continue;

		const command = payload.split("\0", 1)[0]?.replace(/\n$/, "") ?? "";
		const parts = command.split(" ");
		if (parts.length < 3) return null;
		refs.push(parts.slice(2).join(" "));
	}
}
