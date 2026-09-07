import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyProjectRhythm, isWeekend } from "../lib/work-rhythm.ts";

const DAY = 24 * 60 * 60 * 1000;

function localNoon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
}

/** A Wednesday, so a window walked backwards covers whole weeks. */
const NOW = localNoon(2026, 9, 9);

/**
 * `perDay` prompts on every day in the last `spanDays` that matches `pick`.
 * Building histories by predicate keeps the tests about the rhythm rather
 * than about a list of dates nobody can check by eye.
 */
function history(spanDays: number, pick: (date: Date) => boolean, perDay: number): number[] {
  const stamps: number[] = [];
  for (let back = spanDays - 1; back >= 0; back--) {
    const at = NOW - back * DAY;
    if (!pick(new Date(at))) continue;
    for (let n = 0; n < perDay; n++) stamps.push(at + n * 1000);
  }
  return stamps;
}

const weekdays = (date: Date) => !isWeekend(date);
const everyDay = () => true;

describe("classifyProjectRhythm", () => {
  it("calls a month of weekday-only work a weekday-only project", () => {
    const rhythm = classifyProjectRhythm(history(28, weekdays, 4), NOW);
    assert.equal(rhythm.weekdayOnly, true);
    assert.ok(rhythm.weekendRatio < 0.5, `ratio ${rhythm.weekendRatio}`);
  });

  it("leaves a project worked on every day alone", () => {
    const rhythm = classifyProjectRhythm(history(28, everyDay, 4), NOW);
    assert.equal(rhythm.weekdayOnly, false);
  });

  // The reason the prior exists. Two sevenths of days are weekend days, so a
  // handful of weekday prompts is what a coin flip looks like, not evidence.
  it("refuses to classify a project with only a few days of history", () => {
    const rhythm = classifyProjectRhythm(history(4, weekdays, 3), NOW);
    assert.equal(rhythm.weekdayOnly, false);
    assert.ok(Number.isNaN(rhythm.weekendRatio));
  });

  it("refuses to classify a long but nearly empty history", () => {
    const stamps = [NOW - 30 * DAY, NOW - 20 * DAY, NOW - 3 * DAY];
    const rhythm = classifyProjectRhythm(stamps, NOW);
    assert.equal(rhythm.weekdayOnly, false);
    assert.ok(Number.isNaN(rhythm.weekendRatio));
  });

  // The reason the cap exists. One long Sunday is one decision to work at the
  // weekend, not eighty of them, and it must not outvote a month of weekdays.
  it("does not let a single weekend binge outweigh a month of weekdays", () => {
    const weekdayWork = history(28, weekdays, 4);
    const oneLongSunday = Array.from({ length: 80 }, (_, n) => NOW - 3 * DAY + n * 1000);
    const sunday = new Date(NOW - 3 * DAY);
    assert.equal(sunday.getDay(), 0);
    const rhythm = classifyProjectRhythm([...weekdayWork, ...oneLongSunday], NOW);
    assert.equal(rhythm.weekdayOnly, true);
  });

  // Without the cap the same history flips, which is what makes the cap load
  // bearing rather than decorative.
  it("would flip on that binge if every prompt counted", () => {
    const weekdayWork = history(28, weekdays, 4);
    const manySundays = history(28, (date) => date.getDay() === 0, 80);
    const rhythm = classifyProjectRhythm([...weekdayWork, ...manySundays], NOW);
    assert.equal(rhythm.weekdayOnly, false);
  });

  it("ignores prompts older than the window", () => {
    const ancient = history(28, everyDay, 4).map((at) => at - 200 * DAY);
    const rhythm = classifyProjectRhythm(ancient, NOW);
    assert.equal(rhythm.observedDays, 0);
    assert.equal(rhythm.weekdayOnly, false);
  });

  it("reports the counts its verdict rests on", () => {
    const rhythm = classifyProjectRhythm(history(28, weekdays, 4), NOW);
    assert.equal(rhythm.weekendTurns, 0);
    assert.ok(rhythm.weekdayTurns > 0);
    assert.ok(rhythm.observedDays >= 14);
  });
});

/**
 * The shapes these thresholds were actually tuned against: real per-project
 * counts, capped, from six weeks of prompt history. They are the regression
 * that says a later change to the prior or the ratio still sorts the same
 * projects the same way.
 */
describe("classifyProjectRhythm on observed project shapes", () => {
  const cases: Array<{ name: string; weekdayPerDay: number; weekendPerDay: number; weekdayOnly: boolean }> = [
    // Weekday-only in practice: a steady weekday cadence, nothing at weekends.
    { name: "helix-website shaped", weekdayPerDay: 6, weekendPerDay: 0, weekdayOnly: true },
    { name: "skills shaped", weekdayPerDay: 4, weekendPerDay: 0, weekdayOnly: true },
    // The dominant project, worked on at weekends as well, just less.
    { name: "slicc shaped", weekdayPerDay: 8, weekendPerDay: 6, weekdayOnly: false },
    // Weekend hobby projects, which must never be shifted to Monday.
    { name: "elecrow-backup shaped", weekdayPerDay: 1, weekendPerDay: 8, weekdayOnly: false },
  ];

  for (const { name, weekdayPerDay, weekendPerDay, weekdayOnly } of cases) {
    it(`sorts a ${name} project`, () => {
      const stamps = [
        ...history(28, weekdays, weekdayPerDay),
        ...history(28, (date) => isWeekend(date), weekendPerDay),
      ];
      assert.equal(classifyProjectRhythm(stamps, NOW).weekdayOnly, weekdayOnly);
    });
  }
});
