// Ported from bb's concurrency-limit plugin (plugins/concurrency-limit/
// server.test.ts at desktop-v0.46.1), so the copy is held to the original's
// behaviour. Differences are marked where bb-kit's CLI or the pinned-thread
// exemption change an expectation.
import type {
  BbPluginApi,
  MessageDispatchHookContext,
  PluginDispatchAttemptKind,
} from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "bun:test";
import plugin from "./server.ts";

type RunningThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["listRunning"]>>[number];
type HostResponse = ReturnType<typeof makeHostResponse>;
type SdkSubscription = Parameters<BbPluginApi["sdk"]["subscribe"]>[0];
type HostChangedSubscription = Extract<SdkSubscription, { event: "host:changed" }>;

function isHostChangedSubscription(
  subscription: SdkSubscription,
): subscription is HostChangedSubscription {
  return subscription.event === "host:changed";
}

/** Vitest's `vi.waitFor`, which bun:test lacks: retry an assertion until it holds. */
async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

const PLUGIN_ID = "thread-limit";
function hostRecord(
  id: string,
  status: "connected" | "disconnected" = "connected",
  name = id,
): HostResponse {
  return makeHostResponse({ id, name, status });
}

function running(overrides: Partial<RunningThread> = {}): RunningThread {
  return { id: "thr_running", hostId: "host-a", ...overrides };
}

interface GateContextOverrides {
  hostId?: string | null;
  hostName?: string;
  thread?: Partial<MessageDispatchHookContext["thread"]>;
  attempt?: PluginDispatchAttemptKind;
}

function dispatchContext(overrides: GateContextOverrides = {}) {
  const hostId = overrides.hostId === undefined ? "host-a" : overrides.hostId;
  return makeMessageDispatchHookContext({
    thread: {
      id: "thr_1",
      status: "pending",
      ...overrides.thread,
    },
    attempt: overrides.attempt ?? "start-turn",
    host: hostId === null ? null : { id: hostId, name: overrides.hostName ?? hostId },
  });
}

interface SetupOptions {
  configuration?: {
    globalLimit: number | null;
    hostOverrides: Array<{ hostId: string; limit: number }>;
  };
  capacities?: Array<{ hostId: string; availableParallelism: number }>;
  hosts?: HostResponse[] | (() => HostResponse[]);
  running?: RunningThread[];
  detectedParallelism?: number;
  subscribe?: BbPluginApi["sdk"]["subscribe"];
  /** Added for the copy: what each host's `getLoad` answers. */
  hostLoad?: { cpuBusyPercent: number; memoryFreePercent: number | null; loadAverage: number };
}

async function setup(options: SetupOptions = {}) {
  const subscribe: BbPluginApi["sdk"]["subscribe"] = () => () => {};
  const fake = createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: {
      subscribe: options.subscribe ?? subscribe,
      hosts: {
        list: async () =>
          typeof options.hosts === "function" ? options.hosts() : (options.hosts ?? []),
      },
      threads: { listRunning: async () => options.running ?? [] },
    },
    experimental_callHostRpc: (call) =>
      call.method === "getLoad"
        ? (options.hostLoad ?? { cpuBusyPercent: 10, memoryFreePercent: 80, loadAverage: 1 })
        : { availableParallelism: options.detectedParallelism ?? 8 },
  });
  if (options.configuration !== undefined) {
    await fake.bb.storage.kv.set("configuration", options.configuration);
  }
  if (options.capacities !== undefined) {
    await fake.bb.storage.kv.set("host-capacities", options.capacities);
  }
  await plugin(fake.bb);
  const hook = fake.harness.registrations.hooks["message.dispatch"];
  if (hook === null) throw new Error("message.dispatch was not registered");
  return { ...fake, hook };
}

function hostChanges(): {
  emitHostChanges(
    hostId: string,
    changes: Parameters<HostChangedSubscription["callback"]>[0]["changes"],
  ): void;
  subscribe: BbPluginApi["sdk"]["subscribe"];
} {
  let callback: HostChangedSubscription["callback"] | null = null;
  return {
    emitHostChanges(hostId, changes) {
      callback?.({
        type: "changed",
        entity: "host",
        id: hostId,
        changes,
      });
    },
    subscribe(subscription) {
      if (isHostChangedSubscription(subscription)) {
        callback = subscription.callback;
      }
      return () => {
        if (isHostChangedSubscription(subscription)) callback = null;
      };
    },
  };
}

describe("configuration", () => {
  it("uses a custom settings section rather than generic setting descriptors", async () => {
    const { harness } = await setup();

    expect(harness.registrations.settingsDescriptors).toEqual({});
  });

  it("returns each host's detected automatic limit and retained offline capacity", async () => {
    const { harness } = await setup({
      hosts: [
        hostRecord("host-a", "connected", "Laptop"),
        hostRecord("host-b", "disconnected", "Studio"),
      ],
      capacities: [
        { hostId: "host-a", availableParallelism: 8 },
        { hostId: "host-b", availableParallelism: 16 },
      ],
    });

    // The copy adds load limits and each host's load sample to the view.
    await expect(harness.behavior.callRpc("getConfiguration")).resolves.toEqual({
      globalLimit: null,
      hostOverrides: [],
      loadLimits: { cpuBusyPercent: 85, memoryFreePercent: 10 },
      hosts: [
        {
          id: "host-a",
          name: "Laptop",
          status: "connected",
          availableParallelism: 8,
          automaticLimit: 8,
          effectiveLimit: 8,
          override: null,
          load: null,
          overloadedBy: null,
        },
        {
          id: "host-b",
          name: "Studio",
          status: "disconnected",
          availableParallelism: 16,
          automaticLimit: 16,
          effectiveLimit: 16,
          override: null,
          load: null,
          overloadedBy: null,
        },
      ],
    });
  });

  it("rejects invalid and duplicate limits at the RPC boundary", async () => {
    const { harness } = await setup();

    await expect(
      harness.behavior.callRpc("setConfiguration", {
        globalLimit: 1.5,
        hostOverrides: [],
      }),
    ).rejects.toThrow();
    await expect(
      harness.behavior.callRpc("setConfiguration", {
        globalLimit: null,
        hostOverrides: [
          { hostId: "host-a", limit: 1 },
          { hostId: "host-a", limit: 2 },
        ],
      }),
    ).rejects.toThrow(/rpc input validation failed/u);
  });

  it("persists validated configuration and rechecks waiting dispatches", async () => {
    const { bb, harness } = await setup({ hosts: [hostRecord("host-a")] });

    await harness.behavior.callRpc("setConfiguration", {
      globalLimit: 3,
      hostOverrides: [{ hostId: "host-a", limit: 0 }],
    });

    // The copy stores the load limits in force alongside the slot limits.
    await expect(bb.storage.kv.get("configuration")).resolves.toEqual({
      globalLimit: 3,
      hostOverrides: [{ hostId: "host-a", limit: 0 }],
      loadLimits: { cpuBusyPercent: 85, memoryFreePercent: 10 },
    });
    expect(harness.recheckCount).toBe(1);
  });

  it("detects connected host capacity in the background", async () => {
    const { bb, harness } = await setup({
      hosts: [hostRecord("host-a")],
      detectedParallelism: 12,
    });
    const service = harness.behavior.runService("capacity-detector");

    await waitFor(() => {
      expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    });
    await expect(bb.storage.kv.get("host-capacities")).resolves.toEqual([
      { hostId: "host-a", availableParallelism: 12 },
    ]);
    await expect(harness.behavior.callRpc("getConfiguration")).resolves.toMatchObject({
      hosts: [
        {
          id: "host-a",
          availableParallelism: 12,
          automaticLimit: 12,
          effectiveLimit: 12,
        },
      ],
    });

    service.controller.abort();
    await service.done;
  });

  it("detects a host when it connects after startup", async () => {
    const changes = hostChanges();
    let status: HostResponse["status"] = "disconnected";
    const { harness } = await setup({
      hosts: () => [hostRecord("host-a", status)],
      subscribe: changes.subscribe,
    });
    const service = harness.behavior.runService("capacity-detector");
    await waitFor(() => {
      expect(harness.inspection.sdk.callsTo("hosts.list")).toHaveLength(1);
    });
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);

    status = "connected";
    changes.emitHostChanges("host-a", ["host-connected"]);
    await waitFor(() => {
      expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    });

    service.controller.abort();
    await service.done;
  });

  it("ignores host messages that only report a provider model catalog change", async () => {
    const changes = hostChanges();
    const { harness } = await setup({
      hosts: [hostRecord("host-a")],
      subscribe: changes.subscribe,
    });
    const service = harness.behavior.runService("capacity-detector");
    await waitFor(() => {
      expect(harness.experimental_hostRpcCalls).toHaveLength(1);
      expect(harness.realtimeSignals).toHaveLength(1);
    });
    const hostListCalls = harness.inspection.sdk.callsTo("hosts.list").length;

    changes.emitHostChanges("host-a", ["provider-model-catalog-changed"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.realtimeSignals).toHaveLength(1);
    expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("hosts.list")).toHaveLength(hostListCalls);

    changes.emitHostChanges("host-a", ["host-disconnected"]);
    expect(harness.realtimeSignals).toHaveLength(2);

    service.controller.abort();
    await service.done;
  });

  it("provides CLI parity for global and host overrides", async () => {
    const { harness } = await setup({
      hosts: [hostRecord("host-a", "connected", "Laptop")],
      capacities: [{ hostId: "host-a", availableParallelism: 8 }],
    });

    await expect(harness.behavior.runCli(["global", "3"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "3",
    });
    await expect(harness.behavior.runCli(["host", "host-a", "0"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "Laptop: 0 (8 processors, connected)",
    });
    await expect(harness.behavior.runCli(["host", "host-a", "auto"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "Laptop: auto, 8 (8 processors, connected)",
    });
    await expect(harness.behavior.runCli(["global", "1.5"])).resolves.toMatchObject({
      exitCode: 1,
    });
  });

  it("documents the limit range in help and reports errors as JSON", async () => {
    const { harness } = await setup({
      hosts: [hostRecord("host-a", "connected", "Laptop")],
      capacities: [{ hostId: "host-a", availableParallelism: 8 }],
    });

    const help = (await harness.behavior.runCli(["host", "--help"])).stdout;
    expect(help).toContain("bb thread-limit host");
    expect(help).toContain("0 to 10000");

    const envelope = await harness.behavior.runCli(["host", "host-b", "--json"]);
    expect(envelope.exitCode).toBe(1);
    expect(JSON.parse(envelope.stdout)).toEqual({
      ok: false,
      error: {
        code: "unknown_host",
        message: "Unknown host: host-b",
        hint: "Run `bb machine list` for the enrolled host ids.",
      },
    });
    expect(envelope.stderr).toContain("Unknown host: host-b");

    const badLimit = await harness.behavior.runCli(["host", "host-a", "many"]);
    expect(badLimit.exitCode).toBe(1);
    expect(badLimit.stderr).toContain("Limit must be auto or a whole number from 0 to 10000");
  });
});

describe("message.dispatch", () => {
  it("uses a conservative limit of one until a host is detected", async () => {
    const { hook } = await setup({ running: [running()] });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on host host-a",
    });
  });

  it("uses each host's detected automatic limit", async () => {
    const { hook } = await setup({
      capacities: [{ hostId: "host-a", availableParallelism: 8 }],
      running: [
        running({ id: "a" }),
        running({ id: "b" }),
        running({ id: "c" }),
        running({ id: "d" }),
        running({ id: "e" }),
        running({ id: "f" }),
        running({ id: "g" }),
        running({ id: "h" }),
      ],
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "8 of 8 running on host host-a",
    });
  });

  it("keeps host pools separate and honors explicit overrides", async () => {
    const { hook } = await setup({
      configuration: {
        globalLimit: null,
        hostOverrides: [{ hostId: "host-a", limit: 1 }],
      },
      running: [running({ hostId: "host-a" })],
    });

    await expect(hook(dispatchContext({ hostId: "host-a" }))).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on host host-a",
    });
    await expect(hook(dispatchContext({ hostId: "host-b" }))).resolves.toEqual({
      action: "proceed",
    });
  });

  it("applies the overall limit before a host limit", async () => {
    const { hook } = await setup({
      configuration: { globalLimit: 1, hostOverrides: [] },
      running: [running()],
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on all hosts",
    });
  });

  it("treats zero as a pause rather than as unlimited", async () => {
    const global = await setup({
      configuration: { globalLimit: 0, hostOverrides: [] },
    });
    await expect(global.hook(dispatchContext({ hostId: null }))).resolves.toEqual({
      action: "wait",
      reason: "0 of 0 running on all hosts",
    });

    const host = await setup({
      configuration: {
        globalLimit: null,
        hostOverrides: [{ hostId: "host-a", limit: 0 }],
      },
    });
    await expect(host.hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "0 of 0 running on host host-a",
    });
  });

  it("skips host enforcement when no host has been selected", async () => {
    const { harness, hook } = await setup({ running: [running()] });

    await expect(hook(dispatchContext({ hostId: null }))).resolves.toEqual({
      action: "proceed",
    });
    expect(harness.inspection.sdk.callsTo("threads.listRunning")).toHaveLength(0);
  });

  it("does not re-admit running threads or join-turn attempts", async () => {
    const { hook } = await setup({
      configuration: { globalLimit: 0, hostOverrides: [] },
    });

    await expect(hook(dispatchContext({ thread: { status: "active" } }))).resolves.toEqual({
      action: "proceed",
    });
    await expect(
      hook(
        dispatchContext({
          attempt: "join-turn",
          thread: { status: "idle" },
        }),
      ),
    ).resolves.toEqual({ action: "proceed" });
  });
});

describe("capacity wake events", () => {
  it("rechecks queued work when a running thread stops occupying capacity", async () => {
    const { harness } = await setup();
    const thread = makeThreadResponse({ id: "thr_freed", status: "idle" });

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: null,
    });
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread,
      error: null,
    });
    await harness.behavior.emitThreadEvent("thread.archived", { thread });
    await harness.behavior.emitThreadEvent("thread.deleted", { thread });

    expect(harness.recheckCount).toBe(4);
  });
});

// Added for the copy: a pinned thread is never held.
describe("pinned threads", () => {
  const full = {
    capacities: [{ hostId: "host-a", availableParallelism: 1 }],
    running: [running({ id: "other" })],
  };

  it("lets a pinned thread start a turn the host limit would hold", async () => {
    const { hook } = await setup(full);

    await expect(hook(dispatchContext({ thread: { pinnedAt: 1 } }))).resolves.toEqual({
      action: "proceed",
    });
  });

  it("lets a pinned thread past the overall limit too", async () => {
    const { hook } = await setup({
      configuration: { globalLimit: 0, hostOverrides: [] },
    });

    await expect(hook(dispatchContext({ thread: { pinnedAt: 1 } }))).resolves.toEqual({
      action: "proceed",
    });
  });

  it("still holds a thread that is not pinned", async () => {
    const { hook } = await setup(full);

    await expect(hook(dispatchContext({ thread: { pinnedAt: null } }))).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on host host-a",
    });
  });

  it("rechecks the line when a pin changes, and only then", async () => {
    let threadChanged: ((event: { id: string; changes: string[] }) => void) | null = null;
    const { harness } = await setup({
      subscribe: ((subscription: { event: string; callback: never }) => {
        if (subscription.event === "thread:changed") threadChanged = subscription.callback;
        return () => {};
      }) as never,
    });
    const watcher = harness.behavior.runService("pin-watcher");
    await waitFor(() => expect(threadChanged).not.toBeNull());
    const before = harness.recheckCount;

    threadChanged!({ id: "thr_1", changes: ["title-changed"] });
    expect(harness.recheckCount).toBe(before);
    threadChanged!({ id: "thr_1", changes: ["pin-state-changed"] });
    await waitFor(() => expect(harness.recheckCount).toBe(before + 1));

    watcher.controller.abort();
    await watcher.done;
  });
});

// Added for the copy: a busy host holds new turns.
describe("load limits", () => {
  const busy = { cpuBusyPercent: 95, memoryFreePercent: 60, loadAverage: 30 };

  async function sampled(options: SetupOptions) {
    const fake = await setup({ hosts: [hostRecord("host-a")], ...options });
    const sampler = fake.harness.behavior.runService("load-sampler");
    await waitFor(async () => {
      const view = await fake.harness.behavior.callRpc("getConfiguration");
      expect((view as { hosts: { load: unknown }[] }).hosts[0]?.load).not.toBeNull();
    });
    return {
      ...fake,
      async stop() {
        sampler.controller.abort();
        await sampler.done;
      },
    };
  }

  it("holds a new turn while its host is busy, with slots to spare", async () => {
    const run = await sampled({ hostLoad: busy });

    await expect(run.hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "host-a is busy (CPU 95% busy)",
    });
    await run.stop();
  });

  it("lets a pinned thread, or a turn already running, through a busy host", async () => {
    const run = await sampled({ hostLoad: busy });

    await expect(run.hook(dispatchContext({ thread: { pinnedAt: 1 } }))).resolves.toEqual({
      action: "proceed",
    });
    await expect(run.hook(dispatchContext({ attempt: "join-turn" }))).resolves.toEqual({
      action: "proceed",
    });
    await expect(run.hook(dispatchContext({ thread: { status: "active" } }))).resolves.toEqual({
      action: "proceed",
    });
    await run.stop();
  });

  it("names the slot limit when both the slots and the load are full", async () => {
    const run = await sampled({
      hostLoad: busy,
      capacities: [{ hostId: "host-a", availableParallelism: 1 }],
      running: [running()],
    });

    await expect(run.hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on host host-a",
    });
    await run.stop();
  });

  it("lets turns through a quiet host and one whose load was never read", async () => {
    const quiet = await sampled({});
    await expect(quiet.hook(dispatchContext())).resolves.toEqual({ action: "proceed" });
    await quiet.stop();

    const unread = await setup({ hosts: [hostRecord("host-a")], hostLoad: busy });
    await expect(unread.hook(dispatchContext())).resolves.toEqual({ action: "proceed" });
  });

  it("shows and sets load limits from the CLI", async () => {
    const run = await sampled({ hostLoad: busy });

    const shown = await run.harness.behavior.runCli(["load"]);
    expect(shown.stdout).toBe(
      [
        "Load: a host holds new turns at CPU at least 85% busy or at most 10% memory free",
        "host-a: auto, 1 (processors unknown, connected) · CPU 95% busy, 60% memory free, load 30.0, holding new turns",
      ].join("\n"),
    );
    await expect(run.harness.behavior.runCli(["load", "cpu", "99"])).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(run.harness.behavior.runCli(["load", "memory", "off"])).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(run.bb.storage.kv.get("configuration")).resolves.toEqual({
      globalLimit: null,
      hostOverrides: [],
      loadLimits: { cpuBusyPercent: 99, memoryFreePercent: null },
    });
    // The looser limit lets the busy host's turns go at once.
    await expect(run.hook(dispatchContext())).resolves.toEqual({ action: "proceed" });

    const status = await run.harness.behavior.runCli(["status"]);
    expect(status.stdout).toContain("Load: a host holds new turns at CPU at least 99% busy");

    const bad = await run.harness.behavior.runCli(["load", "cpu", "0"]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("whole percent from 1 to 100");
    const unknown = await run.harness.behavior.runCli(["load", "disk", "5"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown load signal: disk");
    await run.stop();
  });
});
