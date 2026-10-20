import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import {
  BACKGROUND_COMMAND_WAIT_MS,
  backgroundCommandsOutlived,
  newestBackgroundCommandStart,
  setAsideBackgroundCommands,
  waitsOnlyOnBackgroundCommands,
} from "../lib/background-work.ts";
import { activeSectionFor } from "../lib/inbox.ts";
import { canPark, isThreadWorking } from "../lib/lifecycle.ts";

const IDLE_ACTIVITY = {
  workflows: 0,
  backgroundAgents: 0,
  backgroundCommands: 0,
  planMode: 0,
  goals: 0,
};

function thread(
  activity: Partial<PluginSidebarThread["activity"]> = {},
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id: "t",
    hasPendingInteraction: false,
    indicator: "background-command",
    activity: { ...IDLE_ACTIVITY, ...activity },
    ...overrides,
  } as PluginSidebarThread;
}

describe("waitsOnlyOnBackgroundCommands", () => {
  it("holds for a quiet thread with a background command", () => {
    assert.equal(waitsOnlyOnBackgroundCommands(thread({ backgroundCommands: 2 })), true);
  });

  it("does not hold without a command, or beside any other live work", () => {
    assert.equal(waitsOnlyOnBackgroundCommands(thread()), false);
    for (const other of ["workflows", "backgroundAgents", "planMode", "goals"] as const) {
      assert.equal(
        waitsOnlyOnBackgroundCommands(thread({ backgroundCommands: 1, [other]: 1 })),
        false,
        other,
      );
    }
    for (const indicator of ["runtime", "working-draft"] as const) {
      assert.equal(
        waitsOnlyOnBackgroundCommands(thread({ backgroundCommands: 1 }, { indicator })),
        false,
        indicator,
      );
    }
  });

  it("does not hold for a thread that already needs the user", () => {
    assert.equal(
      waitsOnlyOnBackgroundCommands(
        thread({ backgroundCommands: 1 }, { hasPendingInteraction: true }),
      ),
      false,
    );
  });
});

describe("newestBackgroundCommandStart", () => {
  it("picks the latest start, and null with no commands", () => {
    assert.equal(
      newestBackgroundCommandStart([{ startedAt: 30 }, { startedAt: 90 }, { startedAt: 60 }]),
      90,
    );
    assert.equal(newestBackgroundCommandStart([]), null);
  });
});

describe("backgroundCommandsOutlived", () => {
  const start = 1_000_000;

  it("turns at exactly the wait", () => {
    assert.equal(backgroundCommandsOutlived(start, start + BACKGROUND_COMMAND_WAIT_MS - 1), false);
    assert.equal(backgroundCommandsOutlived(start, start + BACKGROUND_COMMAND_WAIT_MS), true);
  });

  it("never turns for an unknown start", () => {
    assert.equal(backgroundCommandsOutlived(null, start + 10 * BACKGROUND_COMMAND_WAIT_MS), false);
  });
});

describe("setAsideBackgroundCommands", () => {
  it("moves a thread from Waiting to Next Action and lets it park", () => {
    const running = thread({ backgroundCommands: 1 });
    assert.equal(activeSectionFor(running), "waiting");
    const setAside = setAsideBackgroundCommands(running);
    assert.equal(isThreadWorking(setAside), false);
    assert.equal(activeSectionFor(setAside), "next-action");
    assert.equal(
      canPark({
        hasPendingInteraction: false,
        isWorking: isThreadWorking(setAside),
        latestAttentionAt: 0,
      }),
      true,
    );
  });

  it("leaves the rest of the thread as it was", () => {
    const running = thread({ backgroundCommands: 3 });
    const setAside = setAsideBackgroundCommands(running);
    assert.deepEqual({ ...setAside, activity: running.activity }, running);
    assert.equal(running.activity.backgroundCommands, 3);
  });
});
