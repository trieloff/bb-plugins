import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CpuTimes = ReturnType<typeof cpus>[number]["times"];

/** CPU time measured over this long when there is no earlier sample to compare with. */
const FIRST_SAMPLE_MS = 500;

function snapshot(): CpuTimes[] {
  return cpus().map((cpu) => cpu.times);
}

/** Busy share of all CPU time between two snapshots, in percent. */
export function cpuBusyBetween(before: readonly CpuTimes[], after: readonly CpuTimes[]): number {
  let busy = 0;
  let total = 0;
  after.forEach((times, index) => {
    const earlier = before[index];
    if (earlier === undefined) return;
    const idle = times.idle - earlier.idle;
    const all =
      times.user -
      earlier.user +
      (times.nice - earlier.nice) +
      (times.sys - earlier.sys) +
      (times.irq - earlier.irq) +
      idle;
    total += all;
    busy += all - idle;
  });
  return total <= 0 ? 0 : Math.min(100, Math.max(0, (100 * busy) / total));
}

/**
 * Memory the OS counts as available, in percent. macOS reports it as memory
 * pressure (`kern.memorystatus_level`); Linux as MemAvailable. `os.freemem()`
 * leaves out reclaimable cache on both, so it is only the last resort.
 */
export async function memoryFreePercent(): Promise<number | null> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync(
        "/usr/sbin/sysctl",
        ["-n", "kern.memorystatus_level"],
        {
          timeout: 2_000,
        },
      );
      const level = Number(stdout.trim());
      return Number.isFinite(level) ? level : null;
    }
    if (process.platform === "linux") {
      const meminfo = await readFile("/proc/meminfo", "utf8");
      const field = (name: string) =>
        Number(new RegExp(`^${name}:\\s+(\\d+)`, "mu").exec(meminfo)?.[1]);
      const available = field("MemAvailable");
      const total = field("MemTotal");
      if (Number.isFinite(available) && Number.isFinite(total) && total > 0) {
        return (100 * available) / total;
      }
    }
    return (100 * freemem()) / totalmem();
  } catch {
    return null;
  }
}

/**
 * A load reader that measures CPU since its previous reading, so a reading
 * every few seconds covers the whole gap between them rather than an instant.
 */
export function createLoadReader() {
  let previous: CpuTimes[] | null = null;
  return async () => {
    let before = previous;
    if (before === null) {
      before = snapshot();
      await new Promise((resolve) => setTimeout(resolve, FIRST_SAMPLE_MS));
    }
    const after = snapshot();
    previous = after;
    return {
      cpuBusyPercent: cpuBusyBetween(before, after),
      memoryFreePercent: await memoryFreePercent(),
      loadAverage: loadavg()[0] ?? 0,
    };
  };
}
