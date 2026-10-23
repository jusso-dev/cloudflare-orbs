import type {
	ApprovalMode,
	Budget,
	GitHubRepo,
	HarnessId,
	InstanceType,
	NetworkPolicy,
} from "@orbs/protocol";

/** Immutable orb configuration, written once by `Orb.init()`. */
export interface OrbConfig {
	id: string;
	/** Durable Object name: `${ownerKey}:${id}`. */
	name: string;
	/** Hash of the owning user's identity. */
	ownerKey: string;
	ownerLabel: string;
	title: string;
	repoUrl: string;
	repo: GitHubRepo;
	ref?: string;
	harness: HarnessId;
	model: string;
	approvalMode: ApprovalMode;
	networkPolicy: NetworkPolicy;
	instance: InstanceType;
	budget: Budget;
	createdAt: number;
}

/** Result of an RPC that can fail in expected, user-visible ways. */
export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (status: number, error: string): Result<never> => ({ ok: false, status, error });
