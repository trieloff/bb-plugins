import { parsePrRefFromTitle, type GithubRepo } from "./github-repo.ts";
import {
  isCacheFresh,
  matchPullForBranches,
  matchPullForNumber,
  MAX_PR_LOOKUPS_PER_TICK,
  MAX_REPOS_PER_TICK,
  mergeListedPulls,
  MIN_REST_REMAINING,
  needsMergeStateLookup,
  rollupSettlesAttention,
  sidebarPrFromCache,
  sidebarPrFromRest,
  sidebarPrFromTitle,
  withCheckRollups,
  withMergeQueueMembership,
  withPullRelease,
  withReleaseState,
  type CachedPullRow,
  type CheckRollup,
  type LatestRelease,
  type RestPull,
  type SidebarPullRequest,
} from "./pr-index.ts";
import { isReloadCancellation } from "./shutdown.ts";

export interface ThreadPrQuery {
  threadId: string;
  environmentId: string | null;
  branchName: string | null;
  /** Extra git refs to try (GitButler virtual branch, bb's own branch). */
  branchNames?: readonly string[];
  title: string;
}

export interface PrIndexDeps {
  now: number;
  restRemaining: number | null;
  /**
   * True when GitHub has told us to slow down and the pause is still running.
   *
   * Separate from `restRemaining` because it answers a different question.
   * `restRemaining` is the primary budget, which a secondary rate limit does
   * not touch — it read 5000 of 5000 throughout the incident this exists for.
   * Folding one into the other would have hidden that, again.
   */
  skipRest?: boolean;
  /**
   * Whether the pause is running *right now*, asked again before each call.
   *
   * `skipRest` is read once, when the tick starts. That is the wrong tense for
   * a limit a tick can trip over halfway through: the first refusal latches a
   * pause, and every remaining thread in the same loop kept spending anyway,
   * sustaining the limit it had just been told about. This lets the rest of
   * the tick see the pause the tick itself created.
   */
  restPaused?(): boolean;
  getCache(environmentId: string): CachedPullRow | undefined;
  putCache(row: CachedPullRow): void;
  getRepo(environmentId: string): Promise<GithubRepo | null>;
  listOpenPulls(repo: GithubRepo): Promise<RestPull[]>;
  listRecentClosedPulls(repo: GithubRepo): Promise<RestPull[]>;
  /**
   * The numbered GET, the only route that carries `mergeable_state`.
   *
   * `known` is what this tick has already paid for: the head SHA the repo
   * listing reported, so an unchanged pull can be answered from a memo, and
   * the check rollup the repo-level GraphQL overlay returned, so the caller
   * does not buy the combined status a second time.
   */
  getPull(
    repo: GithubRepo,
    number: number,
    known?: { headSha?: string; checkRollup?: CheckRollup | null },
  ): Promise<RestPull | null>;
  /** GitHub merge-queue PR numbers for this repo; omit to skip the overlay. */
  listMergeQueueNumbers?(repo: GithubRepo): Promise<number[]>;
  /**
   * The repo's newest published release; null when it has never shipped one.
   * Omit to skip the overlay, and every merged PR stays plain merged.
   */
  getLatestRelease?(repo: GithubRepo): Promise<LatestRelease | null>;
  /** Head-commit check rollups for open PRs; omit to skip the overlay. */
  listCheckRollups?(repo: GithubRepo): Promise<ReadonlyMap<number, CheckRollup>>;
  log: { info(message: string): void; warn(message: string): void };
}

function cacheableChoice(chosen: SidebarPullRequest | null): boolean {
  return chosen === null || chosen.source === "rest";
}

function queryBranchNames(query: ThreadPrQuery): string[] {
  const names: string[] = [];
  for (const name of [query.branchName, ...(query.branchNames ?? [])]) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    names.push(trimmed);
  }
  return [...new Set(names)];
}

function numberedHint(
  query: ThreadPrQuery,
  repo: GithubRepo | null,
  stale: CachedPullRow | undefined,
): { number: number; repo: GithubRepo } | null {
  const fromTitle = parsePrRefFromTitle(query.title);
  // An explicit `owner/repo#N` names that repository, even when this thread's
  // checkout is somewhere else. Cache-number precedence is only for a bare `#N`.
  if (fromTitle !== null && fromTitle.owner !== null && fromTitle.repo !== null) {
    return { number: fromTitle.number, repo: { owner: fromTitle.owner, repo: fromTitle.repo } };
  }
  const owner = repo?.owner ?? stale?.owner ?? null;
  const name = repo?.repo ?? stale?.repo ?? null;
  // Cache number first: titles often cite a parent PR (`outside the #2255 sweep`)
  // while this thread's own PR is already known.
  const number = stale?.number ?? fromTitle?.number ?? null;
  if (owner === null || name === null || number === null) return null;
  return { number, repo: { owner, repo: name } };
}

function matchFromListedPulls(
  pulls: readonly RestPull[],
  query: ThreadPrQuery,
  stale: CachedPullRow | undefined,
): RestPull | null {
  const byBranch = matchPullForBranches(pulls, queryBranchNames(query));
  if (byBranch !== null) return byBranch;
  const byCacheNumber = matchPullForNumber(pulls, stale?.number ?? null);
  if (byCacheNumber !== null) return byCacheNumber;
  if (stale?.number != null) return null;
  const fromTitle = parsePrRefFromTitle(query.title);
  return matchPullForNumber(pulls, fromTitle?.number ?? null);
}

function usableStaleCache(
  stale: CachedPullRow | undefined,
  listedThisTick: boolean,
): SidebarPullRequest | null {
  const pr = stale === undefined ? null : sidebarPrFromCache(stale);
  if (pr === null) return null;
  if (!listedThisTick) return pr;
  if (pr.state === "merged" || pr.state === "closed") return pr;
  // An open/draft row that is not on this tick's open+closed lists is a lie:
  // #2450 stayed grey after merge because the pre-merge cache was reused.
  return null;
}

export async function resolveThreadPullRequests(
  queries: readonly ThreadPrQuery[],
  deps: PrIndexDeps,
): Promise<ReadonlyMap<string, SidebarPullRequest>> {
  const result = new Map<string, SidebarPullRequest>();
  const pending: ThreadPrQuery[] = [];

  for (const query of queries) {
    const fromTitle = sidebarPrFromTitle(query.title, null);
    if (query.environmentId === null) {
      if (fromTitle !== null) pending.push(query);
      continue;
    }
    const cached = deps.getCache(query.environmentId);
    if (cached !== undefined && isCacheFresh(cached, deps.now)) {
      const pr = sidebarPrFromCache(cached);
      if (pr !== null) result.set(query.threadId, pr);
      continue;
    }
    pending.push(query);
  }

  /**
   * Warn, unless the plugin is being replaced.
   *
   * Every catch below falls back to a safe empty value and logs why. A reload
   * makes all of them fire at once — sixteen environments in one second, in
   * the case that prompted this — naming things that were never broken.
   */
  const warnUnlessCancelled = (error: unknown, message: string): void => {
    if (isReloadCancellation(error)) return;
    deps.log.warn(message);
  };

  const repoByEnvironment = new Map<string, GithubRepo | null>();
  const uniqueEnvIds = [
    ...new Set(
      pending.map((query) => query.environmentId).filter((id): id is string => id !== null),
    ),
  ];
  await Promise.all(
    uniqueEnvIds.map(async (environmentId) => {
      try {
        repoByEnvironment.set(environmentId, await deps.getRepo(environmentId));
      } catch (error) {
        warnUnlessCancelled(error, `git remote for ${environmentId} failed: ${String(error)}`);
        repoByEnvironment.set(environmentId, null);
      }
    }),
  );

  const canSpendRest =
    deps.skipRest !== true &&
    (deps.restRemaining === null || deps.restRemaining >= MIN_REST_REMAINING);
  /** The budget at the top of the tick, and the pause as it stands right now. */
  const mayStillSpend = (): boolean => canSpendRest && deps.restPaused?.() !== true;
  const pullsByRepo = new Map<string, RestPull[]>();

  // One `releases/latest` per repository per tick, memoised for the numbered
  // lookups that reach repositories the list loop never visited. Capped with
  // the repo list so a sidebar full of unrelated checkouts cannot turn one
  // tick into a hundred release calls.
  const releaseByRepo = new Map<string, LatestRelease | null>();
  const releaseFor = async (repo: GithubRepo): Promise<LatestRelease | null> => {
    const key = `${repo.owner}/${repo.repo}`;
    const memo = releaseByRepo.get(key);
    if (memo !== undefined) return memo;
    if (!mayStillSpend() || deps.getLatestRelease === undefined) return null;
    if (releaseByRepo.size >= MAX_REPOS_PER_TICK) return null;
    let release: LatestRelease | null = null;
    try {
      release = await deps.getLatestRelease(repo);
    } catch (error) {
      warnUnlessCancelled(error, `latest release for ${key} failed: ${String(error)}`);
    }
    releaseByRepo.set(key, release);
    return release;
  };
  if (canSpendRest) {
    const repos: GithubRepo[] = [];
    const seen = new Set<string>();
    for (const environmentId of uniqueEnvIds) {
      const repo = repoByEnvironment.get(environmentId);
      if (repo === null || repo === undefined) continue;
      const key = `${repo.owner}/${repo.repo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push(repo);
      if (repos.length >= MAX_REPOS_PER_TICK) break;
    }
    for (const repo of repos) {
      // A refusal on the previous repository has already latched a pause. The
      // remaining repositories used to march straight through it.
      if (!mayStillSpend()) break;
      const key = `${repo.owner}/${repo.repo}`;
      let open: RestPull[] = [];
      let closed: RestPull[] = [];
      try {
        open = await deps.listOpenPulls(repo);
      } catch (error) {
        warnUnlessCancelled(error, `REST open pulls for ${key} failed: ${String(error)}`);
      }
      try {
        closed = await deps.listRecentClosedPulls(repo);
      } catch (error) {
        warnUnlessCancelled(error, `REST closed pulls for ${key} failed: ${String(error)}`);
      }
      let queuedNumbers: number[] = [];
      if (deps.listMergeQueueNumbers !== undefined) {
        try {
          queuedNumbers = await deps.listMergeQueueNumbers(repo);
        } catch (error) {
          warnUnlessCancelled(error, `merge queue for ${key} failed: ${String(error)}`);
        }
      }
      let checkRollups: ReadonlyMap<number, CheckRollup> = new Map();
      if (deps.listCheckRollups !== undefined) {
        try {
          checkRollups = await deps.listCheckRollups(repo);
        } catch (error) {
          warnUnlessCancelled(error, `check rollups for ${key} failed: ${String(error)}`);
        }
      }
      const release = await releaseFor(repo);
      // Queue membership, then the check rollup, then the release: each
      // overlay only reads what the list left out, and none reads another's
      // field, so the order is for reading, not for correctness.
      pullsByRepo.set(
        key,
        withReleaseState(
          withCheckRollups(
            withMergeQueueMembership(mergeListedPulls(open, closed), queuedNumbers),
            checkRollups,
          ),
          release,
        ),
      );
    }
    deps.log.info(
      `pr-index listed ${pullsByRepo.size} repos for ${pending.length} threads (REST remaining ${deps.restRemaining ?? "unknown"})`,
    );
  } else {
    deps.log.info(
      deps.skipRest === true
        ? "pr-index skipping REST (GitHub is rate limiting); cache and titles only"
        : `pr-index skipping REST (${deps.restRemaining} remaining); cache and titles only`,
    );
  }

  const pullByNumber = new Map<string, RestPull | null>();
  let numberedLookups = 0;

  const lookupNumbered = async (
    repo: GithubRepo,
    number: number,
    known?: { headSha?: string; checkRollup?: CheckRollup | null },
  ): Promise<RestPull | null> => {
    const key = `${repo.owner}/${repo.repo}#${number}`;
    if (pullByNumber.has(key)) return pullByNumber.get(key) ?? null;
    if (!mayStillSpend() || numberedLookups >= MAX_PR_LOOKUPS_PER_TICK) return null;
    numberedLookups += 1;
    try {
      const fetched = await deps.getPull(repo, number, known);
      // The numbered GET answers for repositories the list loop skipped, so
      // it carries the release overlay itself; without it a PR found only by
      // number would stay plain merged after its release shipped.
      const pull = fetched === null ? null : withPullRelease(fetched, await releaseFor(repo));
      pullByNumber.set(key, pull);
      return pull;
    } catch (error) {
      warnUnlessCancelled(error, `REST pull ${key} failed: ${String(error)}`);
      pullByNumber.set(key, null);
      return null;
    }
  };

  for (const query of pending) {
    const repo =
      query.environmentId === null ? null : (repoByEnvironment.get(query.environmentId) ?? null);
    const repoKey = repo === null ? null : `${repo.owner}/${repo.repo}`;
    const listedThisTick = repoKey !== null && pullsByRepo.has(repoKey);
    const pulls = repoKey === null ? [] : (pullsByRepo.get(repoKey) ?? []);
    const stale = query.environmentId === null ? undefined : deps.getCache(query.environmentId);
    let listed = matchFromListedPulls(pulls, query, stale);
    // The list route leaves `mergeable_state` out, so a listed open PR carries
    // no attention at all and paints green. Buy the real state with a numbered
    // GET; the lookup cache and per-tick cap keep the cost bounded.
    if (
      listed !== null &&
      repo !== null &&
      needsMergeStateLookup(listed) &&
      !rollupSettlesAttention(listed)
    ) {
      const detailed = await lookupNumbered(repo, listed.number, {
        headSha: listed.headSha,
        checkRollup: listed.checkRollup,
      });
      if (detailed !== null) {
        listed = {
          ...detailed,
          inMergeQueue: listed.inMergeQueue || detailed.inMergeQueue,
          checkRollup: detailed.checkRollup ?? listed.checkRollup,
        };
      }
    }
    const fromList = listed === null ? null : sidebarPrFromRest(listed);
    const hint = numberedHint(query, repo, stale);

    let fromLookup: SidebarPullRequest | null = null;
    if (fromList === null && hint !== null) {
      const pulled = await lookupNumbered(hint.repo, hint.number);
      fromLookup = pulled === null ? null : sidebarPrFromRest(pulled);
    }

    const fromTitle = listedThisTick ? null : sidebarPrFromTitle(query.title, hint?.repo ?? repo);
    const fromStale = usableStaleCache(stale, listedThisTick);
    const chosen = fromList ?? fromLookup ?? fromStale ?? fromTitle;

    if (query.environmentId !== null && cacheableChoice(chosen)) {
      deps.putCache({
        environmentId: query.environmentId,
        owner: repo?.owner ?? hint?.repo.owner ?? stale?.owner ?? null,
        repo: repo?.repo ?? hint?.repo.repo ?? stale?.repo ?? null,
        number: chosen?.number ?? null,
        title: chosen?.title ?? null,
        url: chosen?.url ?? null,
        state: chosen?.state ?? null,
        attention: chosen?.attention ?? null,
        fetchedAt: deps.now,
      });
    }
    if (chosen !== null) result.set(query.threadId, chosen);
  }

  return result;
}
