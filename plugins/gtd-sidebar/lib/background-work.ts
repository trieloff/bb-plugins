import type { PluginSidebarThread } from "@get-bb/plugin-sdk";

/**
 * How long a background command keeps its thread in Waiting. A build or a
 * test run finishes inside it; a dev server, a watcher, or a poll that has
 * outlived it is not something the user is waiting on, and the thread is
 * theirs to act on again.
 */
export const BACKGROUND_COMMAND_WAIT_MS = 30 * 60_000;

/**
 * Whether background commands are a thread's only live work, so their age
 * alone decides between Waiting and Next Action. A turn, workflow, background
 * agent, plan, or goal keeps the thread working whatever the commands do, and
 * a raised hand already sends it to Next Action.
 */
export function waitsOnlyOnBackgroundCommands(thread: PluginSidebarThread): boolean {
  const { activity } = thread;
  return (
    activity.backgroundCommands > 0 &&
    !thread.hasPendingInteraction &&
    activity.workflows === 0 &&
    activity.backgroundAgents === 0 &&
    activity.planMode === 0 &&
    activity.goals === 0 &&
    thread.indicator !== "runtime" &&
    thread.indicator !== "working-draft"
  );
}

/** When the newest of a thread's running background commands started; null with none. */
export function newestBackgroundCommandStart(
  commands: readonly { startedAt: number }[],
): number | null {
  return commands.reduce<number | null>(
    (newest, command) =>
      newest === null || command.startedAt > newest ? command.startedAt : newest,
    null,
  );
}

/**
 * Whether every running background command has outlived the wait. The newest
 * one decides: a test run started a minute ago still holds the thread even
 * beside a dev server that has run all day. An unknown start holds it too.
 */
export function backgroundCommandsOutlived(newestStartedAt: number | null, now: number): boolean {
  return newestStartedAt !== null && now - newestStartedAt >= BACKGROUND_COMMAND_WAIT_MS;
}

/**
 * The thread as the shelves should see it once its background commands have
 * outlived the wait: no longer working. Commands draw no row badge, so only
 * the shelf, the park check, and the family's Waiting rollup change; the row's
 * own status still shows the command running.
 */
export function setAsideBackgroundCommands(thread: PluginSidebarThread): PluginSidebarThread {
  return { ...thread, activity: { ...thread.activity, backgroundCommands: 0 } };
}
