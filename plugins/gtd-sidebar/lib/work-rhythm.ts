/**
 * Which projects you only touch on working days, inferred from your own
 * turn history.
 *
 * The point is one decision: when a snooze would land on a Saturday, does that
 * thread have any chance of being looked at? For a project you genuinely work
 * on at weekends the answer is yes and the snooze should stand. For a work
 * project it is no, and the thread would just sit there being ignored until
 * Monday — so the snooze may as well say Monday.
 *
 * Counting the raw weekend share of turns gets this wrong in both
 * directions. A project with five turns, none of them on a weekend, is not
 * evidence of anything: two sevenths of days are weekend days, so a run that
 * short misses them by chance more often than not. And a single Saturday
 * binge on a project you otherwise touch every weekday would swamp weeks of
 * weekday work, because turns inside one sitting are not independent
 * samples of "do I work at weekends" — they are one sample, repeated.
 *
 * So: cap each day's contribution, model each rate as Poisson with a Gamma
 * prior, and compare the two posterior means. The prior is what makes a thin
 * history say "no opinion" instead of "definitely a work project", and the
 * cap is what stops one long Sunday from arguing the opposite.
 */

/** Turns past this many on one day stop counting: one sitting, one sample. */
const DAILY_TURN_CAP = 8;

/** How far back to look. Long enough for several weekends, short enough that
 * a project whose rhythm changed is not held to what it was in the spring. */
const WINDOW_DAYS = 42;

/**
 * Gamma(shape, rate) prior on both activity rates, as turns per day.
 *
 * Mean `1/7` — one turn a week — with the weight of a week of observation.
 * Weak enough that a month of real history dominates it, strong enough that a
 * project with two weekdays of history has no opinion attached to it.
 */
const PRIOR_SHAPE = 1;
const PRIOR_EXPOSURE_DAYS = 7;

/**
 * Weekend attention below this fraction of weekday attention means a snooze
 * that lands at the weekend is a snooze into the void. Half is deliberately
 * lenient: the cost of being wrong is a thread coming back Monday instead of
 * Saturday, and the user can always wake it.
 */
const WEEKDAY_ONLY_RATIO = 0.5;

/**
 * Evidence floors. Without these the prior alone would classify a project
 * created on a Tuesday, because no weekend has had the chance to happen yet.
 * A project stays unclassified — and therefore snoozes literally — until its
 * history has actually spanned some weekends.
 */
const MIN_WINDOW_DAYS = 14;
const MIN_CAPPED_TURNS = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProjectRhythm {
  /** True when a weekend snooze on this project should move to Monday. */
  weekdayOnly: boolean;
  /** Posterior weekend rate as a fraction of the weekday rate. */
  weekendRatio: number;
  /** Capped turn counts the verdict rests on, for display and debugging. */
  weekendTurns: number;
  weekdayTurns: number;
  /** Days of history the window actually covered. */
  observedDays: number;
}

/** Local Saturday or Sunday. Local, because a snooze is a local-calendar
 * promise: 09:00 means 09:00 where the user is, not in UTC. */
export function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/** Local midnight-anchored day key, so turns group by the day the user
 * experienced rather than by a UTC boundary that falls mid-evening. */
function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Classify one project from the timestamps of the turns you sent in it.
 *
 * Timestamps may arrive in any order and may reach outside the window; both
 * are filtered here rather than at every call site.
 */
export function classifyProjectRhythm(
  turnTimestamps: readonly number[],
  now: number,
): ProjectRhythm {
  const windowStart = now - WINDOW_DAYS * DAY_MS;
  const inWindow = turnTimestamps.filter((at) => at > windowStart && at <= now);

  const unclassified: ProjectRhythm = {
    weekdayOnly: false,
    weekendRatio: Number.NaN,
    weekendTurns: 0,
    weekdayTurns: 0,
    observedDays: 0,
  };
  if (inWindow.length === 0) return unclassified;

  // Per local day, so the cap can apply before anything is summed.
  const perDay = new Map<string, { weekend: boolean; count: number }>();
  for (const at of inWindow) {
    const key = localDayKey(at);
    const existing = perDay.get(key);
    if (existing === undefined) {
      perDay.set(key, { weekend: isWeekend(new Date(at)), count: 1 });
    } else {
      existing.count += 1;
    }
  }

  let weekendTurns = 0;
  let weekdayTurns = 0;
  for (const { weekend, count } of perDay.values()) {
    const capped = Math.min(count, DAILY_TURN_CAP);
    if (weekend) weekendTurns += capped;
    else weekdayTurns += capped;
  }

  // Exposure runs from the first turn in the window, not from the window's
  // own edge: a project that started last Tuesday has not had six weeks of
  // chances to show a weekend, and pretending otherwise would count silence
  // that never had the opportunity to be noise.
  const earliest = Math.min(...inWindow);
  const { weekendDays, weekdayDays } = countDaysBetween(earliest, now);
  const observedDays = weekendDays + weekdayDays;

  if (observedDays < MIN_WINDOW_DAYS) return { ...unclassified, weekendTurns, weekdayTurns, observedDays };
  if (weekendTurns + weekdayTurns < MIN_CAPPED_TURNS) {
    return { ...unclassified, weekendTurns, weekdayTurns, observedDays };
  }

  const weekendRate = (PRIOR_SHAPE + weekendTurns) / (PRIOR_EXPOSURE_DAYS + weekendDays);
  const weekdayRate = (PRIOR_SHAPE + weekdayTurns) / (PRIOR_EXPOSURE_DAYS + weekdayDays);
  const weekendRatio = weekendRate / weekdayRate;

  return {
    weekdayOnly: weekendRatio < WEEKDAY_ONLY_RATIO,
    weekendRatio,
    weekendTurns,
    weekdayTurns,
    observedDays,
  };
}

/**
 * Weekend and weekday days covered by a span, counted as local calendar days
 * rather than divided out of a duration: across a daylight-saving change a day
 * is 23 or 25 hours long, and dividing would drift a day every few months.
 */
function countDaysBetween(from: number, to: number): { weekendDays: number; weekdayDays: number } {
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);

  let weekendDays = 0;
  let weekdayDays = 0;
  // Inclusive of both ends: a project whose only turn is today has been
  // observed for one day, not zero.
  while (cursor.getTime() <= end.getTime()) {
    if (isWeekend(cursor)) weekendDays += 1;
    else weekdayDays += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return { weekendDays, weekdayDays };
}
