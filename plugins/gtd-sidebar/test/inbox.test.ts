import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import {
  activeSectionFor,
  BACKGROUND_WAIT_MAX_MS,
  childrenOf,
  filterByProject,
  hideChildrenOfVisibleParents,
  parentOf,
  partitionActiveSections,
  partitionPinned,
  reconcileActiveSectionOrder,
  searchThreadsByTitle,
  sortByCreatedAtDescending,
  threadDisplayTitle,
  visibleInboxThreads,
} from "../lib/inbox.ts";

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

describe("sortByCreatedAtDescending", () => {
  it("puts the newest thread first", () => {
    const ordered = sortByCreatedAtDescending([
      thread({ id: "a", createdAt: 1 }),
      thread({ id: "b", createdAt: 3 }),
      thread({ id: "c", createdAt: 2 }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.id),
      ["b", "c", "a"],
    );
  });

  // This static sort still owns pinned and settled shelves. Activity must not
  // move a row inside either one.
  it("ignores activity and update time", () => {
    const before = [
      thread({ id: "a", createdAt: 2, updatedAt: 1 }),
      thread({ id: "b", createdAt: 1, updatedAt: 999, indicator: "runtime" }),
    ];
    assert.deepEqual(
      sortByCreatedAtDescending(before).map((t) => t.id),
      ["a", "b"],
    );
  });

  it("breaks ties on id so the order is stable", () => {
    const ordered = sortByCreatedAtDescending([
      thread({ id: "b", createdAt: 5 }),
      thread({ id: "a", createdAt: 5 }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.id),
      ["a", "b"],
    );
  });

  it("does not mutate its input", () => {
    const input = [thread({ id: "a", createdAt: 1 }), thread({ id: "b", createdAt: 2 })];
    sortByCreatedAtDescending(input);
    assert.deepEqual(
      input.map((t) => t.id),
      ["a", "b"],
    );
  });
});

/** Far enough ahead of every fixture timestamp to read as "just started". */
const NOW = 1_000_000;

/** Only a background command is live: no pending interaction, no agent turn. */
const backgroundOnly = {
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 1, planMode: 0, goals: 0 },
  indicator: "background-command",
} satisfies Partial<PluginSidebarThread>;

describe("active sections", () => {
  it("puts quiet work with the user and live work in waiting", () => {
    assert.equal(activeSectionFor(thread()), "next-action");
    assert.equal(activeSectionFor(thread({ indicator: "runtime" })), "waiting");
    assert.equal(
      activeSectionFor(
        thread({
          activity: {
            workflows: 0,
            backgroundAgents: 0,
            backgroundCommands: 1,
            planMode: 0,
            goals: 0,
          },
        }),
      ),
      "waiting",
    );
  });

  it("puts a pending interaction in next action even with live work", () => {
    assert.equal(
      activeSectionFor(
        thread({
          hasPendingInteraction: true,
          activity: {
            workflows: 1,
            backgroundAgents: 0,
            backgroundCommands: 0,
            planMode: 0,
            goals: 0,
          },
        }),
      ),
      "next-action",
    );
  });

  it("expires background-only work after an hour, and not a tick before", () => {
    const started = NOW - BACKGROUND_WAIT_MAX_MS;
    const running = thread({ ...backgroundOnly, updatedAt: started });
    // The list is what the user works from. A job that has run for an hour has
    // stopped answering "the agent has this", whatever it is still doing.
    assert.equal(
      activeSectionFor(running, { now: NOW, backgroundSince: started + 1 }),
      "waiting",
    );
    assert.equal(activeSectionFor(running, { now: NOW, backgroundSince: started }), "next-action");
  });

  it("keeps a live agent turn in waiting however long it runs", () => {
    const longAgo = NOW - BACKGROUND_WAIT_MAX_MS * 10;
    assert.equal(
      activeSectionFor(thread({ indicator: "runtime", updatedAt: longAgo }), {
        now: NOW,
        backgroundSince: longAgo,
      }),
      "waiting",
    );
  });

  it("moves a thread out of waiting once its background job passes the hour", () => {
    const started = NOW - BACKGROUND_WAIT_MAX_MS - 1;
    const threads = [thread({ id: "a", ...backgroundOnly, updatedAt: started })];
    // First seen while the job was fresh, so it opens in waiting...
    const fresh = reconcileActiveSectionOrder(null, threads, started);
    assert.deepEqual(
      partitionActiveSections(threads, fresh, started).waiting.map((c) => c.id),
      ["a"],
    );
    // ...and the same anchor carries forward, so the hour actually elapses.
    const expired = reconcileActiveSectionOrder(fresh, threads, NOW);
    assert.deepEqual(
      partitionActiveSections(threads, expired, NOW).nextAction.map((c) => c.id),
      ["a"],
    );
  });

  it("does not flap back to waiting while the job keeps running", () => {
    const started = NOW - BACKGROUND_WAIT_MAX_MS - 1;
    const threads = [thread({ id: "a", ...backgroundOnly, updatedAt: started })];
    let order = reconcileActiveSectionOrder(null, threads, started);
    for (const now of [NOW, NOW + 60_000, NOW + 120_000]) {
      order = reconcileActiveSectionOrder(order, threads, now);
      assert.deepEqual(
        partitionActiveSections(threads, order, now).nextAction.map((c) => c.id),
        ["a"],
      );
    }
  });

  it("starts the hour over when an agent turn interrupts the background job", () => {
    const started = NOW - BACKGROUND_WAIT_MAX_MS - 1;
    const running = [thread({ id: "a", ...backgroundOnly, updatedAt: started })];
    const expired = reconcileActiveSectionOrder(null, running, NOW);
    assert.equal(expired.backgroundSince.get("a"), started);

    // A turn drops the anchor: the thread is the agent's again, not stale.
    const turn = [thread({ id: "a", ...backgroundOnly, indicator: "runtime", updatedAt: NOW })];
    const during = reconcileActiveSectionOrder(expired, turn, NOW);
    assert.equal(during.backgroundSince.has("a"), false);
    assert.deepEqual(
      partitionActiveSections(turn, during, NOW).waiting.map((c) => c.id),
      ["a"],
    );

    // A turn touches the thread, so when it ends the job is background-only
    // again against a fresh `updatedAt` — re-anchored to now, and the thread
    // is back in waiting for another hour rather than expiring instantly.
    const resumed = [thread({ id: "a", ...backgroundOnly, updatedAt: NOW })];
    const after = reconcileActiveSectionOrder(during, resumed, NOW);
    assert.equal(after.backgroundSince.get("a"), NOW);
    assert.deepEqual(
      partitionActiveSections(resumed, after, NOW).waiting.map((c) => c.id),
      ["a"],
    );
  });

  it("seeds a remount from updatedAt so a quiet job does not restart the hour", () => {
    const stale = NOW - BACKGROUND_WAIT_MAX_MS - 1;
    const threads = [thread({ id: "a", ...backgroundOnly, updatedAt: stale })];
    // No carried state, as after a panel remount. updatedAt is the only durable
    // hint about when the job started, and here it says "over an hour ago".
    const remounted = reconcileActiveSectionOrder(null, threads, NOW);
    assert.deepEqual(
      partitionActiveSections(threads, remounted, NOW).nextAction.map((c) => c.id),
      ["a"],
    );
  });

  it("clamps a future updatedAt so clock skew cannot pin a thread in waiting", () => {
    const threads = [thread({ id: "a", ...backgroundOnly, updatedAt: NOW + 86_400_000 })];
    const order = reconcileActiveSectionOrder(null, threads, NOW);
    assert.equal(order.backgroundSince.get("a"), NOW);
  });

  it("drops the anchor when the background job finishes", () => {
    const threads = [thread({ id: "a", ...backgroundOnly, updatedAt: NOW })];
    const busy = reconcileActiveSectionOrder(null, threads, NOW);
    assert.equal(busy.backgroundSince.get("a"), NOW);
    const quiet = [thread({ id: "a", updatedAt: NOW })];
    const done = reconcileActiveSectionOrder(busy, quiet, NOW);
    assert.equal(done.backgroundSince.has("a"), false);
  });

  it("seeds oldest first from update time, creation time, then id", () => {
    const threads = [
      thread({ id: "d", updatedAt: 30, createdAt: 1 }),
      thread({ id: "c", updatedAt: 20, createdAt: 20 }),
      thread({ id: "b", updatedAt: 20, createdAt: 10 }),
      thread({ id: "a", updatedAt: 20, createdAt: 10 }),
    ];
    const order = reconcileActiveSectionOrder(null, threads, NOW);
    const sections = partitionActiveSections(threads, order, NOW);
    assert.deepEqual(
      sections.nextAction.map((candidate) => candidate.id),
      ["a", "b", "c", "d"],
    );
  });

  it("does not move a thread for metadata updates within one section", () => {
    const initial = [thread({ id: "a", updatedAt: 10 }), thread({ id: "b", updatedAt: 20 })];
    const first = reconcileActiveSectionOrder(null, initial, NOW);
    const updated = [thread({ id: "a", updatedAt: 999, title: "Renamed" }), initial[1]!];
    const next = reconcileActiveSectionOrder(first, updated, NOW);
    assert.deepEqual(
      partitionActiveSections(updated, next, NOW).nextAction.map((candidate) => candidate.id),
      ["a", "b"],
    );
  });

  it("puts a section entrant at the bottom", () => {
    const initial = [
      thread({ id: "a", updatedAt: 10 }),
      thread({ id: "b", updatedAt: 20, indicator: "runtime" }),
    ];
    const first = reconcileActiveSectionOrder(null, initial, NOW);
    const transitioned = [thread({ id: "a", updatedAt: 30, indicator: "runtime" }), initial[1]!];
    const next = reconcileActiveSectionOrder(first, transitioned, NOW);
    assert.deepEqual(
      partitionActiveSections(transitioned, next, NOW).waiting.map((candidate) => candidate.id),
      ["b", "a"],
    );
  });

  it("treats a return from pinning or parking as a new entrance", () => {
    const initial = [thread({ id: "a", updatedAt: 10 }), thread({ id: "b", updatedAt: 20 })];
    const first = reconcileActiveSectionOrder(null, initial, NOW);
    const withoutA = reconcileActiveSectionOrder(first, [initial[1]!], NOW);
    const returned = reconcileActiveSectionOrder(withoutA, initial, NOW);
    assert.deepEqual(
      partitionActiveSections(initial, returned, NOW).nextAction.map((candidate) => candidate.id),
      ["b", "a"],
    );
  });

  it("keeps order when presentation filters hide a tracked thread", () => {
    const threads = [
      thread({ id: "a", updatedAt: 10, projectId: "p1" }),
      thread({ id: "b", updatedAt: 20, projectId: "p2" }),
    ];
    const first = reconcileActiveSectionOrder(null, threads, NOW);
    assert.deepEqual(
      partitionActiveSections(filterByProject(threads, "p2"), first, NOW).nextAction.map(
        (candidate) => candidate.id,
      ),
      ["b"],
    );
    const next = reconcileActiveSectionOrder(first, threads, NOW);
    assert.deepEqual(
      partitionActiveSections(threads, next, NOW).nextAction.map((candidate) => candidate.id),
      ["a", "b"],
    );
  });
});

describe("threadDisplayTitle", () => {
  it("prefers the title, then the fallback, then a placeholder", () => {
    assert.equal(threadDisplayTitle(thread({ title: "Real" })), "Real");
    assert.equal(
      threadDisplayTitle(thread({ title: null, titleFallback: "Fallback" })),
      "Fallback",
    );
    assert.equal(
      threadDisplayTitle(thread({ title: null, titleFallback: null })),
      "Untitled thread",
    );
  });

  it("treats a whitespace-only title as absent", () => {
    assert.equal(
      threadDisplayTitle(thread({ title: "   ", titleFallback: "Fallback" })),
      "Fallback",
    );
  });
});

describe("searchThreadsByTitle", () => {
  it("matches case-insensitively on the visible title", () => {
    const threads = [
      thread({ id: "a", title: "Sidebar work" }),
      thread({ id: "b", title: "Something else" }),
      thread({ id: "c", title: null, titleFallback: "sidebar fallback" }),
    ];
    assert.deepEqual(
      searchThreadsByTitle(threads, "SIDEBAR").map((t) => t.id),
      ["a", "c"],
    );
  });

  it("returns everything for a blank query", () => {
    const threads = [thread({ id: "a" }), thread({ id: "b" })];
    assert.equal(searchThreadsByTitle(threads, "   ").length, 2);
  });
});

describe("filtering", () => {
  it("scopes to one project, or to all", () => {
    const threads = [thread({ id: "a", projectId: "p1" }), thread({ id: "b", projectId: "p2" })];
    assert.deepEqual(
      filterByProject(threads, "p1").map((t) => t.id),
      ["a"],
    );
    assert.equal(filterByProject(threads, null).length, 2);
  });

  it("drops archived threads", () => {
    const threads = [thread({ id: "a" }), thread({ id: "b", isArchived: true })];
    assert.deepEqual(
      visibleInboxThreads(threads, new Set()).map((t) => t.id),
      ["a"],
    );
  });

  // Settling archives the thread in bb, so the archive flag alone would empty
  // the settled shelf the moment anything landed on it.
  it("keeps an archived thread the plugin parked", () => {
    const threads = [thread({ id: "a", isArchived: true }), thread({ id: "b", isArchived: true })];
    assert.deepEqual(
      visibleInboxThreads(threads, new Set(["a"])).map((t) => t.id),
      ["a"],
    );
  });

  it("splits pinned from the rest, keeping order", () => {
    const { pinned, inbox } = partitionPinned([
      thread({ id: "a" }),
      thread({ id: "b", isPinned: true }),
      thread({ id: "c" }),
    ]);
    assert.deepEqual(
      pinned.map((t) => t.id),
      ["b"],
    );
    assert.deepEqual(
      inbox.map((t) => t.id),
      ["a", "c"],
    );
  });
});

describe("child threads", () => {
  it("hides a child whose parent is on screen", () => {
    const visible = hideChildrenOfVisibleParents([
      thread({ id: "parent" }),
      thread({ id: "child", parentThreadId: "parent" }),
    ]);
    assert.deepEqual(
      visible.map((t) => t.id),
      ["parent"],
    );
  });

  // An orphan must stay visible: hidden here AND absent from any header chip
  // would make it unreachable everywhere.
  it("keeps a child whose parent is not on screen", () => {
    const visible = hideChildrenOfVisibleParents([
      thread({ id: "child", parentThreadId: "archived-parent" }),
    ]);
    assert.deepEqual(
      visible.map((t) => t.id),
      ["child"],
    );
  });

  it("lists a thread's children oldest first", () => {
    const children = childrenOf(
      [
        thread({ id: "parent" }),
        thread({ id: "b", parentThreadId: "parent", createdAt: 20 }),
        thread({ id: "a", parentThreadId: "parent", createdAt: 10 }),
        thread({ id: "other", parentThreadId: "elsewhere" }),
      ],
      "parent",
    );
    assert.deepEqual(
      children.map((t) => t.id),
      ["a", "b"],
    );
  });
});

describe("parentOf", () => {
  // The list hides an archived parent, but the child's header must still get
  // it back — otherwise the child is a dead end.
  it("finds a parent the inbox filters out", () => {
    const parent = parentOf(
      [
        thread({ id: "parent", isArchived: true, projectId: "other" }),
        thread({ id: "child", parentThreadId: "parent" }),
      ],
      "child",
    );
    assert.equal(parent?.id, "parent");
  });

  it("returns null for a root thread", () => {
    assert.equal(parentOf([thread({ id: "root" })], "root"), null);
  });

  it("returns null when the parent row is gone", () => {
    const threads = [thread({ id: "child", parentThreadId: "deleted" })];
    assert.equal(parentOf(threads, "child"), null);
  });
});
