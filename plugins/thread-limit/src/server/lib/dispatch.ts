import type { MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import type { Configuration } from "../../shared/configuration.ts";
import { resolveHostLimit } from "../../shared/limits.ts";

// The `message.dispatch` decision of bb's concurrency-limit plugin
// (plugins/concurrency-limit/server.ts at desktop-v0.46.1), with two steps
// added: a new turn also waits while its host is too busy, and a turn either
// rule would hold goes ahead when its thread is pinned. A pinned thread's turn
// still runs, so it still counts against every limit.

export const MAX_REASON_LENGTH = 200;

export function waitDecision(limit: number, scopeLabel: string): MessageDispatchHookDecision {
  const reason = `${limit} of ${limit} running on ${scopeLabel}`;
  return {
    action: "wait",
    reason:
      reason.length <= MAX_REASON_LENGTH ? reason : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`,
  };
}

export interface DispatchDependencies {
  configuration: Configuration;
  capacities: ReadonlyMap<string, number>;
  listRunning(): Promise<readonly { hostId: string | null }[]>;
  /** Why a host holds new turns for its load, or null when it has room or is unknown. */
  overloadedBy(hostId: string): string | null;
}

type DispatchContext = Pick<MessageDispatchHookContext, "attempt" | "host"> & {
  thread: Pick<MessageDispatchHookContext["thread"], "id" | "status" | "pinnedAt">;
};

/** The original's decision: the limit that this turn would exceed, if any. */
async function limitDecision(
  context: DispatchContext,
  { configuration, capacities, listRunning }: DispatchDependencies,
): Promise<MessageDispatchHookDecision> {
  if (
    context.attempt === "join-turn" ||
    context.thread.status === "active" ||
    context.thread.status === "starting"
  ) {
    return { action: "proceed" };
  }

  const host = context.host;
  if (configuration.globalLimit === null && host === null) {
    return { action: "proceed" };
  }
  const running = await listRunning();

  if (configuration.globalLimit !== null && running.length >= configuration.globalLimit) {
    return waitDecision(configuration.globalLimit, "all hosts");
  }

  if (host !== null) {
    const resolved = resolveHostLimit(configuration, host.id, capacities.get(host.id) ?? null);
    const onHost = running.filter((thread) => thread.hostId === host.id);
    if (onHost.length >= resolved.limit) {
      const label = host.name.trim() === "" ? host.id : host.name;
      return waitDecision(resolved.limit, `host ${label}`);
    }
  }

  return { action: "proceed" };
}

/** A turn that is already running, or joins one, asks for nothing new. */
function startsTurn(context: DispatchContext): boolean {
  return (
    context.attempt !== "join-turn" &&
    context.thread.status !== "active" &&
    context.thread.status !== "starting"
  );
}

/** The slot limits first; with a slot free, the host's load. */
async function heldBy(
  context: DispatchContext,
  dependencies: DispatchDependencies,
): Promise<MessageDispatchHookDecision> {
  const decision = await limitDecision(context, dependencies);
  if (decision.action !== "proceed" || !startsTurn(context) || context.host === null) {
    return decision;
  }
  const overloadedBy = dependencies.overloadedBy(context.host.id);
  if (overloadedBy === null) return decision;
  const label = context.host.name.trim() === "" ? context.host.id : context.host.name;
  const reason = `${label} is busy (${overloadedBy})`;
  return {
    action: "wait",
    reason:
      reason.length <= MAX_REASON_LENGTH ? reason : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`,
  };
}

export async function decideDispatch(
  context: DispatchContext,
  dependencies: DispatchDependencies,
): Promise<MessageDispatchHookDecision> {
  const decision = await heldBy(context, dependencies);
  if (decision.action !== "wait") return decision;
  return context.thread.pinnedAt === null ? decision : { action: "proceed" };
}
