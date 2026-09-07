import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  afterRefusal,
  afterSuccess,
  backoffMs,
  FRESH_REST_BUDGET,
  isPaused,
  parseRestBudget,
  REST_BACKOFF_MS,
} from "../lib/rest-budget.ts";
import { isRateLimited, githubHttpStatus } from "../lib/gh-cli.ts";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

describe("isRateLimited", () => {
  // The exact text GitHub returned while `rate_limit` still read 5000/5000.
  it("recognises the secondary limit that the budget check cannot see", () => {
    assert.equal(
      isRateLimited({
        stderr:
          "gh: API rate limit exceeded for user ID 39613. If you reach out to GitHub Support " +
          "for help, please include the request ID F8EE (HTTP 403)",
      }),
      true,
    );
  });

  it("recognises a 429 and the abuse-detection wording", () => {
    assert.equal(isRateLimited({ stderr: "gh: Too many requests (HTTP 429)" }), true);
    assert.equal(
      isRateLimited({ stderr: "gh: You have triggered an abuse detection mechanism (HTTP 403)" }),
      true,
    );
  });

  // The half that keeps this from pausing everything for the wrong reason: a
  // repository you simply cannot read also answers 403.
  it("leaves a plain permission refusal alone", () => {
    assert.equal(isRateLimited({ stderr: "gh: Must have admin rights (HTTP 403)" }), false);
    assert.equal(isRateLimited({ stderr: "gh: Not Found (HTTP 404)" }), false);
    assert.equal(isRateLimited({ stderr: "gh: Bad Gateway (HTTP 502)" }), false);
    assert.equal(isRateLimited({ stderr: "" }), false);
  });

  // "rate limit" in the body of a non-4xx answer must not pause anything.
  it("needs the status as well as the wording", () => {
    assert.equal(isRateLimited({ stderr: "note: rate limit docs (HTTP 200)" }), false);
    assert.equal(isRateLimited({ stderr: "rate limit exceeded" }), false);
  });
});

describe("githubHttpStatus", () => {
  it("reads the status out of a long message", () => {
    assert.equal(githubHttpStatus("gh: API rate limit exceeded ... timestamp (HTTP 403)"), 403);
  });
});

describe("REST backoff", () => {
  it("escalates a minute, five, fifteen, thirty, then holds", () => {
    assert.deepEqual(
      REST_BACKOFF_MS.map((_, i) => backoffMs(i + 1)),
      [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE],
    );
    assert.equal(backoffMs(99), 30 * MINUTE);
  });

  it("climbs on consecutive refusals", () => {
    let state = FRESH_REST_BUDGET;
    const waits: number[] = [];
    for (let n = 0; n < 6; n++) {
      state = afterRefusal(state, NOW);
      waits.push((state.skipUntilMs ?? 0) - NOW);
    }
    assert.deepEqual(waits, [
      MINUTE,
      5 * MINUTE,
      15 * MINUTE,
      30 * MINUTE,
      30 * MINUTE,
      30 * MINUTE,
    ]);
  });

  it("pauses only until the wait expires", () => {
    const state = afterRefusal(FRESH_REST_BUDGET, NOW);
    assert.equal(isPaused(state, NOW), true);
    assert.equal(isPaused(state, NOW + MINUTE - 1), true);
    assert.equal(isPaused(state, NOW + MINUTE), false);
    assert.equal(isPaused(FRESH_REST_BUDGET, NOW), false);
  });

  // The loop this whole change exists to break: a pause that expires into
  // another burst must climb, not restart at one minute forever.
  it("keeps climbing when the pause expires and GitHub is still refusing", () => {
    let state = afterRefusal(FRESH_REST_BUDGET, NOW);
    state = afterRefusal(state, NOW + MINUTE);
    assert.equal((state.skipUntilMs ?? 0) - (NOW + MINUTE), 5 * MINUTE);
  });

  it("resets only on a call that actually went through", () => {
    const state = afterRefusal(afterRefusal(FRESH_REST_BUDGET, NOW), NOW);
    assert.deepEqual(afterSuccess(state), FRESH_REST_BUDGET);
    // Already clear: the same object back, so nothing re-persists per call.
    assert.equal(afterSuccess(FRESH_REST_BUDGET), FRESH_REST_BUDGET);
  });

  it("survives whatever is actually in the store", () => {
    assert.deepEqual(parseRestBudget(undefined), FRESH_REST_BUDGET);
    assert.deepEqual(parseRestBudget(null), FRESH_REST_BUDGET);
    assert.deepEqual(parseRestBudget("nonsense"), FRESH_REST_BUDGET);
    assert.deepEqual(parseRestBudget({ strikes: -3 }), FRESH_REST_BUDGET);
    assert.deepEqual(parseRestBudget({ skipUntilMs: NOW, strikes: 2 }), {
      skipUntilMs: NOW,
      strikes: 2,
    });
  });
});
