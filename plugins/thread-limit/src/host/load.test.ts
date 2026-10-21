import { describe, expect, it } from "bun:test";
import { cpuBusyBetween, createLoadReader } from "./load.ts";

function times(user: number, sys: number, idle: number) {
  return { user, nice: 0, sys, idle, irq: 0 };
}

describe("cpuBusyBetween", () => {
  it("is the busy share of all CPU time across cores", () => {
    // Core one: 300 busy of 400; core two: 100 busy of 400. Together 50%.
    expect(
      cpuBusyBetween([times(0, 0, 0), times(0, 0, 0)], [times(200, 100, 100), times(50, 50, 300)]),
    ).toBe(50);
  });

  it("is zero when no time passed", () => {
    expect(cpuBusyBetween([times(5, 5, 5)], [times(5, 5, 5)])).toBe(0);
  });
});

describe("createLoadReader", () => {
  it("reports CPU, memory, and load average in range, measuring from its last reading", async () => {
    const read = createLoadReader();
    for (const load of [await read(), await read()]) {
      expect(load.cpuBusyPercent).toBeGreaterThanOrEqual(0);
      expect(load.cpuBusyPercent).toBeLessThanOrEqual(100);
      expect(load.loadAverage).toBeGreaterThanOrEqual(0);
      if (load.memoryFreePercent !== null) {
        expect(load.memoryFreePercent).toBeGreaterThanOrEqual(0);
        expect(load.memoryFreePercent).toBeLessThanOrEqual(100);
      }
    }
  });
});
