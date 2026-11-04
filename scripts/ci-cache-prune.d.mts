// Types for `ci-cache-prune.mjs`. It is plain JavaScript by design, because the janitor step runs it
// through Node directly, so only the two exports a caller reuses are declared here.

export interface ICacheEntry {
  readonly id: number;
  readonly key: string;
  readonly ref?: string;
  /**
   * The Actions API's own snake_case fields (`size_in_bytes`, `last_accessed_at`, `created_at`),
   * which this repository does not rename. The plan reads them and tolerates them being absent.
   */
  readonly [rest: string]: unknown;
}

export interface ICachePrunePlan {
  /** Ids to `DELETE /actions/caches/<id>`. */
  readonly deleteIds: number[];
  readonly totalBefore: number;
  readonly totalAfter: number;
  readonly budgetBytes: number;
  /** True when only hot keys are left and the total still exceeds the budget. */
  readonly overBudget: boolean;
}

/** Target for the whole repository, under the 10 GiB GitHub evicts at. */
export declare const CACHE_BUDGET_BYTES: number;

/** The share each per-run family may hold, keyed by key prefix. */
export declare const FAMILY_SHARES: Readonly<Record<string, number>>;

/** Keys every board reads that the plan never deletes. */
export declare const HOT_PREFIXES: readonly string[];

export declare function planCachePrune(options: {
  caches: readonly ICacheEntry[];
  budgetBytes?: number;
  familyShares?: Readonly<Record<string, number>>;
  hotPrefixes?: readonly string[];
}): ICachePrunePlan;

/** JSONL (one object per line) or one JSON document. */
export declare function parseCaches(text: string): ICacheEntry[];
