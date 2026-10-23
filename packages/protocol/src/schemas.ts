import { z } from "zod";
import {
	APPROVAL_MODES,
	HARNESS_IDS,
	INSTANCE_TYPES,
	NETWORK_POLICIES,
	parseGitHubRepo,
	type Budget,
	type ClientMessage,
	type CreateOrbRequest,
} from "./types.ts";

export const GitHubRepoUrl = z
	.string()
	.trim()
	.refine((value) => parseGitHubRepo(value) !== null, {
		message: "Expected https://github.com/<owner>/<repo>",
	});

export const BudgetSchema = z.object({
	maxCostUsd: z.number().positive().max(10_000).optional(),
	maxRuntimeMinutes: z
		.number()
		.int()
		.positive()
		.max(24 * 60 * 30)
		.optional(),
}) satisfies z.ZodType<Budget>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("hello"), lastSeq: z.number().int().min(0).default(0) }),
	z.object({ type: z.literal("message"), text: z.string().min(1).max(100_000) }),
	z.object({
		type: z.literal("approve"),
		approvalId: z.string().min(1).max(64),
		decision: z.enum(["allow", "deny", "allow_always"]),
	}),
	z.object({ type: z.literal("interrupt") }),
	z.object({ type: z.literal("ping") }),
]) satisfies z.ZodType<ClientMessage, unknown>;

export const CreateOrbRequestSchema = z.object({
	repoUrl: GitHubRepoUrl,
	ref: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.regex(/^[A-Za-z0-9._\/-]+$/, "Invalid ref")
		.optional(),
	prompt: z.string().trim().min(1).max(100_000),
	title: z.string().trim().min(1).max(120).optional(),
	harness: z.enum(HARNESS_IDS).default("claude-code"),
	model: z.string().trim().min(1).max(100).optional(),
	approvalMode: z.enum(APPROVAL_MODES).default("auto"),
	networkPolicy: z.enum(NETWORK_POLICIES).default("packages"),
	instance: z.enum(INSTANCE_TYPES).default("standard-1"),
	budget: BudgetSchema.optional(),
}) satisfies z.ZodType<CreateOrbRequest, unknown>;

export const SendMessageRequestSchema = z.object({
	text: z.string().trim().min(1).max(100_000),
});

export const ScheduleMessageRequestSchema = z.object({
	/** Unix ms. Must be in the future and within 30 days. */
	at: z.number().int(),
	text: z.string().trim().min(1).max(100_000),
});

export const ApprovalRequestSchema = z.object({
	decision: z.enum(["allow", "deny", "allow_always"]),
});

export const CreatePrRequestSchema = z.object({
	title: z.string().trim().min(1).max(256).optional(),
	body: z.string().max(60_000).optional(),
});
