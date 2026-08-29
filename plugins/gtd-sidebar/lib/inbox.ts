import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { isThreadWorking } from "./lifecycle.ts";

/**
 * The static sort for user-controlled shelves: newest thread on top.
 *
 * Ties break on id so the order is total and stable across renders.
 */
export function sortByCreatedAtDescending<
  T extends { readonly id: string; readonly createdAt: number },
>(threads: readonly T[]): T[] {
  return [...threads].sort(
    (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}

export type ActiveSection = "next-action" | "waiting";

/**
 * How long background-only work holds a thread in Waiting.
 *
 * Waiting answers "the agent has this, leave it alone". A background job that
 * has run for an hour has stopped answering it: the thread sat in Waiting for
 * hours on end, out of the list the user actually works from, because some
 * long-running job never finished. Past this the thread returns to Next Action
 * and the job keeps running — the section is about whose move it is, not about
 * whether anything is still executing.
 */
export const BACKGROUND_WAIT_MAX_MS = 60 * 60 * 1000;

/**
 * A live agent turn, the one kind of work that holds Waiting open indefinitely.
 *
 * bb reports it as the `runtime` indicator — the spinner, as opposed to the
 * shine icons it draws for workflows, background agents and commands, plan
 * mode and goals. While a turn is running the thread genuinely is the agent's,
 * and interrupting it is the user's business, not the sidebar's.
 */
function hasLiveAgentTurn(thread: PluginSidebarThread): boolean {
  return thread.indicator === "runtime";
}

/** Whether the only thing keeping this thread busy is background work. */
export function isBackgroundOnlyWork(thread: PluginSidebarThread): boolean {
  return !thread.hasPendingInteraction && isThreadWorking(thread) && !hasLiveAgentTurn(thread);
}

/**
 * The active section whose next move can change the thread.
 *
 * A pending interaction always needs the user, even when background work is
 * still live. Otherwise any foreground or background work means the user is
 * waiting for the agent; a quiet thread is ready for the user's next action —
 * except that background-only work times out, see `BACKGROUND_WAIT_MAX_MS`.
 *
 * `backgroundSince` is when the current run of background-only work was first
 * observed; null when it is not background-only or has not been seen yet, in
 * which case Waiting stands. `reconcileActiveSectionOrder` owns that map.
 */
export function activeSectionFor(
  thread: PluginSidebarThread,
  clock?: { now: number; backgroundSince: number | null },
): ActiveSection {
  if (thread.hasPendingInteraction || !isThreadWorking(thread)) return "next-action";
  if (hasLiveAgentTurn(thread)) return "waiting";
  if (clock === undefined || clock.backgroundSince === null) return "waiting";
  return clock.now - clock.backgroundSince >= BACKGROUND_WAIT_MAX_MS ? "next-action" : "waiting";
}

interface ActiveSectionOrderEntry {
  section: ActiveSection;
  sequence: number;
}

/**
 * Mounted-list entrance order for the two active sections.
 *
 * The SDK has no historical section-entry timestamp. `updatedAt` is therefore
 * only the deterministic first-mount seed and batch tie-breaker; after that,
 * sequence changes only when a thread enters a section.
 */
export interface ActiveSectionOrder {
  entries: ReadonlyMap<string, ActiveSectionOrderEntry>;
  nextSequence: number;
  /**
   * When each thread's current run of background-only work was first seen.
   *
   * Dropped the moment the thread stops being background-only, so finishing a
   * job — or taking an agent turn — starts the hour over rather than leaving a
   * thread permanently expired.
   */
  backgroundSince: ReadonlyMap<string, number>;
}

function compareInitialEntrance(left: PluginSidebarThread, right: PluginSidebarThread): number {
  return (
    left.updatedAt - right.updatedAt ||
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Reconcile every active, unpinned thread against its mounted-list order.
 *
 * Callers must pass the unfiltered active set. Project scope, search, and child
 * hiding affect presentation only and must not look like section exits.
 */
export function reconcileActiveSectionOrder(
  current: ActiveSectionOrder | null,
  threads: readonly PluginSidebarThread[],
  now: number,
): ActiveSectionOrder {
  const entries = new Map<string, ActiveSectionOrderEntry>();
  const backgroundSince = new Map<string, number>();
  const entrants: PluginSidebarThread[] = [];
  let nextSequence = current?.nextSequence ?? 0;

  // Carried forward before any section is decided: the timeout reads this map,
  // so it has to hold this tick's answer for every thread being placed.
  for (const thread of threads) {
    if (!isBackgroundOnlyWork(thread)) continue;
    const carried = current?.backgroundSince.get(thread.id);
    // A remount has no carried value and no way to ask when the job started.
    // `updatedAt` is the closest durable proxy — for a job that has been quiet
    // for hours it is hours old, which is exactly the case this expires, and
    // for one that just started it is ~now. Clamped so a clock skew into the
    // future cannot park a thread in Waiting forever.
    backgroundSince.set(thread.id, carried ?? Math.min(now, thread.updatedAt));
  }

  const sectionFor = (thread: PluginSidebarThread) =>
    activeSectionFor(thread, { now, backgroundSince: backgroundSince.get(thread.id) ?? null });

  for (const thread of threads) {
    const section = sectionFor(thread);
    const existing = current?.entries.get(thread.id);
    if (existing?.section === section) entries.set(thread.id, existing);
    else entrants.push(thread);
  }

  entrants.sort(compareInitialEntrance);
  for (const thread of entrants) {
    entries.set(thread.id, {
      section: sectionFor(thread),
      sequence: nextSequence++,
    });
  }

  return { entries, nextSequence, backgroundSince };
}

/** Split visible active threads and retain their mounted entrance order. */
export function partitionActiveSections(
  threads: readonly PluginSidebarThread[],
  order: ActiveSectionOrder,
  now: number,
): {
  nextAction: PluginSidebarThread[];
  waiting: PluginSidebarThread[];
} {
  const nextAction: PluginSidebarThread[] = [];
  const waiting: PluginSidebarThread[] = [];
  for (const thread of threads) {
    // Same clock and same map the order was reconciled against, so a thread
    // cannot be placed in one section and ordered as if it were in the other.
    const section = activeSectionFor(thread, {
      now,
      backgroundSince: order.backgroundSince.get(thread.id) ?? null,
    });
    (section === "next-action" ? nextAction : waiting).push(thread);
  }
  const byEntrance = (left: PluginSidebarThread, right: PluginSidebarThread) =>
    (order.entries.get(left.id)?.sequence ?? Number.MAX_SAFE_INTEGER) -
      (order.entries.get(right.id)?.sequence ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id);
  nextAction.sort(byEntrance);
  waiting.sort(byEntrance);
  return { nextAction, waiting };
}

export function threadDisplayTitle(thread: PluginSidebarThread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  return fallback ? fallback : "Untitled thread";
}

/** Substring match on the visible title only, preserving the incoming order. */
export function searchThreadsByTitle(
  threads: readonly PluginSidebarThread[],
  query: string,
): PluginSidebarThread[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...threads];
  return threads.filter((thread) => threadDisplayTitle(thread).toLowerCase().includes(normalized));
}

export interface ProjectScope {
  /** Project id, or null for "all projects". */
  id: string | null;
  name: string;
}

/** Threads in the chosen scope; every thread when the scope is null. */
export function filterByProject(
  threads: readonly PluginSidebarThread[],
  projectId: string | null,
): PluginSidebarThread[] {
  if (projectId === null) return [...threads];
  return threads.filter((thread) => thread.projectId === projectId);
}

/**
 * Archived threads never belong in the inbox — except the ones this plugin
 * parked, which it archives itself.
 *
 * Settling a thread archives it in bb, so leaving the flag alone to decide
 * visibility would empty the settled shelf the instant anything landed on it.
 * A parked row is the plugin saying "I put it there", and that outranks the
 * archive it set.
 */
export function visibleInboxThreads(
  threads: readonly PluginSidebarThread[],
  parkedThreadIds: ReadonlySet<string>,
): PluginSidebarThread[] {
  return threads.filter((thread) => !thread.isArchived || parkedThreadIds.has(thread.id));
}

/** Pinned first (they are the user's own ordering), then the static sort. */
export function partitionPinned(threads: readonly PluginSidebarThread[]): {
  pinned: PluginSidebarThread[];
  inbox: PluginSidebarThread[];
} {
  const pinned: PluginSidebarThread[] = [];
  const inbox: PluginSidebarThread[] = [];
  for (const thread of threads) {
    (thread.isPinned ? pinned : inbox).push(thread);
  }
  return { pinned, inbox };
}

/**
 * Child threads leave the flat list and live in their parent's header chip
 * instead — a flat inbox has nowhere to nest them.
 *
 * A child is only hidden when its parent is actually on screen. An orphan
 * (parent archived, deleted, or filtered out by the project scope) stays in
 * the list, because hiding it would make it unreachable everywhere.
 */
export function hideChildrenOfVisibleParents(
  threads: readonly PluginSidebarThread[],
): PluginSidebarThread[] {
  const visibleIds = new Set(threads.map((thread) => thread.id));
  return threads.filter(
    (thread) => thread.parentThreadId === null || !visibleIds.has(thread.parentThreadId),
  );
}

/**
 * The parent of one thread, or null when the thread is a root, when the id is
 * unknown, or when the parent row is gone (deleted). The parent may be
 * archived or in another project: the flat list hides those, but the child
 * still needs a way back to them.
 */
export function parentOf(
  threads: readonly PluginSidebarThread[],
  threadId: string,
): PluginSidebarThread | null {
  const thread = threads.find((candidate) => candidate.id === threadId);
  const parentThreadId = thread?.parentThreadId;
  if (!parentThreadId) return null;
  return threads.find((candidate) => candidate.id === parentThreadId) ?? null;
}

/** The children of one thread, oldest first (the order they were spawned). */
export function childrenOf(
  threads: readonly PluginSidebarThread[],
  parentThreadId: string,
): PluginSidebarThread[] {
  return threads
    .filter((thread) => thread.parentThreadId === parentThreadId)
    .sort((left, right) => left.createdAt - right.createdAt);
}
