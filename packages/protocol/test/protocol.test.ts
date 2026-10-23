import { describe, expect, it } from "vitest";
import {
	ClientMessageSchema,
	CreateOrbRequestSchema,
	addUsage,
	EMPTY_USAGE,
	parseGitHubRepo,
	titleFromPrompt,
} from "../src/index.ts";

describe("parseGitHubRepo", () => {
	it("accepts plain, .git and trailing-slash urls", () => {
		expect(parseGitHubRepo("https://github.com/octocat/Hello-World")).toEqual({
			owner: "octocat",
			name: "Hello-World",
		});
		expect(parseGitHubRepo("https://github.com/octocat/Hello-World.git")?.name).toBe("Hello-World");
		expect(parseGitHubRepo("https://github.com/octocat/Hello-World/")?.name).toBe("Hello-World");
	});

	it("rejects other hosts, schemes and traversal", () => {
		expect(parseGitHubRepo("http://github.com/a/b")).toBeNull();
		expect(parseGitHubRepo("https://gitlab.com/a/b")).toBeNull();
		expect(parseGitHubRepo("https://github.com/a/b/c")).toBeNull();
		expect(parseGitHubRepo("https://github.com/a/..")).toBeNull();
		expect(parseGitHubRepo("https://github.com.evil.com/a/b")).toBeNull();
	});
});

describe("CreateOrbRequestSchema", () => {
	it("applies defaults", () => {
		const parsed = CreateOrbRequestSchema.parse({
			repoUrl: "https://github.com/octocat/Hello-World",
			prompt: "  add a readme  ",
		});
		expect(parsed.harness).toBe("claude-code");
		expect(parsed.approvalMode).toBe("auto");
		expect(parsed.networkPolicy).toBe("packages");
		expect(parsed.prompt).toBe("add a readme");
	});

	it("rejects shell-ish refs", () => {
		const result = CreateOrbRequestSchema.safeParse({
			repoUrl: "https://github.com/octocat/Hello-World",
			prompt: "x",
			ref: "main; rm -rf /",
		});
		expect(result.success).toBe(false);
	});
});

describe("ClientMessageSchema", () => {
	it("parses known messages and rejects unknown", () => {
		expect(ClientMessageSchema.parse({ type: "hello" })).toEqual({ type: "hello", lastSeq: 0 });
		expect(ClientMessageSchema.safeParse({ type: "nope" }).success).toBe(false);
		expect(ClientMessageSchema.safeParse({ type: "message", text: "" }).success).toBe(false);
	});
});

describe("helpers", () => {
	it("titleFromPrompt trims and truncates", () => {
		expect(titleFromPrompt("  Fix   the bug\nmore")).toBe("Fix the bug");
		expect(titleFromPrompt("a".repeat(100))).toHaveLength(70);
	});

	it("addUsage sums", () => {
		expect(addUsage(EMPTY_USAGE, { costUsd: 1.5, turns: 1 }).costUsd).toBe(1.5);
	});
});
