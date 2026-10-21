// Load limits: a machine that is already busy holds new turns, on top of the
// slot limits copied from bb's concurrency-limit plugin. Each connected host
// is sampled in the background, so a dispatch reads the latest sample and
// never waits on a host.

/** How often each connected host reports its load. */
export const LOAD_SAMPLE_MS = 10_000;
/** A sample older than this is not trusted: the host's load is unknown. */
export const LOAD_STALE_MS = 3 * LOAD_SAMPLE_MS;

/**
 * Once a host holds turns, it lets them go only below these marks, so a host
 * that hovers at the threshold does not flip between holding and releasing
 * with every sample.
 */
export const CPU_RELEASE_GAP = 15;
export const MEMORY_RELEASE_GAP = 5;

export interface LoadLimits {
  /** Hold new turns while CPU is at least this busy, in percent; null is off. */
  readonly cpuBusyPercent: number | null;
  /** Hold new turns while free memory is at most this, in percent; null is off. */
  readonly memoryFreePercent: number | null;
}

export const DEFAULT_LOAD_LIMITS: LoadLimits = { cpuBusyPercent: 85, memoryFreePercent: 10 };

export interface LoadSample {
  /** Share of CPU time spent busy across all cores since the last sample. */
  readonly cpuBusyPercent: number;
  /** Memory the OS counts as available, in percent; null where it cannot tell. */
  readonly memoryFreePercent: number | null;
  /** The one-minute load average, for display. */
  readonly loadAverage: number;
  readonly sampledAt: number;
}

/**
 * Why a host is too busy for a new turn, or null when it has room. A host
 * that was holding keeps holding until it drops below the release marks.
 */
export function overloadReason(
  sample: Pick<LoadSample, "cpuBusyPercent" | "memoryFreePercent">,
  limits: LoadLimits,
  wasOverloaded: boolean,
): string | null {
  if (limits.cpuBusyPercent !== null) {
    const threshold = wasOverloaded
      ? limits.cpuBusyPercent - CPU_RELEASE_GAP
      : limits.cpuBusyPercent;
    if (sample.cpuBusyPercent >= threshold) {
      return `CPU ${Math.round(sample.cpuBusyPercent)}% busy`;
    }
  }
  if (limits.memoryFreePercent !== null && sample.memoryFreePercent !== null) {
    const threshold = wasOverloaded
      ? limits.memoryFreePercent + MEMORY_RELEASE_GAP
      : limits.memoryFreePercent;
    if (sample.memoryFreePercent <= threshold) {
      return `${Math.round(sample.memoryFreePercent)}% memory free`;
    }
  }
  return null;
}

/** Parses a load threshold: a whole percent from 1 to 100, or `off`. */
export function parsePercent(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "off" || trimmed === "") return null;
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= 100 ? value : undefined;
}

export function formatLoadLimits(limits: LoadLimits): string {
  const parts = [
    limits.cpuBusyPercent === null ? null : `CPU at least ${limits.cpuBusyPercent}% busy`,
    limits.memoryFreePercent === null ? null : `at most ${limits.memoryFreePercent}% memory free`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Load: off" : `Load: a host holds new turns at ${parts.join(" or ")}`;
}
