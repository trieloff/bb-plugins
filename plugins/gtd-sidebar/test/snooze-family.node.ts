import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { type StoredLifecycleRow } from "../server.ts";

describe("family snooze RPC", () => {
  it("shares the adaptive ladder across a parent and its child", async () => {
    const threads = [
      makeThreadResponse({ id: "root", parentThreadId: null, latestAttentionAt: 100 }),
      makeThreadResponse({ id: "child", parentThreadId: "root", latestAttentionAt: 100 }),
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "gtd-sidebar",
      sdk: {
        subscribe: () => () => {},
        threads: {
          get: async ({ threadId }) => threads.find((thread) => thread.id === threadId)!,
          list: async (args) =>
            threads.filter((thread) => thread.parentThreadId === args?.parentThreadId),
        },
      },
    });
    await plugin(bb);
    try {
      const first = (await harness.behavior.callRpc("quickSnooze", {
        threadId: "root",
        projectId: "project",
      })) as { ladderStep: number; ladderDays: number; snoozedUntil: number };
      assert.equal(first.ladderStep, 0);
      assert.equal(first.ladderDays, 1);
      const firstState = (await harness.behavior.callRpc("listLifecycle", {})) as {
        rows: StoredLifecycleRow[];
        backoff: Array<{ threadId: string; ladderStep: number }>;
      };
      assert.deepEqual(firstState.rows.map((row) => row.threadId).sort(), ["child", "root"]);
      assert.ok(firstState.rows.every((row) => row.snoozedUntil === first.snoozedUntil));
      assert.deepEqual(firstState.backoff.map((row) => row.threadId).sort(), ["child", "root"]);
      await harness.behavior.callRpc("unsnooze", { threadId: "root" });
      const second = (await harness.behavior.callRpc("quickSnooze", {
        threadId: "root",
        projectId: "project",
      })) as { ladderStep: number; ladderDays: number };
      assert.equal(second.ladderStep, 1);
      assert.equal(second.ladderDays, 2);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("stores one wake time for a parent and its descendants, then wakes them together", async () => {
    const threads = [
      makeThreadResponse({ id: "root", parentThreadId: null }),
      makeThreadResponse({ id: "child", parentThreadId: "root" }),
      makeThreadResponse({ id: "grandchild", parentThreadId: "child" }),
      makeThreadResponse({ id: "fork", parentThreadId: "root", originKind: "fork" }),
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "gtd-sidebar",
      sdk: {
        subscribe: () => () => {},
        threads: {
          list: async (args) =>
            threads
              .filter((thread) => thread.parentThreadId === args?.parentThreadId)
              .slice(args?.offset ?? 0, (args?.offset ?? 0) + (args?.limit ?? 200)),
        },
      },
    });
    await plugin(bb);
    try {
      const wakeAt = Date.now() + 86_400_000;
      assert.deepEqual(
        await harness.behavior.callRpc("snooze", { threadId: "root", snoozedUntil: wakeAt }),
        { ok: true },
      );
      const { rows } = (await harness.behavior.callRpc("listLifecycle", {})) as {
        rows: StoredLifecycleRow[];
      };
      assert.deepEqual(rows.map((row) => row.threadId).sort(), ["child", "grandchild", "root"]);
      assert.ok(rows.every((row) => row.snoozedUntil === wakeAt));
      assert.equal(new Set(rows.map((row) => row.snoozedAt)).size, 1);
      assert.deepEqual(await harness.behavior.callRpc("unsnooze", { threadId: "root" }), {
        ok: true,
      });
      const afterWake = (await harness.behavior.callRpc("listLifecycle", {})) as {
        rows: StoredLifecycleRow[];
      };
      assert.deepEqual(afterWake.rows, []);
      assert.equal(harness.inspection.sdk.callsTo("threads.update").length, 0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
