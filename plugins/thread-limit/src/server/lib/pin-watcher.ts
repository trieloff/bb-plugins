import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * A pinned thread is never held, so a pin (or an unpin) changes what the line
 * should do with the turns already waiting: bb is asked to run them past the
 * hook again. The feed is bb's own; nothing here keeps its own pin state.
 */
export function registerPinWatcher(bb: BbPluginApi): void {
  bb.background.service("pin-watcher", {
    async start(signal) {
      const unsubscribe = bb.sdk.subscribe({
        event: "thread:changed",
        callback: (event) => {
          if (!event.changes.includes("pin-state-changed")) return;
          void bb.experimental_hooks
            .recheck("message.dispatch")
            .catch((error: unknown) =>
              bb.log.warn(`Could not recheck held turns after a pin: ${String(error)}`),
            );
        },
      });
      try {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        unsubscribe();
      }
    },
  });
}
