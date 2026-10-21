import { describe, expect, it } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { LOAD_STALE_MS } from "../../shared/load.ts";
import { createLimiter } from "./limiter.ts";

function sample(cpuBusyPercent: number, sampledAt: number, memoryFreePercent: number | null = 50) {
  return { cpuBusyPercent, memoryFreePercent, loadAverage: 1, sampledAt };
}

async function limiter() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "thread-limit",
    sdk: { hosts: { list: async () => [] } },
  });
  const created = createLimiter(bb);
  await created.load();
  return { limiter: created, harness };
}

describe("load state", () => {
  it("starts holding at the limit and releases only below the release mark", async () => {
    const { limiter: state } = await limiter();

    expect(state.recordLoad("host-a", sample(90, 1_000))).toEqual({
      released: false,
      changed: true,
    });
    expect(state.loadFor("host-a", 1_000)?.overloadedBy).toBe("CPU 90% busy");
    // Back under the limit, but above the release mark: still holding.
    expect(state.recordLoad("host-a", sample(80, 2_000))).toEqual({
      released: false,
      changed: false,
    });
    expect(state.loadFor("host-a", 2_000)?.overloadedBy).toBe("CPU 80% busy");
    expect(state.recordLoad("host-a", sample(65, 3_000))).toEqual({
      released: true,
      changed: true,
    });
    expect(state.loadFor("host-a", 3_000)?.overloadedBy).toBe(null);
  });

  it("forgets a sample once it goes stale, so an unknown load holds nothing", async () => {
    const { limiter: state } = await limiter();

    state.recordLoad("host-a", sample(99, 1_000));
    expect(state.loadFor("host-a", 1_000 + LOAD_STALE_MS)?.overloadedBy).toBe("CPU 99% busy");
    expect(state.loadFor("host-a", 1_000 + LOAD_STALE_MS + 1)).toBe(null);
    // A stale sample also starts the next one afresh, without the release gap.
    expect(state.recordLoad("host-a", sample(80, 1_000 + 2 * LOAD_STALE_MS))).toEqual({
      released: false,
      changed: false,
    });
    expect(state.loadFor("host-a", 1_000 + 2 * LOAD_STALE_MS)?.overloadedBy).toBe(null);
  });

  it("judges every host again when the limits change, and rechecks held turns", async () => {
    const { limiter: state, harness } = await limiter();
    const now = Date.now();
    state.recordLoad("host-a", sample(90, now));

    await state.save({
      globalLimit: null,
      hostOverrides: [],
      loadLimits: { cpuBusyPercent: 95, memoryFreePercent: 10 },
    });
    expect(state.loadFor("host-a")?.overloadedBy).toBe(null);
    expect(harness.recheckCount).toBe(1);
  });

  it("keeps the load limits when a save leaves them out", async () => {
    const { limiter: state } = await limiter();
    await state.save({
      globalLimit: null,
      hostOverrides: [],
      loadLimits: { cpuBusyPercent: 70, memoryFreePercent: null },
    });

    await state.save({ globalLimit: 4, hostOverrides: [] });
    expect(state.configuration()).toEqual({
      globalLimit: 4,
      hostOverrides: [],
      loadLimits: { cpuBusyPercent: 70, memoryFreePercent: null },
    });
  });
});
