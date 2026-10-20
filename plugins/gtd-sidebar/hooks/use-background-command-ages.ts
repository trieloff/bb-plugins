import { useEffect, useMemo, useRef, useState } from "react";
import { useSdk, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  backgroundCommandsOutlived,
  newestBackgroundCommandStart,
  setAsideBackgroundCommands,
  waitsOnlyOnBackgroundCommands,
} from "../lib/background-work";
import { useMinuteClock } from "./use-minute-clock";

/** `id:count` per thread whose only live work is background commands. */
function candidateKey(threads: readonly PluginSidebarThread[]): string {
  return threads
    .filter(waitsOnlyOnBackgroundCommands)
    .map((thread) => `${thread.id}:${thread.activity.backgroundCommands}`)
    .join(" ");
}

function parseCandidates(key: string): Map<string, number> {
  if (key === "") return new Map();
  return new Map(
    key.split(" ").map((entry) => {
      const separator = entry.lastIndexOf(":");
      return [entry.slice(0, separator), Number(entry.slice(separator + 1))];
    }),
  );
}

/**
 * Threads whose background commands have all outlived
 * `BACKGROUND_COMMAND_WAIT_MS` stop counting those commands as work, so a dev
 * server or a watcher left running no longer holds its thread in Waiting.
 *
 * Only a thread whose sole live work is background commands is read, and once
 * per command count. A new command only starts during a turn, when the thread
 * is working anyway, so while the count holds still the commands are the same
 * ones and their start times stand. A count that drops means one finished,
 * and the remaining ones are read again.
 */
export function useBackgroundCommandAges(
  threads: readonly PluginSidebarThread[],
): readonly PluginSidebarThread[] {
  const sdk = useSdk();
  const now = useMinuteClock();
  const [starts, setStarts] = useState<ReadonlyMap<string, number | null>>(() => new Map());
  /** The command count each read answers for, so one count is read once. */
  const requested = useRef(new Map<string, number>());
  const candidates = useMemo(() => candidateKey(threads), [threads]);

  useEffect(() => {
    const counts = parseCandidates(candidates);
    const answered = requested.current;
    for (const threadId of answered.keys()) {
      if (!counts.has(threadId)) answered.delete(threadId);
    }
    setStarts((current) => {
      const kept = new Map([...current].filter(([threadId]) => counts.has(threadId)));
      return kept.size === current.size ? current : kept;
    });

    const controller = new AbortController();
    const inFlight = new Set<string>();
    const read = async (threadId: string) => {
      try {
        const { activeBackgroundCommands } = await sdk.threads.timeline({
          threadId,
          summaryOnly: "true",
          segmentLimit: "1",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const newest = newestBackgroundCommandStart(activeBackgroundCommands);
        setStarts((current) =>
          current.get(threadId) === newest ? current : new Map(current).set(threadId, newest),
        );
      } catch {
        // A failed read leaves the thread working, as it always was; the next
        // change in its commands reads again.
        if (!controller.signal.aborted) answered.delete(threadId);
      } finally {
        inFlight.delete(threadId);
      }
    };
    for (const [threadId, count] of counts) {
      if (answered.get(threadId) === count) continue;
      answered.set(threadId, count);
      inFlight.add(threadId);
      void read(threadId);
    }
    return () => {
      controller.abort();
      // A read cut off here never answered, so the next pass asks again.
      for (const threadId of inFlight) answered.delete(threadId);
    };
  }, [sdk, candidates]);

  return useMemo(() => {
    let changed = false;
    const next = threads.map((thread) => {
      if (!waitsOnlyOnBackgroundCommands(thread)) return thread;
      const newest = starts.get(thread.id);
      if (newest === undefined || !backgroundCommandsOutlived(newest, now)) return thread;
      changed = true;
      return setAsideBackgroundCommands(thread);
    });
    return changed ? next : threads;
  }, [threads, starts, now]);
}
