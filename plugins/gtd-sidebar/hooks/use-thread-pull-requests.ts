import { useEffect, useMemo, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { gtdSidebarRpcContract } from "@/server";
import { PR_INDEX_CHANNEL } from "@/lib/channels";
import { threadDisplayTitle } from "@/lib/inbox";
import { resolveSidebarBranchLabel } from "@/lib/gitbutler";
import type { SidebarPullRequest } from "@/lib/pr-index";

function branchNamesFor(
  thread: PluginSidebarThread,
  gitButlerLabels: ReadonlyMap<string, string>,
): string[] {
  const raw = thread.environment?.branchName?.trim() ?? "";
  const label =
    resolveSidebarBranchLabel(
      thread.environment?.branchName ?? null,
      thread.environment?.id ?? null,
      gitButlerLabels,
    )?.trim() ?? "";
  const names: string[] = [];
  if (raw.length > 0) names.push(raw);
  if (label.length > 0 && label !== raw) names.push(label);
  return names;
}

/** The unconditional backfill, for when webhook delivery is not set up. */
const RECONCILE_INTERVAL_MS = 10 * 60_000;
/** The floor between two reconciles, whatever asked for them. */
const MIN_RECONCILE_INTERVAL_MS = 60_000;

interface IndexRow {
  environmentId: string;
  number: number;
  title: string;
  url: string;
  state: string;
  attention: string;
}

function asIndexRow(value: unknown): IndexRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.environmentId !== "string") return null;
  if (typeof record.number !== "number" || typeof record.title !== "string") return null;
  if (typeof record.url !== "string" || typeof record.state !== "string") return null;
  if (typeof record.attention !== "string") return null;
  return {
    environmentId: record.environmentId,
    number: record.number,
    title: record.title,
    url: record.url,
    state: record.state,
    attention: record.attention,
  };
}

export function useThreadPullRequests(
  threads: readonly PluginSidebarThread[],
  gitButlerLabels: ReadonlyMap<string, string>,
): ReadonlyMap<string, SidebarPullRequest> {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [byThreadId, setByThreadId] = useState<ReadonlyMap<string, SidebarPullRequest>>(
    () => new Map(),
  );

  const payload = useMemo(
    () =>
      threads.slice(0, 100).map((thread) => ({
        threadId: thread.id,
        environmentId: thread.environment?.id ?? null,
        branchName: thread.environment?.branchName ?? null,
        branchNames: branchNamesFor(thread, gitButlerLabels),
        title: threadDisplayTitle(thread),
      })),
    [gitButlerLabels, threads],
  );
  const payloadKey = useMemo(
    () =>
      payload
        .map(
          (row) =>
            `${row.threadId}:${row.environmentId ?? ""}:${row.branchName ?? ""}:${row.branchNames.join(",")}:${row.title}`,
        )
        .join("\n"),
    [payload],
  );

  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const refreshGeneration = useRef(0);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const lastStartedAt = useRef(0);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useRef<() => Promise<void>>(async () => {});
  const schedule = useRef<(immediate?: boolean) => void>(() => {});

  refresh.current = async () => {
    // One reconcile at a time. This RPC asks GitHub about every repository the
    // visible threads live in, so two of them overlapping is two of every call.
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    const current = payloadRef.current;
    const generation = ++refreshGeneration.current;
    if (current.length === 0) {
      if (generation === refreshGeneration.current) setByThreadId(new Map());
      return;
    }
    inFlight.current = true;
    lastStartedAt.current = Date.now();
    try {
      const result = await rpc.call("listThreadPullRequests", {
        threads: current,
      });
      if (generation !== refreshGeneration.current) return;
      setByThreadId(
        new Map(
          result.pullRequests.map((row) => [
            row.threadId,
            {
              number: row.number,
              title: row.title,
              url: row.url,
              state: row.state as SidebarPullRequest["state"],
              attention: row.attention,
              source: row.source,
            },
          ]),
        ),
      );
    } catch {
      // Keep the last index. A failed hydrate must not blank badges.
    } finally {
      inFlight.current = false;
      if (queued.current) {
        queued.current = false;
        schedule.current();
      }
    }
  };

  /**
   * A reconcile at most once a minute, however many reasons there are to want
   * one.
   *
   * Every reason to refresh used to be a refresh. The effect below re-ran on
   * any change to the payload — and the payload carries every visible thread's
   * title, which agents rewrite constantly — while realtime added one per
   * webhook that named no row. A single push to a busy repository could set
   * off several full reconciles in a few seconds, each one asking GitHub about
   * every repository on screen. Webhooks are the fast path and paint the badge
   * directly; the reconcile behind them is a backfill and can wait.
   */
  schedule.current = (immediate = false) => {
    const wait = immediate
      ? 0
      : Math.max(0, lastStartedAt.current + MIN_RECONCILE_INTERVAL_MS - Date.now());
    // A pending trailing reconcile already covers every later request, so they
    // collapse into it rather than queueing behind each other.
    if (throttleTimer.current !== null) {
      if (wait > 0) return;
      clearTimeout(throttleTimer.current);
      throttleTimer.current = null;
    }
    if (wait === 0) {
      void refresh.current();
      return;
    }
    throttleTimer.current = setTimeout(() => {
      throttleTimer.current = null;
      void refresh.current();
    }, wait);
  };

  const hydrated = useRef(false);
  useEffect(() => {
    let cancelled = false;
    // Only the first mount is worth jumping the throttle for. If `rpc` ever
    // changed identity between renders this would otherwise be an unthrottled
    // reconcile per render, which is the shape of the bug being fixed.
    if (hydrated.current) {
      schedule.current();
    } else {
      hydrated.current = true;
      schedule.current(true);
    }
    // Reconcile rarely: GitHub webhooks drive live colour, but delivery can
    // miss (bb connect is session-gated, so hooks may not be registered).
    const timer = setInterval(() => {
      if (!cancelled) schedule.current();
    }, RECONCILE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (throttleTimer.current !== null) {
        clearTimeout(throttleTimer.current);
        throttleTimer.current = null;
      }
    };
  }, [rpc]);

  // A thread arriving, a branch being renamed, or an agent rewriting a title
  // all change what this hook would ask for — but none of them is urgent, and
  // the last of those happens all day long. Ask again, on the throttle.
  const firstPayload = useRef(true);
  useEffect(() => {
    if (firstPayload.current) {
      firstPayload.current = false;
      return;
    }
    schedule.current();
  }, [payloadKey]);

  useRealtime(PR_INDEX_CHANNEL, (payloadValue) => {
    if (typeof payloadValue !== "object" || payloadValue === null || Array.isArray(payloadValue)) {
      schedule.current();
      return;
    }
    const record = payloadValue as Record<string, unknown>;
    if (record.refresh === true) {
      schedule.current();
      return;
    }
    if (!Array.isArray(record.rows)) {
      schedule.current();
      return;
    }
    const rows = record.rows.flatMap((entry) => {
      const row = asIndexRow(entry);
      return row === null ? [] : [row];
    });
    if (rows.length === 0) return;
    const byEnv = new Map(rows.map((row) => [row.environmentId, row]));
    setByThreadId((prev) => {
      const next = new Map(prev);
      for (const thread of payloadRef.current) {
        if (thread.environmentId === null) continue;
        const row = byEnv.get(thread.environmentId);
        if (row === undefined) continue;
        next.set(thread.threadId, {
          number: row.number,
          title: row.title,
          url: row.url,
          state: row.state as SidebarPullRequest["state"],
          attention: row.attention,
          source: "rest",
        });
      }
      return next;
    });
  });

  const connectionState = useRealtimeConnectionState();
  const seenConnected = useRef(false);
  useEffect(() => {
    if (connectionState !== "connected") return;
    if (!seenConnected.current) {
      seenConnected.current = true;
      return;
    }
    // Reconnecting means deliveries may have been missed while we were away,
    // so this one is worth doing at once rather than on the throttle.
    schedule.current(true);
  }, [connectionState]);

  return byThreadId;
}
