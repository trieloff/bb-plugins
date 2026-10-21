import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CONFIGURATION_CHANGED_CHANNEL } from "../../shared/configuration.ts";
import { threadLimitHostContract } from "../../shared/host-contract.ts";
import type { Limiter } from "./limiter.ts";

// The capacity-detector service of bb's concurrency-limit plugin
// (plugins/concurrency-limit/server.ts at desktop-v0.46.1), unchanged: each
// connected host reports its available processors, which set its automatic
// limit. A host is asked again when it connects and after a reconnect.

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

type RefreshOutcome = "settled" | "retry";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerCapacityDetector(bb: BbPluginApi, limiter: Limiter): void {
  const hostClient = bb.hosts.experimental_client({ contract: threadLimitHostContract });
  const { capacities } = limiter;

  let refreshAllRequested = true;
  const requestedHostIds = new Set<string>();
  let wakeWaiter: (() => void) | null = null;

  function requestRefresh(hostId?: string): void {
    if (hostId === undefined) refreshAllRequested = true;
    else requestedHostIds.add(hostId);
    wakeWaiter?.();
  }

  async function refreshCapacities(
    signal: AbortSignal,
    refreshAll: boolean,
    hostIds: ReadonlySet<string>,
  ): Promise<RefreshOutcome> {
    try {
      const availableHosts = await bb.sdk.hosts.list({ signal });
      let changed = false;
      if (refreshAll) {
        const availableHostIds = new Set(availableHosts.map((host) => host.id));
        for (const hostId of capacities.keys()) {
          if (!availableHostIds.has(hostId)) {
            capacities.delete(hostId);
            changed = true;
          }
        }
      }
      let retry = false;
      const targets = availableHosts.filter(
        (availableHost) =>
          availableHost.status === "connected" && (refreshAll || hostIds.has(availableHost.id)),
      );
      await Promise.all(
        targets.map(async (availableHost) => {
          try {
            const result = await hostClient.call("getCapacity", null, {
              hostId: availableHost.id,
              signal,
            });
            if (capacities.get(availableHost.id) !== result.availableParallelism) {
              capacities.set(availableHost.id, result.availableParallelism);
              changed = true;
            }
          } catch (error) {
            if (signal.aborted) return;
            retry = true;
            bb.log.warn(
              `Could not detect capacity for host ${availableHost.id}: ${errorMessage(error)}`,
            );
          }
        }),
      );
      if (changed) {
        await limiter.persistCapacities();
        bb.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});
        await bb.experimental_hooks.recheck("message.dispatch");
      }
      return retry ? "retry" : "settled";
    } catch (error) {
      if (!signal.aborted) {
        bb.log.warn(`Could not load hosts for capacity detection: ${errorMessage(error)}`);
      }
      return signal.aborted ? "settled" : "retry";
    }
  }

  function waitForRefresh(
    signal: AbortSignal,
    retryDelayMs: number | null,
  ): Promise<"requested" | "retry" | "aborted"> {
    if (signal.aborted) return Promise.resolve("aborted");
    if (refreshAllRequested || requestedHostIds.size > 0) {
      return Promise.resolve("requested");
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const finish = (reason: "requested" | "retry" | "aborted"): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (wakeWaiter === wake) wakeWaiter = null;
        signal.removeEventListener("abort", abort);
        resolve(reason);
      };
      const wake = (): void => finish("requested");
      const abort = (): void => finish("aborted");
      wakeWaiter = wake;
      signal.addEventListener("abort", abort, { once: true });
      if (retryDelayMs !== null) {
        timer = setTimeout(() => finish("retry"), retryDelayMs);
      }
    });
  }

  bb.background.service("capacity-detector", {
    async start(signal) {
      const unsubscribeHost = bb.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (
            event.changes.some(
              (change) => change === "host-connected" || change === "host-disconnected",
            )
          )
            bb.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});
          if (event.changes.includes("host-connected")) requestRefresh(event.id);
        },
      });
      const unsubscribeRealtime = bb.sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected" && event.reconnected) requestRefresh();
        },
      });
      let retryMs = RETRY_MIN_MS;
      try {
        while (!signal.aborted) {
          const refreshAll = refreshAllRequested;
          const hostIds = new Set(requestedHostIds);
          refreshAllRequested = false;
          requestedHostIds.clear();
          const outcome = await refreshCapacities(signal, refreshAll, hostIds);
          if (signal.aborted) break;
          if (refreshAllRequested || requestedHostIds.size > 0) continue;
          const wakeReason = await waitForRefresh(signal, outcome === "retry" ? retryMs : null);
          if (wakeReason === "retry") {
            refreshAllRequested = true;
            retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
          } else if (outcome === "settled") {
            retryMs = RETRY_MIN_MS;
          }
        }
      } finally {
        unsubscribeRealtime();
        unsubscribeHost();
        wakeWaiter?.();
        wakeWaiter = null;
      }
    },
  });
}
