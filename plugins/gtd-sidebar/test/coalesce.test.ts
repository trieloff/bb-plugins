import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCoalescer } from "../lib/coalesce.ts";

describe("createCoalescer", () => {
  it("shares one in-flight load across concurrent askers", async () => {
    const coalescer = createCoalescer<number>(0);
    let loads = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = async () => {
      loads += 1;
      await gate;
      return 7;
    };
    const all = Promise.all([
      coalescer.get("acme/app", load),
      coalescer.get("acme/app", load),
      coalescer.get("acme/app", load),
    ]);
    release();
    assert.deepEqual(await all, [7, 7, 7]);
    assert.equal(loads, 1);
  });

  it("keys by request, so two repositories are two loads", async () => {
    const coalescer = createCoalescer<string>(1_000, () => 0);
    const seen: string[] = [];
    const load = (key: string) => async () => {
      seen.push(key);
      return key;
    };
    await coalescer.get("acme/app", load("acme/app"));
    await coalescer.get("acme/other", load("acme/other"));
    assert.deepEqual(seen, ["acme/app", "acme/other"]);
  });

  it("serves a settled answer until the TTL is up", async () => {
    let now = 0;
    const coalescer = createCoalescer<number>(1_000, () => now);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return loads;
    };
    assert.equal(await coalescer.get("k", load), 1);
    now = 999;
    // The duplicates that in-flight sharing misses are the near-misses: a
    // reconcile a second after the last one, not one during it.
    assert.equal(await coalescer.get("k", load), 1);
    now = 1_000;
    assert.equal(await coalescer.get("k", load), 2);
    assert.equal(loads, 2);
  });

  it("does not cache a failure, so the next tick may try again", async () => {
    const coalescer = createCoalescer<number>(60_000, () => 0);
    let attempts = 0;
    const load = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("gh api exited 1");
      return 42;
    };
    await assert.rejects(coalescer.get("k", load), /exited 1/);
    assert.equal(await coalescer.get("k", load), 42);
  });

  it("takes an answer bought elsewhere, and drops one an event invalidated", async () => {
    let now = 0;
    const coalescer = createCoalescer<string>(60_000, () => now);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return "fetched";
    };
    // A webhook resolved this pull; the reconcile behind it must not re-buy it.
    coalescer.put("k", "from webhook");
    assert.equal(await coalescer.get("k", load), "from webhook");
    assert.equal(loads, 0);
    coalescer.forget("k");
    assert.equal(await coalescer.get("k", load), "fetched");
    assert.equal(loads, 1);
  });

  it("peeks a live answer without starting a load", () => {
    const coalescer = createCoalescer<string>(60_000, () => 0);
    assert.equal(coalescer.peek("k"), undefined);
    coalescer.put("k", "cached");
    assert.equal(coalescer.peek("k"), "cached");
  });
});
