/**
 * How long to stop spending REST after GitHub says we are going too fast.
 *
 * GitHub does not say when a secondary rate limit ends — there is no reset
 * timestamp in the body the way there is for the primary budget, and the
 * primary one is no help because it is not the budget that ran out. So the
 * wait is guessed, and the guess escalates: GitHub's own guidance is to wait
 * at least a minute and back off from there if it happens again.
 *
 * Escalation is what makes this a fix rather than a slower version of the same
 * loop. A single fixed pause would expire into another burst, be refused
 * again, and pause again, forever — quieter than before, but never recovering.
 */

const MINUTE_MS = 60_000;

/** Consecutive-refusal waits, then the cap. */
export const REST_BACKOFF_MS: readonly number[] = [
  MINUTE_MS,
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
];

export interface RestBudgetState {
  /** No REST until this moment; null once it is free to spend again. */
  skipUntilMs: number | null;
  /** Refusals in a row, which is what picks the wait above. */
  strikes: number;
}

export const FRESH_REST_BUDGET: RestBudgetState = { skipUntilMs: null, strikes: 0 };

export function backoffMs(strikes: number): number {
  const index = Math.min(Math.max(strikes, 1), REST_BACKOFF_MS.length) - 1;
  return REST_BACKOFF_MS[index];
}

/** A refusal: take the next step up the ladder. */
export function afterRefusal(state: RestBudgetState, now: number): RestBudgetState {
  const strikes = Math.min(state.strikes + 1, REST_BACKOFF_MS.length);
  return { skipUntilMs: now + backoffMs(strikes), strikes };
}

/**
 * A call that went through: back to the bottom.
 *
 * Keyed on success rather than on the pause expiring, so a limit that is still
 * in force when the pause runs out climbs again on the next refusal instead of
 * starting over.
 */
export function afterSuccess(state: RestBudgetState): RestBudgetState {
  return state.strikes === 0 && state.skipUntilMs === null ? state : FRESH_REST_BUDGET;
}

export function isPaused(state: RestBudgetState, now: number): boolean {
  return state.skipUntilMs !== null && state.skipUntilMs > now;
}

/** Persisted state is only as good as what wrote it. */
export function parseRestBudget(value: unknown): RestBudgetState {
  if (typeof value !== "object" || value === null) return FRESH_REST_BUDGET;
  const record = value as { skipUntilMs?: unknown; strikes?: unknown };
  return {
    skipUntilMs: typeof record.skipUntilMs === "number" ? record.skipUntilMs : null,
    strikes: typeof record.strikes === "number" && record.strikes >= 0 ? record.strikes : 0,
  };
}
