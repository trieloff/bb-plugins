/**
 * What the one-click snooze button actually does.
 *
 * The preset menu stays literal — you picked a time, you get that time. This
 * is the other button, the one on every card that means "not now", and "not
 * now" is a judgement the sidebar can make better than a fixed +1 day.
 *
 * Two corrections, both to the same failure: a thread that comes back at a
 * moment you were never going to deal with it, so you snooze it again, and
 * again, and the inbox turns into a treadmill.
 *
 *  - A snooze onto a weekend, for a project you only work on weekdays, is a
 *    thread that will be ignored on Saturday and ignored again on Sunday. It
 *    goes to Monday instead. See `lib/work-rhythm.ts` for who counts as a
 *    weekday-only project, which is inferred, never assumed.
 *  - A thread you snooze day after day with nothing happening in between is a
 *    thread telling you its wake time is wrong. Each such snooze climbs a
 *    ladder, so the same number of clicks buys steadily more quiet. Anything
 *    actually happening on the thread puts it back at the bottom.
 */

import { atHour, MORNING_HOUR } from "./lifecycle.ts";
import { isWeekend } from "./work-rhythm.ts";

/**
 * Fibonacci, not doubling: the same escalation, but with a gentler middle,
 * where most threads live. Doubling steps 8 → 16 days in one click, which is
 * a long time to lose something on the strength of one impatient afternoon.
 *
 * The last rung is the cap. A thread parked a month is not forgotten — every
 * wake path still applies, so real activity or PR movement brings it straight
 * back — but nothing pushes it past a month on repetition alone.
 */
export const SNOOZE_LADDER_DAYS: readonly number[] = [1, 2, 3, 5, 8, 13, 21, 30];

export function ladderDays(step: number): number {
  const index = Math.min(Math.max(step, 0), SNOOZE_LADDER_DAYS.length - 1);
  return SNOOZE_LADDER_DAYS[index];
}

export interface QuickSnoozeInputs {
  now: number;
  /** The ladder position the last quick snooze used; null when there is none. */
  previousStep: number | null;
  /** When that snooze was set, which is the line activity is measured from. */
  lastSnoozedAt: number | null;
  /** bb's newest attention timestamp for the thread. */
  latestAttentionAt: number;
  /** Whether this thread's project is one you only work on weekdays. */
  weekdayOnlyProject: boolean;
}

export interface QuickSnoozePlan {
  snoozedUntil: number;
  /** The ladder position this snooze used; store it as the next `previousStep`. */
  step: number;
  /** Ladder days before any weekend shift, for the label and for tests. */
  ladderDays: number;
  /** True when the wake moved off a weekend onto the following Monday. */
  shiftedOffWeekend: boolean;
  /** True when this snooze restarted the ladder because something happened. */
  reset: boolean;
}

/**
 * Where on the ladder the next snooze sits.
 *
 * Activity is the whole of the reset rule, and it is read rather than
 * recorded: if bb's newest attention timestamp is later than the moment the
 * last snooze was set, something happened while the thread was away, and this
 * snooze is a fresh decision rather than the same one repeated. That is the
 * same comparison `resolveShelf` uses to wake a snoozed thread early, so the
 * two can never disagree about whether a thread was disturbed.
 *
 * GitHub movement does not appear here. Both wake paths clear the ladder
 * outright when a pull request moves, because by then the thread is back in
 * the inbox with an agent turn attached and the next snooze is plainly a new
 * decision.
 */
export function nextLadderStep(inputs: QuickSnoozeInputs): { step: number; reset: boolean } {
  const { previousStep, lastSnoozedAt, latestAttentionAt } = inputs;
  if (previousStep === null || lastSnoozedAt === null) return { step: 0, reset: false };
  if (latestAttentionAt > lastSnoozedAt) return { step: 0, reset: true };
  return { step: Math.min(previousStep + 1, SNOOZE_LADDER_DAYS.length - 1), reset: false };
}

export function planQuickSnooze(inputs: QuickSnoozeInputs): QuickSnoozePlan {
  const { step, reset } = nextLadderStep(inputs);
  const days = ladderDays(step);

  const base = new Date(inputs.now);
  let target = atHour(base, MORNING_HOUR, days);

  // The weekend shift, and the reason Friday behaves the way it does: one day
  // from Friday is Saturday, one day from Saturday is Sunday, and both walk
  // forward to the same Monday. It is one rule, not three special cases, so a
  // three-day snooze landing on a Sunday moves too.
  let shiftedOffWeekend = false;
  if (inputs.weekdayOnlyProject && isWeekend(target)) {
    shiftedOffWeekend = true;
    while (isWeekend(target)) target = atHour(target, MORNING_HOUR, 1);
  }

  return {
    snoozedUntil: target.getTime(),
    step,
    ladderDays: days,
    shiftedOffWeekend,
    reset,
  };
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * What the button promises, in the words the wake time deserves.
 *
 * A shifted or short wake is named by its day, because "until Monday" is what
 * makes the weekend rule legible the first time it fires. Past a week the day
 * name stops helping and the duration takes over.
 */
export function quickSnoozeLabel(plan: QuickSnoozePlan, now: number): string {
  const target = new Date(plan.snoozedUntil);
  const elapsedDays = Math.round((plan.snoozedUntil - atHour(new Date(now), MORNING_HOUR).getTime()) / (24 * 60 * 60 * 1000));
  if (elapsedDays <= 1) return "Snooze until tomorrow";
  if (elapsedDays <= 6) return `Snooze until ${WEEKDAY_NAMES[target.getDay()]}`;
  return `Snooze for ${elapsedDays} days`;
}
