// Ported from bb's concurrency-limit plugin (host.test.ts at desktop-v0.46.1).
import { availableParallelism } from "node:os";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "bun:test";
import hostEntry from "./host.ts";

describe("Thread limit host entry", () => {
  it("reports the host's available parallelism", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);

    await expect(harness.experimental_call("getCapacity", null)).resolves.toEqual({
      availableParallelism: availableParallelism(),
    });
    await harness.experimental_dispose();
  });

  // Added for the copy: load, for load limits.
  it("reports the host's load", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry);

    const load = await harness.experimental_call("getLoad", null);
    expect(load.cpuBusyPercent).toBeGreaterThanOrEqual(0);
    expect(load.cpuBusyPercent).toBeLessThanOrEqual(100);
    expect(load.loadAverage).toBeGreaterThanOrEqual(0);
    await harness.experimental_dispose();
  });
});
