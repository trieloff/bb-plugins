import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "bun:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

if (process.env.GTD_BACKGROUND_AGES_TEST_CHILD !== "1") {
  it("useBackgroundCommandAges passes the isolated React suite", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout=30000", fileURLToPath(import.meta.url)],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, GTD_BACKGROUND_AGES_TEST_CHILD: "1" },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
    JSDOM: new (
      html: string,
      options: { url: string },
    ) => {
      window: Window & typeof globalThis;
    };
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  for (const name of Object.getOwnPropertyNames(dom.window)) {
    if (name in globalThis) continue;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: Reflect.get(dom.window, name),
      writable: true,
    });
  }
  const { act, cleanup } = await import("@testing-library/react");
  const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  installTestPluginRuntime();
  const { createElement } = await import("react");
  const { useBackgroundCommandAges } = await import("../hooks/use-background-command-ages.ts");
  const { activeSectionFor } = await import("../lib/inbox.ts");

  const MINUTE = 60_000;
  const IDLE = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 };

  function thread(
    id: string,
    activity: Partial<PluginSidebarThread["activity"]> = {},
    overrides: Partial<PluginSidebarThread> = {},
  ): PluginSidebarThread {
    return {
      id,
      hasPendingInteraction: false,
      indicator: "background-command",
      activity: { ...IDLE, ...activity },
      ...overrides,
    } as PluginSidebarThread;
  }

  /** Each thread's section, as the hook hands the threads to the shelves. */
  function Probe({ threads }: { threads: readonly PluginSidebarThread[] }) {
    const seen = useBackgroundCommandAges(threads);
    return createElement(
      "output",
      null,
      seen.map((entry) => `${entry.id}=${activeSectionFor(entry)}`).join(" "),
    );
  }

  /** bb's timeline, answering with commands that started this long ago. */
  function timelineFake(ages: Record<string, number[] | Error>) {
    return async ({ threadId }: { threadId: string }) => {
      const answer = ages[threadId];
      if (answer instanceof Error) throw answer;
      return {
        activeBackgroundCommands: (answer ?? []).map((minutes) => ({
          startedAt: Date.now() - minutes * MINUTE,
        })),
      };
    };
  }

  function mount(threads: readonly PluginSidebarThread[], ages: Record<string, number[] | Error>) {
    return renderSlot(
      { component: Probe },
      { threads },
      { sdk: { threads: { timeline: timelineFake(ages) } } as never },
    );
  }

  function sections(slot: { container: HTMLElement }): string {
    return slot.container.querySelector("output")?.textContent ?? "";
  }

  function timelineReads(slot: {
    inspection: { sdkCalls: { method: string; args: unknown[] }[] };
  }) {
    return slot.inspection.sdkCalls
      .filter((call) => call.method.endsWith("timeline"))
      .map((call) => (call.args[0] as { threadId: string }).threadId);
  }

  afterEach(() => cleanup());

  describe("useBackgroundCommandAges", () => {
    it("moves a thread whose commands all outlived the wait to Next Action", async () => {
      const slot = mount([thread("old", { backgroundCommands: 2 })], { old: [45, 31] });
      await act(async () => {});
      assert.equal(sections(slot), "old=next-action");
    });

    it("keeps a thread in Waiting while its newest command is young", async () => {
      // A dev server from this morning beside a test run from five minutes ago.
      const slot = mount([thread("mixed", { backgroundCommands: 2 })], { mixed: [300, 5] });
      await act(async () => {});
      assert.equal(sections(slot), "mixed=waiting");
    });

    it("reads only threads whose sole live work is background commands", async () => {
      const slot = mount(
        [
          thread("idle", { backgroundCommands: 1 }),
          thread("turn", { backgroundCommands: 1 }, { indicator: "runtime" }),
          thread("agent", { backgroundCommands: 1, backgroundAgents: 1 }),
          thread("quiet"),
        ],
        { idle: [40], turn: [40], agent: [40] },
      );
      await act(async () => {});
      assert.deepEqual(timelineReads(slot), ["idle"]);
      assert.equal(sections(slot), "idle=next-action turn=waiting agent=waiting quiet=next-action");
    });

    it("reads a thread again only when its command count changes", async () => {
      const slot = mount([thread("t", { backgroundCommands: 2 })], { t: [40, 35] });
      await act(async () => {});
      slot.rerender(createElement(Probe, { threads: [thread("t", { backgroundCommands: 2 })] }));
      await act(async () => {});
      assert.deepEqual(timelineReads(slot), ["t"]);
      slot.rerender(createElement(Probe, { threads: [thread("t", { backgroundCommands: 1 })] }));
      await act(async () => {});
      assert.deepEqual(timelineReads(slot), ["t", "t"]);
    });

    it("keeps a thread working when its commands cannot be read", async () => {
      const slot = mount([thread("t", { backgroundCommands: 1 })], { t: new Error("offline") });
      await act(async () => {});
      assert.equal(sections(slot), "t=waiting");
    });
  });
}
