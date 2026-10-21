import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CONFIGURATION_CHANGED_CHANNEL } from "../../shared/configuration.ts";
import { threadLimitHostContract } from "../../shared/host-contract.ts";
import { LOAD_SAMPLE_MS } from "../../shared/load.ts";
import type { Limiter } from "./limiter.ts";

/** One host's answer may take this long before its sample is skipped. */
const LOAD_CALL_TIMEOUT_MS = 5_000;
/** One warning per host per this long, however many samples fail. */
const WARN_EVERY_MS = 5 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Samples every connected host's load in the background, so a dispatch reads
 * the latest sample instead of waiting on a host. A host that stops holding
 * turns asks bb to run the held ones past the hook again.
 */
export function registerLoadSampler(bb: BbPluginApi, limiter: Limiter): void {
  const hostClient = bb.hosts.experimental_client({ contract: threadLimitHostContract });
  const lastWarnedAt = new Map<string, number>();

  async function sampleOnce(signal: AbortSignal): Promise<void> {
    let hosts: Awaited<ReturnType<typeof bb.sdk.hosts.list>>;
    try {
      hosts = await bb.sdk.hosts.list({ signal });
    } catch (error) {
      if (!signal.aborted) bb.log.warn(`Could not list hosts for load: ${errorMessage(error)}`);
      return;
    }
    const connected = hosts.filter((host) => host.status === "connected");
    for (const host of hosts) {
      if (host.status !== "connected") limiter.forgetLoad(host.id);
    }
    let released = false;
    let changed = false;
    await Promise.all(
      connected.map(async (host) => {
        try {
          const load = await hostClient.call("getLoad", null, {
            hostId: host.id,
            signal: AbortSignal.any([signal, AbortSignal.timeout(LOAD_CALL_TIMEOUT_MS)]),
          });
          const result = limiter.recordLoad(host.id, { ...load, sampledAt: Date.now() });
          released ||= result.released;
          changed ||= result.changed;
        } catch (error) {
          if (signal.aborted) return;
          // A host that cannot answer keeps its last sample until that goes
          // stale; after that its load is unknown and holds nothing.
          const now = Date.now();
          if (now - (lastWarnedAt.get(host.id) ?? Number.NEGATIVE_INFINITY) >= WARN_EVERY_MS) {
            lastWarnedAt.set(host.id, now);
            bb.log.warn(`Could not read load for host ${host.id}: ${errorMessage(error)}`);
          }
        }
      }),
    );
    if (changed) bb.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});
    if (released) await bb.experimental_hooks.recheck("message.dispatch");
  }

  bb.background.service("load-sampler", {
    async start(signal) {
      while (!signal.aborted) {
        await sampleOnce(signal);
        await sleep(LOAD_SAMPLE_MS, signal);
      }
    },
  });
}
