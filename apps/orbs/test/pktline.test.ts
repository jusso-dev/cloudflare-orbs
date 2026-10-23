import { describe, expect, it } from "vitest";
import { parseReceivePackCommands } from "../src/worker/pktline.ts";

const enc = new TextEncoder();
const OID = "0".repeat(40);
const NEW = "a".repeat(40);

function pkt(payload: string): string {
	return (payload.length + 4).toString(16).padStart(4, "0") + payload;
}

const bytes = (...parts: string[]) => enc.encode(parts.join(""));

describe("parseReceivePackCommands", () => {
	it("reads a single ref update with capabilities", () => {
		const body = bytes(pkt(`${OID} ${NEW} refs/heads/orb/abc\0report-status side-band-64k`), "0000", "PACK....");
		expect(parseReceivePackCommands(body)).toEqual({ refs: ["refs/heads/orb/abc"], complete: true });
	});

	it("reads several commands", () => {
		const body = bytes(
			pkt(`${OID} ${NEW} refs/heads/orb/abc\0report-status`),
			pkt(`${OID} ${NEW} refs/heads/main`),
			"0000",
		);
		expect(parseReceivePackCommands(body)?.refs).toEqual(["refs/heads/orb/abc", "refs/heads/main"]);
	});

	it("skips the shallow lines a push from a shallow clone starts with", () => {
		const body = bytes(
			pkt(`shallow ${NEW}`),
			pkt(`${OID} ${NEW} refs/heads/orb/abc\0report-status`),
			"0000",
		);
		expect(parseReceivePackCommands(body)).toEqual({ refs: ["refs/heads/orb/abc"], complete: true });
	});

	it("reports incomplete input so the caller can read more", () => {
		const full = bytes(pkt(`${OID} ${NEW} refs/heads/orb/abc\0caps`), "0000");
		expect(parseReceivePackCommands(full.subarray(0, 3))).toEqual({ refs: [], complete: false });
		expect(parseReceivePackCommands(full.subarray(0, 30))).toEqual({ refs: [], complete: false });
		const noFlush = bytes(pkt(`${OID} ${NEW} refs/heads/orb/abc\0caps`));
		expect(parseReceivePackCommands(noFlush)).toEqual({ refs: ["refs/heads/orb/abc"], complete: false });
	});

	it("rejects malformed framing", () => {
		expect(parseReceivePackCommands(enc.encode("zzzzxxxx"))).toBeNull();
		expect(parseReceivePackCommands(enc.encode("0002ab"))).toBeNull();
		expect(parseReceivePackCommands(bytes(pkt("only-two parts")))).toBeNull();
	});

	it("handles a delete command (ref only after a zero new-oid)", () => {
		const body = bytes(pkt(`${NEW} ${OID} refs/heads/other\0caps`), "0000");
		expect(parseReceivePackCommands(body)?.refs).toEqual(["refs/heads/other"]);
	});
});
