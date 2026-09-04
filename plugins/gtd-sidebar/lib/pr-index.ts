/**
 * Sidebar PR badges without per-card `gh pr view`.
 *
 * bb's own hook runs GraphQL once per environment on mount. Reloading the
 * plugin stampedes that path and burns the 5,000-point GraphQL budget, after
 * which every badge goes blank. This path uses REST (`/repos/.../pulls`, a
 * separate 5,000/hour budget), one open list per repository, then a numbered
 * GET when that list misses (merged PRs drop off it), then title-text and a
 * local cache when REST is too tight to spend.
 */

import { githubPullUrl, parsePrRefFromTitle, type GithubRepo } from "./github-repo.ts";

export const PR_CACHE_FRESH_MS = 15 * 60 * 1000;
export const PR_MISS_CACHE_MS = 5 * 60 * 1000;
export const MIN_REST_REMAINING = 80;
export const MAX_REPOS_PER_TICK = 12;
export const MAX_PR_LOOKUPS_PER_TICK = 40;

export interface SidebarPullRequest {
  number: number;
  title: string;
  url: string;
  state: "draft" | "open" | "merged" | "closed";
  attention: string;
  source: "rest" | "cache" | "title";
}

/** Normalized GitHub check/status rollup. `pending` is CI still running. */
export type CheckRollup = "pending" | "success" | "failure" | "error";

export interface RestPull {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  headRef: string;
  /** Head commit SHA, used to fetch the combined status. */
  headSha: string;
  /** GitHub `mergeable_state`, or "unknown" when the list omits it. */
  mergeableState: string;
  /** GitHub `mergeable`; null when the list or a fresh GET has not computed it. */
  mergeable: boolean | null;
  autoMerge: boolean;
  /** True when GitHub's merge queue currently holds this pull. */
  inMergeQueue: boolean;
  /**
   * Combined checks/statuses for the head commit. Null when we have not
   * asked — GitHub's `mergeable_state` alone cannot tell pending CI from a
   * failed run (`blocked` and `unstable` cover both).
   */
  checkRollup: CheckRollup | null;
}

export interface CachedPullRow {
  environmentId: string;
  owner: string | null;
  repo: string | null;
  number: number | null;
  title: string | null;
  url: string | null;
  state: string | null;
  attention: string | null;
  fetchedAt: number;
}

export function isCacheFresh(row: CachedPullRow, now: number): boolean {
  if (row.number === null) return now - row.fetchedAt < PR_MISS_CACHE_MS;
  // Open and draft still move (merge, close). Trusting them for 15 minutes
  // left merged PRs grey until the title fallback recached them as open.
  if (row.state !== "merged" && row.state !== "closed") return false;
  return now - row.fetchedAt < PR_CACHE_FRESH_MS;
}

export function sidebarPrFromCache(row: CachedPullRow): SidebarPullRequest | null {
  if (
    row.number === null ||
    row.title === null ||
    row.url === null ||
    row.state === null ||
    row.attention === null
  ) {
    return null;
  }
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    state: asPrState(row.state),
    attention: row.attention,
    source: "cache",
  };
}

function asPrState(value: string): SidebarPullRequest["state"] {
  if (value === "draft" || value === "merged" || value === "closed") return value;
  return "open";
}

export function parseRestPull(raw: unknown): RestPull | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const number = record.number;
  const title = record.title;
  const url = record.html_url;
  const state = record.state;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return null;
  if (typeof title !== "string" || typeof url !== "string") return null;
  if (state !== "open" && state !== "closed") return null;
  const head = record.head;
  const headRecord =
    typeof head === "object" && head !== null && !Array.isArray(head)
      ? (head as Record<string, unknown>)
      : null;
  const headRef = headRecord?.ref;
  const headSha = headRecord?.sha;
  return {
    number,
    title,
    url,
    draft: record.draft === true,
    state,
    merged: record.merged === true || (record.merged_at != null && record.merged_at !== ""),
    headRef: typeof headRef === "string" ? headRef : "",
    headSha: typeof headSha === "string" ? headSha : "",
    mergeableState: typeof record.mergeable_state === "string" ? record.mergeable_state : "unknown",
    mergeable: typeof record.mergeable === "boolean" ? record.mergeable : null,
    autoMerge: record.auto_merge != null,
    inMergeQueue: false,
    checkRollup: null,
  };
}

export function parseRestPulls(raw: unknown): RestPull[] {
  if (!Array.isArray(raw)) return [];
  const pulls: RestPull[] = [];
  for (const entry of raw) {
    const parsed = parseRestPull(entry);
    if (parsed !== null) pulls.push(parsed);
  }
  return pulls;
}

export function matchPullForBranch(
  pulls: readonly RestPull[],
  branchName: string | null,
): RestPull | null {
  if (branchName === null || branchName.trim().length === 0) return null;
  const wanted = branchName.trim();
  if (wanted === "gitbutler/workspace") return null;
  if (/^\d+ GitButler branches$/u.test(wanted)) return null;
  const matches = pulls.filter((pull) => pull.headRef === wanted);
  if (matches.length === 0) return null;
  const open = matches.find((pull) => pull.state === "open");
  return open ?? matches[0] ?? null;
}

export function matchPullForBranches(
  pulls: readonly RestPull[],
  branchNames: readonly string[],
): RestPull | null {
  for (const branchName of branchNames) {
    const matched = matchPullForBranch(pulls, branchName);
    if (matched !== null) return matched;
  }
  return null;
}

export function matchPullForNumber(
  pulls: readonly RestPull[],
  number: number | null | undefined,
): RestPull | null {
  if (number === null || number === undefined) return null;
  return pulls.find((pull) => pull.number === number) ?? null;
}

/** Closed first, then open, so an open PR with the same number wins. */
export function mergeListedPulls(
  open: readonly RestPull[],
  closed: readonly RestPull[],
): RestPull[] {
  const byNumber = new Map<number, RestPull>();
  for (const pull of closed) byNumber.set(pull.number, pull);
  for (const pull of open) byNumber.set(pull.number, pull);
  return [...byNumber.values()];
}

export function parseCheckRollupState(value: unknown): CheckRollup | null {
  if (typeof value !== "string") return null;
  switch (value.toUpperCase()) {
    case "PENDING":
    case "EXPECTED":
      return "pending";
    case "SUCCESS":
      return "success";
    case "FAILURE":
      return "failure";
    case "ERROR":
      return "error";
    default:
      return null;
  }
}

/**
 * Combined status REST (`/commits/{sha}/status`). `total_count: 0` is "no
 * CI", which GitHub still reports as `pending` — that is not CI running.
 */
export function parseCombinedStatus(raw: unknown): CheckRollup | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const total = record.total_count;
  if (typeof total === "number" && total <= 0) return null;
  return parseCheckRollupState(record.state);
}

export function restPullAttention(pull: RestPull): string {
  if (pull.merged) return "merged";
  if (pull.state === "closed") return "closed";
  if (pull.draft || pull.mergeableState === "draft") return "draft";
  // Merge-queue membership is not `auto_merge`. Queue entries arrive with
  // `auto_merge: null` and `mergeable_state: unknown`, which used to paint
  // green as an ordinary open PR. Auto-merge is only a fallback after the
  // real mergeable state, so a blocked or dirty PR with auto-merge on does
  // not look queued.
  if (pull.inMergeQueue) return "queued";
  if (pull.mergeable === false || pull.mergeableState === "dirty") return "conflicts";
  // GitHub's `blocked` and `unstable` both mean "not clean": required or
  // optional checks may still be running, or they may have failed. The
  // rollup is what splits Schrödinger (yellow) from a real failure (red).
  const checks = parseCheckRollupState(pull.checkRollup);
  if (checks === "pending") return "checks_pending";
  if (checks === "failure" || checks === "error") return "checks_failed";
  switch (pull.mergeableState) {
    case "unstable":
      // Optional checks. Confirmed success is not an alarm; without a rollup
      // this state is pending-or-failed, and pending is the honest unread.
      return checks === "success" ? "none" : "checks_pending";
    case "blocked":
    case "behind":
      return "blocked";
    case "clean":
      return "ready_to_merge";
    default:
      return pull.autoMerge ? "queued" : "none";
  }
}

export function sidebarPrFromRest(pull: RestPull): SidebarPullRequest {
  const state: SidebarPullRequest["state"] = pull.merged
    ? "merged"
    : pull.draft
      ? "draft"
      : pull.state === "closed"
        ? "closed"
        : "open";
  return {
    number: pull.number,
    title: pull.title,
    url: pull.url,
    state,
    attention: restPullAttention(pull),
    source: "rest",
  };
}

export function sidebarPrFromTitle(
  title: string,
  repo: GithubRepo | null,
): SidebarPullRequest | null {
  const ref = parsePrRefFromTitle(title);
  if (ref === null) return null;
  const owner = ref.owner ?? repo?.owner ?? null;
  const name = ref.repo ?? repo?.repo ?? null;
  if (owner === null || name === null) return null;
  const state = "open";
  return {
    number: ref.number,
    title,
    url: githubPullUrl(owner, name, ref.number),
    state,
    attention: "none",
    source: "title",
  };
}

export function parseRestRateLimit(raw: unknown): {
  restRemaining: number;
  graphqlRemaining: number;
} | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const resources = (raw as Record<string, unknown>).resources;
  if (typeof resources !== "object" || resources === null || Array.isArray(resources)) {
    return null;
  }
  const core = (resources as Record<string, unknown>).core;
  const graphql = (resources as Record<string, unknown>).graphql;
  const restRemaining =
    typeof core === "object" && core !== null ? (core as Record<string, unknown>).remaining : null;
  const graphqlRemaining =
    typeof graphql === "object" && graphql !== null
      ? (graphql as Record<string, unknown>).remaining
      : null;
  if (typeof restRemaining !== "number" || typeof graphqlRemaining !== "number") return null;
  return { restRemaining, graphqlRemaining };
}

/**
 * True when only a numbered GET can decide this pull's attention.
 *
 * `/repos/.../pulls` omits `mergeable_state` — GitHub computes it lazily and
 * serves it from the single-PR route alone. Everything read off the list
 * therefore arrived as "unknown", collapsed to attention "none", and painted
 * green: #377 showed as a healthy open PR while it was blocked with failing
 * checks. Draft, merged, closed, and merge-queue membership are decidable
 * from the list (or the queue overlay) and skip the extra call. Auto-merge
 * is not: the list sets `auto_merge` while still omitting `mergeable_state`,
 * so skipping the GET left a blocked or conflicting PR looking queued.
 */
export function needsMergeStateLookup(pull: RestPull): boolean {
  if (pull.merged || pull.state === "closed") return false;
  if (pull.draft || pull.inMergeQueue) return false;
  return pull.mergeableState === "unknown";
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/u;

export function mergeQueueQuery(owner: string, repo: string): string | null {
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) return null;
  return `{ repository(owner: "${owner}", name: "${repo}") { mergeQueue { entries(first: 100) { nodes { pullRequest { number } } } } pullRequests(first: 100, states: OPEN) { nodes { number commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;
}

export function parseMergeQueueNumbers(raw: unknown): number[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const data = (raw as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
  const repository = (data as Record<string, unknown>).repository;
  if (typeof repository !== "object" || repository === null || Array.isArray(repository)) {
    return [];
  }
  const mergeQueue = (repository as Record<string, unknown>).mergeQueue;
  if (typeof mergeQueue !== "object" || mergeQueue === null || Array.isArray(mergeQueue)) {
    return [];
  }
  const entries = (mergeQueue as Record<string, unknown>).entries;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return [];
  const nodes = (entries as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return [];
  const numbers: number[] = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
    const pullRequest = (node as Record<string, unknown>).pullRequest;
    if (typeof pullRequest !== "object" || pullRequest === null || Array.isArray(pullRequest)) {
      continue;
    }
    const number = (pullRequest as Record<string, unknown>).number;
    if (typeof number === "number" && Number.isInteger(number) && number > 0) {
      numbers.push(number);
    }
  }
  return numbers;
}

export function withMergeQueueMembership(
  pulls: readonly RestPull[],
  queuedNumbers: readonly number[],
): RestPull[] {
  if (queuedNumbers.length === 0) return [...pulls];
  const queued = new Set(queuedNumbers);
  return pulls.map((pull) => (queued.has(pull.number) ? { ...pull, inMergeQueue: true } : pull));
}

export function parseOpenPullCheckRollups(raw: unknown): Map<number, CheckRollup> {
  const result = new Map<number, CheckRollup>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return result;
  const data = (raw as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return result;
  const repository = (data as Record<string, unknown>).repository;
  if (typeof repository !== "object" || repository === null || Array.isArray(repository)) {
    return result;
  }
  const pullRequests = (repository as Record<string, unknown>).pullRequests;
  if (typeof pullRequests !== "object" || pullRequests === null || Array.isArray(pullRequests)) {
    return result;
  }
  const nodes = (pullRequests as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return result;
  for (const node of nodes) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    const number = record.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) continue;
    const commits = record.commits;
    if (typeof commits !== "object" || commits === null || Array.isArray(commits)) continue;
    const commitNodes = (commits as Record<string, unknown>).nodes;
    if (!Array.isArray(commitNodes) || commitNodes.length === 0) continue;
    const wrap = commitNodes[0];
    if (typeof wrap !== "object" || wrap === null || Array.isArray(wrap)) continue;
    const commit = (wrap as Record<string, unknown>).commit;
    if (typeof commit !== "object" || commit === null || Array.isArray(commit)) continue;
    const rollupRecord = (commit as Record<string, unknown>).statusCheckRollup;
    const rollupState =
      typeof rollupRecord === "object" && rollupRecord !== null && !Array.isArray(rollupRecord)
        ? (rollupRecord as Record<string, unknown>).state
        : null;
    const rollup = parseCheckRollupState(rollupState);
    if (rollup !== null) result.set(number, rollup);
  }
  return result;
}

export function withCheckRollups(
  pulls: readonly RestPull[],
  rollups: ReadonlyMap<number, CheckRollup>,
): RestPull[] {
  if (rollups.size === 0) return [...pulls];
  return pulls.map((pull) => {
    const rollup = rollups.get(pull.number);
    if (rollup === undefined || pull.checkRollup !== null) return pull;
    return { ...pull, checkRollup: rollup };
  });
}

/** Combined-status REST is only useful when mergeable_state cannot decide. */
export function needsCheckRollupFetch(pull: RestPull): boolean {
  if (pull.checkRollup !== null) return false;
  if (pull.merged || pull.state === "closed" || pull.draft || pull.inMergeQueue) return false;
  if (pull.headSha.length === 0) return false;
  return (
    pull.mergeableState === "blocked" ||
    pull.mergeableState === "unstable" ||
    pull.mergeableState === "unknown"
  );
}
