import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * The folded thread rows, kept in the plugin's own storage so a fold survives
 * a reload and reaches every window. bb 0.46 retired the
 * `sidebar.collapsedThreads` UI preference this used to share with the
 * built-in sidebar, so a fold no longer crosses between the two sidebars.
 */
export const COLLAPSED_THREADS_KEY = "collapsed-threads";

type Kv = Pick<BbPluginApi["storage"]["kv"], "get" | "set">;

export function toggleThreadId(threadIds: readonly string[], threadId: string): string[] {
  return threadIds.includes(threadId)
    ? threadIds.filter((id) => id !== threadId)
    : [...threadIds, threadId];
}

export interface CollapsedThreadsStore {
  list(): Promise<string[]>;
  /** Folds an open family or opens a folded one; resolves to the new list. */
  toggle(threadId: string): Promise<string[]>;
  /** Drops a deleted thread's fold so the list does not grow without bound. */
  forget(threadId: string): Promise<void>;
}

/**
 * Every write is a read-modify-write of one key, so writes queue behind each
 * other: two windows toggling at once must both land, not the later one only.
 */
export function createCollapsedThreadsStore(kv: Kv): CollapsedThreadsStore {
  const read = async () => {
    const stored = await kv.get<unknown>(COLLAPSED_THREADS_KEY);
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  };
  let writes: Promise<unknown> = Promise.resolve();
  const update = (change: (threadIds: string[]) => string[]) => {
    const next = writes.then(async () => {
      const current = await read();
      const updated = change(current);
      if (updated !== current) await kv.set(COLLAPSED_THREADS_KEY, updated);
      return updated;
    });
    writes = next.catch(() => undefined);
    return next;
  };
  return {
    list: read,
    toggle: (threadId) => update((current) => toggleThreadId(current, threadId)),
    async forget(threadId) {
      await update((current) =>
        current.includes(threadId) ? current.filter((id) => id !== threadId) : current,
      );
    },
  };
}
