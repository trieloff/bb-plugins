import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GH_CANDIDATES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];

export interface GhCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * True when the run was cancelled rather than failed.
   *
   * A plugin reload aborts every in-flight `gh`, and the child dies with no
   * stderr and a non-zero exit — indistinguishable, to a caller reading only
   * `exitCode`, from GitHub refusing the request. Every reload therefore used
   * to log a burst of "failed" warnings naming pull requests that were
   * perfectly fine.
   */
  aborted: boolean;
}

/**
 * The HTTP status `gh api` puts on stderr, as in `gh: Not Found (HTTP 404)`.
 *
 * `gh` exits 1 for every HTTP error, so the process exit code cannot tell a
 * missing repository from a forbidden one from a rate limit. This is the only
 * place the status survives.
 */
export function githubHttpStatus(stderr: string): number | null {
  const match = /\(HTTP (\d{3})\)/.exec(stderr);
  return match === null ? null : Number(match[1]);
}

export interface GhRunner {
  run(args: readonly string[], timeoutMs?: number): Promise<GhCommandResult>;
}

function exec(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<GhCommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        const exitCode =
          error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        const aborted =
          error !== null &&
          error !== undefined &&
          ((error as NodeJS.ErrnoException).code === "ABORT_ERR" || signal.aborted);
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          exitCode: aborted ? 1 : exitCode,
          aborted,
        });
      },
    );
  });
}

export async function resolveGhPath(signal: AbortSignal): Promise<string | null> {
  for (const candidate of GH_CANDIDATES) {
    const result = await exec(candidate, ["--version"], 5_000, signal);
    if (result.exitCode === 0) return candidate;
  }
  return null;
}

export function createGhRunner(signal: AbortSignal, path: string): GhRunner {
  return {
    run(args, timeoutMs = 30_000) {
      return exec(path, args, timeoutMs, signal);
    },
  };
}

export async function githubRestJson(
  gh: GhRunner,
  path: string,
  timeoutMs = 20_000,
  init?: { method?: string; body?: unknown },
): Promise<{
  raw: unknown;
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted: boolean;
}> {
  const args = ["api", "--hostname", "github.com"];
  if (init?.method !== undefined && init.method !== "GET") {
    args.push("--method", init.method);
  }
  let inputPath: string | null = null;
  if (init?.body !== undefined) {
    inputPath = join(tmpdir(), `gtd-gh-${randomBytes(8).toString("hex")}.json`);
    await writeFile(inputPath, JSON.stringify(init.body), "utf8");
    args.push("--input", inputPath);
  }
  args.push(path);
  try {
    const result = await gh.run(args, timeoutMs);
    let raw: unknown = null;
    const trimmed = result.stdout.trim();
    if (trimmed.length > 0) {
      try {
        raw = JSON.parse(trimmed);
      } catch {
        raw = null;
      }
    }
    return {
      raw,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      aborted: result.aborted,
    };
  } finally {
    if (inputPath !== null) await unlink(inputPath).catch(() => undefined);
  }
}

export async function githubGraphql(
  gh: GhRunner,
  query: string,
  timeoutMs = 30_000,
): Promise<{
  raw: unknown;
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted: boolean;
}> {
  const result = await gh.run(
    ["api", "graphql", "--hostname", "github.com", "-f", `query=${query}`],
    timeoutMs,
  );
  let raw: unknown = null;
  const trimmed = result.stdout.trim();
  if (trimmed.length > 0) {
    try {
      raw = JSON.parse(trimmed);
    } catch {
      raw = null;
    }
  }
  return {
    raw,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    aborted: result.aborted,
  };
}
