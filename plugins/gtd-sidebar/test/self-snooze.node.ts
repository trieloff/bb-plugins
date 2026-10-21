import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { SELF_SNOOZE_SETTLE_MS } from "../lib/self-snooze.ts";

type LifecycleRow = { threadId: string; snoozedUntil: number | null; snoozedAt: number | null };

async function loadSidebar(agentSelfSnooze: boolean) {
  const threads = [
    makeThreadResponse({ id: "agent", parentThreadId: null, latestAttentionAt: 100 }),
    makeThreadResponse({ id: "helper", parentThreadId: "agent", latestAttentionAt: 100 }),
  ];
  const { bb, harness } = createFakePluginHost({
    pluginId: "gtd-sidebar",
    settings: { agentSelfSnooze },
    // The manifest's skill: a `configure` naming an unknown one is rejected whole.
    agentSkillIds: ["configure-gtd-naming"],
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
  // The setting is mirrored for the synchronous configure; let it land.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return harness;
}

async function rows(harness: Awaited<ReturnType<typeof loadSidebar>>): Promise<LifecycleRow[]> {
  return ((await harness.behavior.callRpc("listLifecycle", {})) as { rows: LifecycleRow[] }).rows;
}

const inThread = { threadId: "agent", projectId: "project" };

describe("agent self-snooze", () => {
  it("is offered only with the setting on, keeping the plugin's skill either way", async () => {
    for (const enabled of [false, true]) {
      const harness = await loadSidebar(enabled);
      try {
        const config = await harness.behavior.resolveAgentConfiguration(
          makePluginAgentConfigurationContext(),
        );
        assert.deepEqual(
          config.tools.map((tool) => tool.name),
          enabled ? ["snooze_this_thread"] : [],
        );
        assert.deepEqual(config.skills, ["configure-gtd-naming"]);
        assert.equal(config.instructions?.includes("snooze_this_thread") ?? false, enabled);
      } finally {
        await harness.lifecycle.dispose();
      }
    }
  });

  it("refuses with the setting off", async () => {
    const harness = await loadSidebar(false);
    try {
      const result = await harness.behavior.callAgentTool(
        "snooze_this_thread",
        { minutes: 30 },
        inThread,
      );
      assert.equal(typeof result === "object" && result.isError, true);
      assert.deepEqual(await rows(harness), []);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("snoozes the thread and its subthreads, restarting the snooze when the turn ends", async () => {
    const harness = await loadSidebar(true);
    try {
      const before = Date.now();
      const result = await harness.behavior.callAgentTool(
        "snooze_this_thread",
        { minutes: 90 },
        inThread,
      );
      assert.equal(typeof result, "string");
      assert.match(result as string, /^Snoozed until /u);
      const snoozed = await rows(harness);
      assert.deepEqual(snoozed.map((row) => row.threadId).sort(), ["agent", "helper"]);
      for (const row of snoozed) {
        assert.ok(row.snoozedUntil! >= before + 90 * 60_000);
        assert.ok(row.snoozedAt! >= before);
      }

      // The turn ends after the snooze: its last message must not wake it.
      const lastMessageAt = Date.now() + 10_000;
      await harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: "agent", latestAttentionAt: lastMessageAt }),
        lastAssistantText: "Waiting for CI.",
      });
      for (const row of await rows(harness)) {
        assert.equal(row.snoozedAt, lastMessageAt + SELF_SNOOZE_SETTLE_MS);
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("picks the adaptive wake time when given none, and refuses a bad one", async () => {
    const harness = await loadSidebar(true);
    try {
      const adaptive = await harness.behavior.callAgentTool("snooze_this_thread", {}, inThread);
      assert.equal(typeof adaptive, "string");
      const [row] = await rows(harness);
      assert.ok(row!.snoozedUntil! > Date.now());

      const bad = await harness.behavior.callAgentTool(
        "snooze_this_thread",
        { until: "2020-01-01T00:00:00Z" },
        inThread,
      );
      assert.equal(typeof bad === "object" && bad.isError, true);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("snoozes the calling thread from `bb gtd-sidebar snooze`, sharing the tool's rules", async () => {
    const harness = await loadSidebar(true);
    try {
      const before = Date.now();
      const result = await harness.behavior.runCli(["snooze", "--minutes", "10"], inThread);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /^Snoozed until /u);
      for (const row of await rows(harness)) {
        assert.ok(row.snoozedUntil! >= before + 10 * 60_000);
      }
      const bad = await harness.behavior.runCli(["snooze", "--minutes", "0"], inThread);
      assert.notEqual(bad.exitCode, 0);
    } finally {
      await harness.lifecycle.dispose();
    }
    const off = await loadSidebar(false);
    try {
      const refused = await off.behavior.runCli(["snooze", "--minutes", "10"], inThread);
      assert.notEqual(refused.exitCode, 0);
      assert.match(refused.stderr, /turned off/u);
    } finally {
      await off.lifecycle.dispose();
    }
  });
});
