import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { ensureGithubRepoHook } from "../lib/github-hooks.ts";
import { githubHttpStatus, type GhRunner } from "../lib/gh-cli.ts";

function runner(
  hooks: unknown,
  onPatch?: (body: unknown) => void,
): GhRunner {
  return {
    async run(args) {
      const path = args.at(-1) ?? "";
      const methodIndex = args.indexOf("--method");
      const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
      if (path.includes("/hooks/") && method === "PATCH") {
        const inputIndex = args.indexOf("--input");
        const inputPath = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
        if (inputPath !== undefined && onPatch !== undefined) {
          onPatch(JSON.parse(await readFile(inputPath, "utf8")));
        }
        return { stdout: "{}", stderr: "", exitCode: 0, aborted: false };
      }
      if (path.includes("/hooks") && method === "GET") {
        return { stdout: JSON.stringify(hooks), stderr: "", exitCode: 0, aborted: false };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1, aborted: false };
    },
  };
}

describe("ensureGithubRepoHook", () => {
  const url = "https://ours.trycloudflare.com/github-webhook";
  const repo = { owner: "acme", repo: "app" };

  it("PATCHes the secret even when URL and events already match", async () => {
    let patched: unknown = null;
    const result = await ensureGithubRepoHook(
      runner(
        [
          {
            id: 9,
            events: [
              "pull_request",
              "pull_request_review",
              "pull_request_review_comment",
              "issue_comment",
              "check_suite",
              "deployment_status",
              "release",
            ],
            config: { url },
          },
        ],
        (body) => {
          patched = body;
        },
      ),
      repo,
      url,
      "new-secret",
    );
    assert.equal(result, "unchanged");
    assert.equal(
      (patched as { config?: { secret?: string } } | null)?.config?.secret,
      "new-secret",
    );
  });
});

/**
 * The refusal path, which used to be unreachable.
 *
 * `gh api` exits 1 for every HTTP error, so the old `exitCode === 403` test
 * could never fire and a repository this token may not touch was classified
 * as a transient error — which meant it was retried on every cycle, forever.
 */
describe("ensureGithubRepoHook denial", () => {
  const url = "https://ours.trycloudflare.com/github-webhook";
  const repo = { owner: "acme", repo: "app" };

  function failing(stderr: string, aborted = false): GhRunner {
    return {
      async run() {
        return { stdout: "", stderr, exitCode: aborted ? 1 : 1, aborted };
      },
    };
  }

  // What GitHub actually says when the token lacks admin:repo_hook. Note the
  // 404: it hides the endpoint rather than admitting a 403.
  it("reads a missing admin:repo_hook scope as denied, not as an error", async () => {
    const stderr =
      'gh: Not Found (HTTP 404)\ngh: This API operation needs the "admin:repo_hook" scope.';
    assert.equal(await ensureGithubRepoHook(failing(stderr), repo, url, "s"), "denied");
  });

  it("reads a plain 403 as denied", async () => {
    assert.equal(
      await ensureGithubRepoHook(failing("gh: Forbidden (HTTP 403)"), repo, url, "s"),
      "denied",
    );
  });

  it("reads a plain 404 as denied", async () => {
    assert.equal(
      await ensureGithubRepoHook(failing("gh: Not Found (HTTP 404)"), repo, url, "s"),
      "denied",
    );
  });

  // A 5xx or a dropped connection is worth trying again; it must not be
  // mistaken for a permission problem and suppressed for a day.
  it("still calls a server-side failure an error", async () => {
    assert.equal(
      await ensureGithubRepoHook(failing("gh: Bad Gateway (HTTP 502)"), repo, url, "s"),
      "error",
    );
  });

  it("still calls an unexplained failure an error", async () => {
    assert.equal(await ensureGithubRepoHook(failing("boom"), repo, url, "s"), "error");
  });

  // A reload aborts in-flight work. Nothing failed and nothing was refused.
  it("reports a cancelled run as cancelled", async () => {
    assert.equal(await ensureGithubRepoHook(failing("", true), repo, url, "s"), "cancelled");
  });
});

describe("githubHttpStatus", () => {
  it("reads the status gh puts on stderr", () => {
    assert.equal(githubHttpStatus("gh: Not Found (HTTP 404)"), 404);
    assert.equal(githubHttpStatus("gh: Forbidden (HTTP 403)"), 403);
  });

  it("returns null when there is no status to read", () => {
    assert.equal(githubHttpStatus(""), null);
    assert.equal(githubHttpStatus("connection reset"), null);
    // Not a status: three digits alone are not the shape gh prints.
    assert.equal(githubHttpStatus("exited 404"), null);
  });
});
