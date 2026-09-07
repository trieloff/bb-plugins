import type { GithubRepo } from "./github-repo.ts";
import {
  eventsMatch,
  GITHUB_WEBHOOK_EVENTS,
  matchingManagedGithubHook,
  webhookHookBody,
} from "./github-webhook.ts";
import { githubHttpStatus, githubRestJson, type GhRunner } from "./gh-cli.ts";

export type EnsureHookResult =
  | "created"
  | "updated"
  | "unchanged"
  | "denied"
  | "cancelled"
  | "error";

interface GhOutcome {
  stderr: string;
  exitCode: number;
  aborted: boolean;
}

/**
 * Whether GitHub refused this, as opposed to failing to answer.
 *
 * It cannot be read off the exit code: `gh` exits 1 for every HTTP error, so
 * the old `exitCode === 403` test could never be true and every refusal fell
 * through to "error" — which retries. That is why a handful of repositories
 * re-asked on every cycle forever and filled the log.
 *
 * A refusal here is nearly always a missing `admin:repo_hook` scope, and
 * GitHub answers that with 404 rather than 403 so the endpoint's existence
 * stays hidden. All three signals mean the same thing to us: this token will
 * not manage this repository's hooks today, so stop asking.
 */
function deniedBy(result: GhOutcome): boolean {
  if (result.exitCode === 0 || result.aborted) return false;
  if (result.stderr.includes("admin:repo_hook")) return true;
  const status = githubHttpStatus(result.stderr);
  return status === 403 || status === 404;
}

export async function ensureGithubRepoHook(
  gh: GhRunner,
  repo: GithubRepo,
  url: string,
  secret: string,
  previousUrl?: string | null,
): Promise<EnsureHookResult> {
  const listPath = `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/hooks?per_page=100`;
  const listed = await githubRestJson(gh, listPath, 15_000);
  if (listed.aborted) return "cancelled";
  if (deniedBy(listed)) return "denied";
  if (listed.exitCode !== 0) return "error";
  const existing = matchingManagedGithubHook(listed.raw, url, previousUrl);
  const createBody = webhookHookBody(url, secret);
  if (existing === null) {
    const created = await githubRestJson(
      gh,
      `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/hooks`,
      15_000,
      { method: "POST", body: createBody },
    );
    if (created.aborted) return "cancelled";
    if (deniedBy(created)) return "denied";
    if (created.exitCode !== 0) return "error";
    return "created";
  }
  const needsUrl = existing.url !== url;
  const needsEvents = !eventsMatch(existing.events, GITHUB_WEBHOOK_EVENTS);
  // GitHub never echoes the secret, so an uninstall that minted a new KV
  // secret would otherwise leave deliveries failing HMAC while we report
  // unchanged. Always PATCH config (url + secret) when we already own the hook.
  const patched = await githubRestJson(
    gh,
    `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/hooks/${existing.id}`,
    15_000,
    { method: "PATCH", body: createBody },
  );
  if (patched.aborted) return "cancelled";
  if (deniedBy(patched)) return "denied";
  if (patched.exitCode !== 0) return "error";
  return needsUrl || needsEvents ? "updated" : "unchanged";
}
