/**
 * Telling "the plugin is being replaced" apart from "this failed".
 *
 * A reload does not wait for in-flight work. Whatever was mid-request when it
 * lands fails — the abort signal fires on child processes, and any call that
 * reaches the host afterwards is refused because the handle belongs to a
 * generation that no longer exists. None of that is a fault worth a warning,
 * and reported as one it is actively misleading: it names a pull request, or a
 * repository, or an environment, and says it failed, when the only thing that
 * happened is that the user reloaded the plugin.
 *
 * Cancellation is recognised rather than prevented, because it cannot be
 * prevented — an in-flight `await` has nowhere to put a "never mind".
 */

/** The name the host gives the error it throws for a handle from a previous
 * generation. Only the testing entrypoint exports the class, but the name is
 * documented as the same one the real host uses. */
const STALE_HANDLE_ERROR = "PluginContextStaleError";

export function isReloadCancellation(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === STALE_HANDLE_ERROR) return true;
    if (error.name === "AbortError") return true;
    // Node's own abort carries the code rather than the name.
    if ((error as NodeJS.ErrnoException).code === "ABORT_ERR") return true;
  }
  // A rejection that crossed a process or RPC boundary arrives as a string or
  // a plain object, with the name folded into the message. Matching that text
  // is the only thing left, so it is kept narrow and paired with the checks
  // above rather than replacing them.
  return String(error).includes(STALE_HANDLE_ERROR);
}
