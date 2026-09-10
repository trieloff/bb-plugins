/**
 * One GitHub request per key at a time, and one answer per key per TTL.
 *
 * The sidebar asks the same questions from many places at once. Thirty threads
 * across four repositories all want that repository's pull list; every visible
 * thread wants the REST budget. Each of those was its own `gh` process: one
 * observed hour had the same `repos/<owner>/<repo>/pulls` fired twenty-two
 * times inside a single second, and roughly two hundred `rate_limit` probes,
 * all of them asking a question that had just been answered.
 *
 * In-flight sharing alone is not enough, because the duplicates are not all
 * concurrent. A reconcile runs whenever a thread title changes, so the same
 * list is requested again a second or two after the previous answer landed —
 * too late to share the promise, far too soon for the answer to have moved. So
 * a short TTL on the settled value carries the rest.
 *
 * Failures are deliberately not cached: a thrown load rejects every sharer and
 * leaves the key clean, so the next tick may try again. Only answers are kept.
 */
export interface Coalescer<T> {
  /** The cached answer, the in-flight one, or a new `load()` — in that order. */
  get(key: string, load: () => Promise<T>): Promise<T>;
  /** Record an answer bought elsewhere, so a reader does not buy it again. */
  put(key: string, value: T): void;
  /** Drop a key whose answer an event has just invalidated. */
  forget(key: string): void;
}

export function createCoalescer<T>(
  ttlMs: number,
  now: () => number = Date.now,
): Coalescer<T> {
  const settled = new Map<string, { at: number; value: T }>();
  const inFlight = new Map<string, Promise<T>>();
  return {
    get(key, load) {
      const cached = settled.get(key);
      if (cached !== undefined && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      const started = (async () => {
        const value = await load();
        settled.set(key, { at: now(), value });
        return value;
      })().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, started);
      return started;
    },
    put(key, value) {
      settled.set(key, { at: now(), value });
    },
    forget(key) {
      settled.delete(key);
    },
  };
}
