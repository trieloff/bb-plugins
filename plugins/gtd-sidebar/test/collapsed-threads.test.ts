import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COLLAPSED_THREADS_KEY,
  createCollapsedThreadsStore,
  toggleThreadId,
} from "../lib/collapsed-threads.ts";
import { collapsedThreadsMatch } from "../hooks/use-collapsed-threads.ts";

/** The plugin's kv area, reduced to one map, with every write recorded. */
function fakeKv(initial?: unknown) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set(COLLAPSED_THREADS_KEY, initial);
  const writes: { key: string; value: unknown }[] = [];
  return {
    values,
    writes,
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      // Yield first, as bb's storage does, so overlapping writes interleave.
      await Promise.resolve();
      writes.push({ key, value });
      values.set(key, value);
    },
  };
}

function storeOver(initial?: unknown) {
  const kv = fakeKv(initial);
  return { kv, store: createCollapsedThreadsStore(kv) };
}

describe("toggleThreadId", () => {
  it("adds a missing id and removes a present one, keeping the rest in order", () => {
    assert.deepEqual(toggleThreadId(["a", "b"], "c"), ["a", "b", "c"]);
    assert.deepEqual(toggleThreadId(["a", "b", "c"], "b"), ["a", "c"]);
  });
});

describe("collapsedThreadsMatch", () => {
  it("matches the same ids in any order and nothing else", () => {
    assert.equal(collapsedThreadsMatch(new Set(["a", "b"]), ["b", "a"]), true);
    assert.equal(collapsedThreadsMatch(new Set(["a", "b"]), ["a"]), false);
    assert.equal(collapsedThreadsMatch(new Set(["a"]), ["a", "b"]), false);
    assert.equal(collapsedThreadsMatch(new Set(), []), true);
  });
});

describe("createCollapsedThreadsStore", () => {
  it("lists nothing before the first fold", async () => {
    const { store } = storeOver();
    assert.deepEqual(await store.list(), []);
  });

  it("ignores a stored value that is not a list of ids", async () => {
    assert.deepEqual(await storeOver({ root: true }).store.list(), []);
    assert.deepEqual(await storeOver(["root", 7]).store.list(), ["root"]);
  });

  it("writes each toggle and lists what it wrote", async () => {
    const { kv, store } = storeOver(["root"]);
    assert.deepEqual(await store.toggle("other"), ["root", "other"]);
    assert.deepEqual(await store.toggle("root"), ["other"]);
    assert.deepEqual(await store.list(), ["other"]);
    assert.deepEqual(
      kv.writes.map((write) => [write.key, write.value]),
      [
        [COLLAPSED_THREADS_KEY, ["root", "other"]],
        [COLLAPSED_THREADS_KEY, ["other"]],
      ],
    );
  });

  it("keeps both of two toggles that overlap", async () => {
    const { store } = storeOver([]);
    await Promise.all([store.toggle("a"), store.toggle("b")]);
    assert.deepEqual(await store.list(), ["a", "b"]);
  });

  it("keeps toggling after a write fails", async () => {
    const { kv, store } = storeOver([]);
    const original = kv.set;
    kv.set = async () => {
      throw new Error("storage offline");
    };
    await assert.rejects(store.toggle("a"), /storage offline/);
    kv.set = original;
    assert.deepEqual(await store.toggle("b"), ["b"]);
  });

  it("forgets a deleted thread's fold and writes nothing for an open one", async () => {
    const { kv, store } = storeOver(["gone", "kept"]);
    await store.forget("never-folded");
    assert.equal(kv.writes.length, 0);
    await store.forget("gone");
    assert.deepEqual(await store.list(), ["kept"]);
  });
});
