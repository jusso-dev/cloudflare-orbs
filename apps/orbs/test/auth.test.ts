import { describe, expect, it } from "vitest";
import { ownerKeyFor, signTicket, verifyTicket } from "../src/worker/auth.ts";

const SECRET = "test-secret-test-secret-test-secret";
const user = { id: "alice@example.com", label: "alice@example.com" };

describe("tickets", () => {
	it("round-trips for the right scope and orb", async () => {
		const { ticket, expiresAt } = await signTicket(SECRET, user, "events", "abc123abc123", 60_000, 1_000);
		expect(expiresAt).toBe(61_000);
		expect(await verifyTicket(SECRET, ticket, "events", "abc123abc123", 2_000)).toEqual(user);
	});

	it("rejects expiry, wrong scope, wrong orb, wrong secret and tampering", async () => {
		const { ticket } = await signTicket(SECRET, user, "events", "orb111111111", 60_000, 1_000);
		expect(await verifyTicket(SECRET, ticket, "events", "orb111111111", 61_001)).toBeNull();
		expect(await verifyTicket(SECRET, ticket, "terminal", "orb111111111", 2_000)).toBeNull();
		expect(await verifyTicket(SECRET, ticket, "events", "orb222222222", 2_000)).toBeNull();
		expect(await verifyTicket("another-secret-another-secret-xx", ticket, "events", "orb111111111", 2_000)).toBeNull();

		const [body, mac] = ticket.split(".");
		const forged = JSON.parse(atob(body!.replace(/-/g, "+").replace(/_/g, "/")));
		forged.u = "mallory@example.com";
		const forgedBody = btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		expect(await verifyTicket(SECRET, `${forgedBody}.${mac}`, "events", "orb111111111", 2_000)).toBeNull();
		expect(await verifyTicket(SECRET, "garbage", "events", "orb111111111", 2_000)).toBeNull();
		expect(await verifyTicket(SECRET, "a.b", "events", "orb111111111", 2_000)).toBeNull();
	});

	it("hub tickets are not valid for an orb and vice versa", async () => {
		const hub = await signTicket(SECRET, user, "hub", undefined, 60_000, 1_000);
		expect(await verifyTicket(SECRET, hub.ticket, "hub", undefined, 2_000)).toEqual(user);
		expect(await verifyTicket(SECRET, hub.ticket, "hub", "orb111111111", 2_000)).toBeNull();
	});
});

describe("ownerKeyFor", () => {
	it("is stable, distinct per user, and does not expose the identity", async () => {
		const a = await ownerKeyFor("alice@example.com");
		expect(a).toMatch(/^[0-9a-f]{20}$/);
		expect(await ownerKeyFor("alice@example.com")).toBe(a);
		expect(await ownerKeyFor("bob@example.com")).not.toBe(a);
		expect(a).not.toContain("alice");
	});
});
