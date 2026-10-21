import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SELF_SNOOZE_MINUTES,
  SELF_SNOOZE_SETTLE_MS,
  selfSnoozeStartsAt,
  selfSnoozeWake,
} from "../lib/self-snooze.ts";
import { resolveShelf } from "../lib/lifecycle.ts";

const NOW = Date.parse("2026-10-21T12:00:00Z");

describe("selfSnoozeWake", () => {
  it("wakes after the minutes given", () => {
    assert.deepEqual(selfSnoozeWake({ minutes: 90 }, NOW), {
      kind: "at",
      snoozedUntil: NOW + 90 * 60_000,
    });
  });

  it("wakes at the time given, with its offset honoured", () => {
    assert.deepEqual(selfSnoozeWake({ until: "2026-10-22T09:00:00+02:00" }, NOW), {
      kind: "at",
      snoozedUntil: Date.parse("2026-10-22T07:00:00Z"),
    });
  });

  it("leaves the wake time to the sidebar when given neither", () => {
    assert.deepEqual(selfSnoozeWake({}, NOW), { kind: "adaptive" });
    assert.deepEqual(selfSnoozeWake({ pullRequestUrl: "https://github.com/a/b/pull/1" }, NOW), {
      kind: "adaptive",
    });
  });

  it("refuses both at once, an unreadable time, a past time, and more than 30 days", () => {
    const refused = (input: Parameters<typeof selfSnoozeWake>[0]) =>
      selfSnoozeWake(input, NOW).kind === "invalid";
    assert.ok(refused({ until: "2026-10-22T09:00:00Z", minutes: 5 }));
    assert.ok(refused({ until: "next tuesday" }));
    assert.ok(refused({ until: "2026-10-21T11:00:00Z" }));
    assert.ok(
      refused({ until: new Date(NOW + (MAX_SELF_SNOOZE_MINUTES + 1) * 60_000).toISOString() }),
    );
  });
});

describe("selfSnoozeStartsAt", () => {
  it("starts the snooze after the turn's last activity, so that activity cannot wake it", () => {
    const turnEnd = NOW + 30_000;
    const lastMessage = NOW + 31_000;
    const startsAt = selfSnoozeStartsAt(turnEnd, lastMessage);
    assert.equal(startsAt, lastMessage + SELF_SNOOZE_SETTLE_MS);
    const row = { threadId: "t", snoozedUntil: NOW + 3_600_000, snoozedAt: startsAt };
    const quiet = {
      hasPendingInteraction: false,
      isWorking: false,
      latestAttentionAt: lastMessage,
    };
    assert.equal(resolveShelf(row, quiet, turnEnd + 5_000), "snoozed");
    // Anything after that, such as the user writing, still wakes it.
    assert.equal(
      resolveShelf(row, { ...quiet, latestAttentionAt: startsAt + 1 }, turnEnd + 5_000),
      "active",
    );
  });
});
