import { z } from "zod";

/** The agent tool's name; its text lives in `instructions/tools/`. */
export const SELF_SNOOZE_TOOL = "snooze_this_thread";

const MINUTE_MS = 60_000;
/** The longest snooze an agent may set, like the sidebar's own presets. */
export const MAX_SELF_SNOOZE_MINUTES = 30 * 24 * 60;
/** A wake sooner than this is not a snooze: the turn has barely ended. */
const MIN_SELF_SNOOZE_MS = MINUTE_MS;
/**
 * How far past the end of the turn the snooze starts. The turn's own last
 * message is activity, and activity after a snooze wakes it, so the snooze
 * must begin after that message rather than when the agent asked for it.
 */
export const SELF_SNOOZE_SETTLE_MS = 2_000;

export const selfSnoozeInputSchema = z
  .object({
    until: z.string().trim().min(1).optional(),
    minutes: z.number().int().min(1).max(MAX_SELF_SNOOZE_MINUTES).optional(),
    pullRequestUrl: z.string().url().optional(),
  })
  .strict();

export type SelfSnoozeInput = z.infer<typeof selfSnoozeInputSchema>;

export type SelfSnoozeWake =
  | { kind: "at"; snoozedUntil: number }
  /** No time given: the one-click snooze's adaptive wake time. */
  | { kind: "adaptive" }
  | { kind: "invalid"; error: string };

/** When an agent's snooze ends: the time it gave, or the adaptive one. */
export function selfSnoozeWake(input: SelfSnoozeInput, now: number): SelfSnoozeWake {
  if (input.until !== undefined && input.minutes !== undefined) {
    return { kind: "invalid", error: "Give either until or minutes, not both." };
  }
  if (input.minutes !== undefined) {
    return { kind: "at", snoozedUntil: now + input.minutes * MINUTE_MS };
  }
  if (input.until === undefined) return { kind: "adaptive" };
  const at = Date.parse(input.until);
  if (Number.isNaN(at)) {
    return {
      kind: "invalid",
      error: `Could not read "${input.until}" as a date and time. Use ISO 8601 with an offset, such as 2026-10-22T09:00:00+02:00.`,
    };
  }
  if (at - now < MIN_SELF_SNOOZE_MS) {
    return { kind: "invalid", error: `${input.until} is not in the future.` };
  }
  if (at - now > MAX_SELF_SNOOZE_MINUTES * MINUTE_MS) {
    return { kind: "invalid", error: "A snooze can last at most 30 days." };
  }
  return { kind: "at", snoozedUntil: at };
}

/**
 * When the snooze starts once the agent's turn has ended: after the turn's
 * last activity, so that activity does not wake it straight away.
 */
export function selfSnoozeStartsAt(turnEndedAt: number, latestAttentionAt: number): number {
  return Math.max(turnEndedAt, latestAttentionAt) + SELF_SNOOZE_SETTLE_MS;
}
