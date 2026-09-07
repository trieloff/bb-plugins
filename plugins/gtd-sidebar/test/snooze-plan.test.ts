import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ladderDays,
  nextLadderStep,
  planQuickSnooze,
  quickSnoozeLabel,
  SNOOZE_LADDER_DAYS,
} from "../lib/snooze-plan.ts";

const DAY = 24 * 60 * 60 * 1000;

/** Local noon on a given date, so a test never straddles a day boundary. */
function localNoon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
}

function wakeDate(snoozedUntil: number): Date {
  return new Date(snoozedUntil);
}

const FRESH = {
  previousStep: null,
  lastSnoozedAt: null,
  latestAttentionAt: 0,
  weekdayOnlyProject: false,
} as const;

describe("nextLadderStep", () => {
  it("starts a thread with no snooze history at the bottom", () => {
    assert.deepEqual(nextLadderStep({ now: localNoon(2026, 9, 8), ...FRESH }), {
      step: 0,
      reset: false,
    });
  });

  it("climbs when the previous snooze elapsed with nothing happening", () => {
    const snoozedAt = localNoon(2026, 9, 7);
    const now = localNoon(2026, 9, 8);
    assert.deepEqual(
      nextLadderStep({
        now,
        previousStep: 0,
        lastSnoozedAt: snoozedAt,
        // Attention older than the snooze: the thread came back on its timer.
        latestAttentionAt: snoozedAt - DAY,
        weekdayOnlyProject: false,
      }),
      { step: 1, reset: false },
    );
  });

  it("resets when the thread saw attention after the snooze was set", () => {
    const snoozedAt = localNoon(2026, 9, 7);
    assert.deepEqual(
      nextLadderStep({
        now: localNoon(2026, 9, 8),
        previousStep: 4,
        lastSnoozedAt: snoozedAt,
        latestAttentionAt: snoozedAt + 60_000,
        weekdayOnlyProject: false,
      }),
      { step: 0, reset: true },
    );
  });

  it("holds at the top rung rather than running past the cap", () => {
    const snoozedAt = localNoon(2026, 9, 7);
    const top = SNOOZE_LADDER_DAYS.length - 1;
    assert.deepEqual(
      nextLadderStep({
        now: localNoon(2026, 9, 8),
        previousStep: top,
        lastSnoozedAt: snoozedAt,
        latestAttentionAt: 0,
        weekdayOnlyProject: false,
      }),
      { step: top, reset: false },
    );
  });
});

describe("ladderDays", () => {
  it("runs the Fibonacci rungs and caps at a month", () => {
    assert.deepEqual(
      SNOOZE_LADDER_DAYS.map((_, step) => ladderDays(step)),
      [1, 2, 3, 5, 8, 13, 21, 30],
    );
    assert.equal(ladderDays(99), 30);
    assert.equal(ladderDays(-1), 1);
  });
});

describe("planQuickSnooze", () => {
  it("wakes at 09:00 the next day for a plain first snooze", () => {
    // Tuesday.
    const plan = planQuickSnooze({ now: localNoon(2026, 9, 8), ...FRESH });
    const wake = wakeDate(plan.snoozedUntil);
    assert.equal(wake.getDate(), 9);
    assert.equal(wake.getHours(), 9);
    assert.equal(plan.shiftedOffWeekend, false);
  });

  // The rule the whole weekend half of this feature exists for.
  it("sends a Friday snooze on a weekday-only project to Monday", () => {
    // 2026-09-11 is a Friday.
    const now = localNoon(2026, 9, 11);
    assert.equal(new Date(now).getDay(), 5);
    const plan = planQuickSnooze({ ...FRESH, now, weekdayOnlyProject: true });
    const wake = wakeDate(plan.snoozedUntil);
    assert.equal(wake.getDay(), 1);
    assert.equal(wake.getDate(), 14);
    assert.equal(wake.getHours(), 9);
    assert.equal(plan.shiftedOffWeekend, true);
  });

  it("sends a Saturday snooze on a weekday-only project to Monday too", () => {
    const now = localNoon(2026, 9, 12);
    assert.equal(new Date(now).getDay(), 6);
    const plan = planQuickSnooze({ ...FRESH, now, weekdayOnlyProject: true });
    assert.equal(wakeDate(plan.snoozedUntil).getDay(), 1);
    assert.equal(wakeDate(plan.snoozedUntil).getDate(), 14);
  });

  // A project you demonstrably work on at weekends is left alone: the
  // inference is what earns the shift, and without it the button is literal.
  it("leaves a Friday snooze on a weekend-active project at Saturday", () => {
    const plan = planQuickSnooze({ ...FRESH, now: localNoon(2026, 9, 11) });
    const wake = wakeDate(plan.snoozedUntil);
    assert.equal(wake.getDay(), 6);
    assert.equal(plan.shiftedOffWeekend, false);
  });

  it("shifts a longer rung that happens to land on a weekend", () => {
    // Tuesday + 3 days (rung 2) is Friday; + 5 days (rung 3) is Sunday.
    const now = localNoon(2026, 9, 8);
    const snoozedAt = now - DAY;
    const plan = planQuickSnooze({
      now,
      previousStep: 2,
      lastSnoozedAt: snoozedAt,
      latestAttentionAt: 0,
      weekdayOnlyProject: true,
    });
    assert.equal(plan.ladderDays, 5);
    assert.equal(wakeDate(plan.snoozedUntil).getDay(), 1);
    assert.equal(plan.shiftedOffWeekend, true);
  });

  it("climbs the ladder across repeated untouched snoozes", () => {
    let previousStep: number | null = null;
    let lastSnoozedAt: number | null = null;
    const seen: number[] = [];
    for (let day = 1; day <= 6; day++) {
      const now = localNoon(2026, 9, 7) + day * DAY;
      const plan = planQuickSnooze({
        now,
        previousStep,
        lastSnoozedAt,
        latestAttentionAt: 0,
        weekdayOnlyProject: false,
      });
      seen.push(plan.ladderDays);
      previousStep = plan.step;
      lastSnoozedAt = now;
    }
    assert.deepEqual(seen, [1, 2, 3, 5, 8, 13]);
  });
});

describe("quickSnoozeLabel", () => {
  it("names tomorrow, then the weekday, then the span", () => {
    const now = localNoon(2026, 9, 8);
    const plan = (days: number, step: number) =>
      planQuickSnooze({
        now,
        previousStep: step === 0 ? null : step - 1,
        lastSnoozedAt: step === 0 ? null : now - DAY,
        latestAttentionAt: 0,
        weekdayOnlyProject: false,
      });
    assert.equal(quickSnoozeLabel(plan(1, 0), now), "Snooze until tomorrow");
    // Rung 2 is three days out: Friday.
    assert.equal(quickSnoozeLabel(plan(3, 2), now), "Snooze until Friday");
    // Rung 4 is eight days out, past where a weekday name still helps.
    assert.equal(quickSnoozeLabel(plan(8, 4), now), "Snooze for 8 days");
  });
});
