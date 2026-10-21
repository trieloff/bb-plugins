import { PluginCliError } from "@bb-kit/core/command";
import { MAX_LIMIT_VALUE, parseLimitValue } from "../../shared/limits.ts";
import type { HostView } from "../../shared/configuration.ts";

// The CLI text of bb's concurrency-limit plugin (plugins/concurrency-limit/
// server.ts at desktop-v0.46.1), so `bb thread-limit` reads like
// `bb concurrency-limit`.

export const PINNED_EXEMPTION_LINE = "Pinned threads are never held, but still count";

export function parseLimitArgument(
  raw: string,
  automaticKeyword: "auto" | "unlimited",
): number | null {
  if (raw === automaticKeyword) return null;
  const value = parseLimitValue(raw);
  if (value === null) {
    throw new PluginCliError(
      `Limit must be ${automaticKeyword} or a whole number from 0 to ${MAX_LIMIT_VALUE}`,
      { code: "invalid_limit" },
    );
  }
  return value;
}

export function formatHostLine(
  host: Pick<HostView, "name" | "status" | "availableParallelism" | "effectiveLimit" | "override"> &
    Partial<Pick<HostView, "load" | "overloadedBy">>,
): string {
  const source = host.override === null ? `auto, ${host.effectiveLimit}` : String(host.override);
  const processors =
    host.availableParallelism === null
      ? "processors unknown"
      : `${host.availableParallelism} processors`;
  const line = `${host.name}: ${source} (${processors}, ${host.status})`;
  // Added for the copy: the host's load, once it has been sampled.
  return host.load ? `${line} · ${formatLoad(host.load, host.overloadedBy ?? null)}` : line;
}

export function formatLoad(
  load: NonNullable<HostView["load"]>,
  overloadedBy: string | null,
): string {
  const memory =
    load.memoryFreePercent === null ? "" : `, ${Math.round(load.memoryFreePercent)}% memory free`;
  const state = overloadedBy === null ? "" : ", holding new turns";
  return `CPU ${Math.round(load.cpuBusyPercent)}% busy${memory}, load ${load.loadAverage.toFixed(1)}${state}`;
}

export function unknownHost(hostId: string): PluginCliError {
  return new PluginCliError(`Unknown host: ${hostId}`, {
    code: "unknown_host",
    hint: "Run `bb machine list` for the enrolled host ids.",
  });
}
