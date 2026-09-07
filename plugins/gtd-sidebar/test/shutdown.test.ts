import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isReloadCancellation } from "../lib/shutdown.ts";

function named(name: string, message = "boom"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("isReloadCancellation", () => {
  it("recognises the host's stale-handle error", () => {
    assert.equal(isReloadCancellation(named("PluginContextStaleError")), true);
  });

  it("recognises an abort by name and by code", () => {
    assert.equal(isReloadCancellation(named("AbortError")), true);
    const coded = new Error("aborted") as NodeJS.ErrnoException;
    coded.code = "ABORT_ERR";
    assert.equal(isReloadCancellation(coded), true);
  });

  // Rejections that cross an RPC boundary lose their prototype and arrive as
  // text, which is how this one reached the log in the first place.
  it("recognises a stale-handle rejection that arrived as text", () => {
    assert.equal(
      isReloadCancellation(
        'PluginContextStaleError: plugin "gtd-sidebar" used a stale API handle',
      ),
      true,
    );
  });

  // The half that matters: a real failure during a reload-free moment must
  // still be reported, or this fix would hide the bugs it was meant to expose.
  it("leaves real failures alone", () => {
    assert.equal(isReloadCancellation(new Error("gh: Bad Gateway (HTTP 502)")), false);
    assert.equal(isReloadCancellation(named("TypeError")), false);
    assert.equal(isReloadCancellation("connection reset"), false);
    assert.equal(isReloadCancellation(undefined), false);
    assert.equal(isReloadCancellation(null), false);
  });
});
