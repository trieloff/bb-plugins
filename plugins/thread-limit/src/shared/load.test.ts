import { describe, expect, it } from "bun:test";
import {
  CPU_RELEASE_GAP,
  formatLoadLimits,
  MEMORY_RELEASE_GAP,
  overloadReason,
  parsePercent,
} from "./load.ts";

const limits = { cpuBusyPercent: 85, memoryFreePercent: 10 };

describe("overloadReason", () => {
  it("holds at the CPU limit and not below it", () => {
    expect(overloadReason({ cpuBusyPercent: 84.4, memoryFreePercent: 50 }, limits, false)).toBe(
      null,
    );
    expect(overloadReason({ cpuBusyPercent: 85, memoryFreePercent: 50 }, limits, false)).toBe(
      "CPU 85% busy",
    );
  });

  it("holds when free memory falls to the limit, and ignores memory it cannot read", () => {
    expect(overloadReason({ cpuBusyPercent: 10, memoryFreePercent: 9.6 }, limits, false)).toBe(
      "10% memory free",
    );
    expect(overloadReason({ cpuBusyPercent: 10, memoryFreePercent: null }, limits, false)).toBe(
      null,
    );
  });

  it("keeps holding until the load drops below the release marks", () => {
    const releaseCpu = 85 - CPU_RELEASE_GAP;
    expect(
      overloadReason({ cpuBusyPercent: releaseCpu + 1, memoryFreePercent: 50 }, limits, true),
    ).toBe(`CPU ${releaseCpu + 1}% busy`);
    expect(
      overloadReason({ cpuBusyPercent: releaseCpu - 1, memoryFreePercent: 50 }, limits, true),
    ).toBe(null);
    const releaseMemory = 10 + MEMORY_RELEASE_GAP;
    expect(
      overloadReason({ cpuBusyPercent: 10, memoryFreePercent: releaseMemory }, limits, true),
    ).toBe(`${releaseMemory}% memory free`);
    expect(
      overloadReason({ cpuBusyPercent: 10, memoryFreePercent: releaseMemory + 1 }, limits, true),
    ).toBe(null);
  });

  it("holds nothing with both limits off", () => {
    expect(
      overloadReason(
        { cpuBusyPercent: 100, memoryFreePercent: 0 },
        { cpuBusyPercent: null, memoryFreePercent: null },
        true,
      ),
    ).toBe(null);
  });
});

describe("parsePercent", () => {
  it("reads whole percents from 1 to 100, and off or blank as off", () => {
    expect(parsePercent("85")).toBe(85);
    expect(parsePercent(" 1 ")).toBe(1);
    expect(parsePercent("100")).toBe(100);
    expect(parsePercent("off")).toBe(null);
    expect(parsePercent("")).toBe(null);
  });

  it("refuses anything else", () => {
    for (const raw of ["0", "101", "1.5", "-5", "abc"]) expect(parsePercent(raw)).toBe(undefined);
  });
});

describe("formatLoadLimits", () => {
  it("names each limit in force", () => {
    expect(formatLoadLimits(limits)).toBe(
      "Load: a host holds new turns at CPU at least 85% busy or at most 10% memory free",
    );
    expect(formatLoadLimits({ cpuBusyPercent: 90, memoryFreePercent: null })).toBe(
      "Load: a host holds new turns at CPU at least 90% busy",
    );
    expect(formatLoadLimits({ cpuBusyPercent: null, memoryFreePercent: null })).toBe("Load: off");
  });
});
