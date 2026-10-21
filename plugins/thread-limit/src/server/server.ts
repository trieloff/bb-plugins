import { definePlugin } from "@bb-kit/core/plugin";
import { global } from "./command/global.ts";
import { host } from "./command/host.ts";
import { load } from "./command/load.ts";
import { status } from "./command/status.ts";
import { registerCapacityDetector } from "./lib/capacity-detector.ts";
import { decideDispatch } from "./lib/dispatch.ts";
import { createLimiter } from "./lib/limiter.ts";
import { registerLoadSampler } from "./lib/load-sampler.ts";
import { registerPinWatcher } from "./lib/pin-watcher.ts";
import { getConfiguration } from "./rpc/get-configuration.ts";
import { setConfiguration } from "./rpc/set-configuration.ts";

/** A thread that stops running frees its slot; the line is asked again. */
const CAPACITY_FREED_EVENTS = [
  "thread.idle",
  "thread.failed",
  "thread.archived",
  "thread.deleted",
] as const;

export default definePlugin({
  pluginId: "thread-limit",
  services: (bb) => ({ limiter: createLimiter(bb) }),
  rpc: { getConfiguration, setConfiguration },
  command: { status, global, host, load },
  async setup({ bb, limiter }) {
    await limiter.load();
    registerCapacityDetector(bb, limiter);
    registerLoadSampler(bb, limiter);
    registerPinWatcher(bb);
    for (const event of CAPACITY_FREED_EVENTS) {
      bb.events.on(event, async () => {
        await bb.experimental_hooks.recheck("message.dispatch");
      });
    }
    bb.experimental_hooks.on("message.dispatch", (context) =>
      decideDispatch(context, {
        configuration: limiter.configuration(),
        capacities: limiter.capacities,
        listRunning: () => bb.sdk.threads.listRunning(),
        overloadedBy: (hostId) => limiter.loadFor(hostId)?.overloadedBy ?? null,
      }),
    );
  },
});
