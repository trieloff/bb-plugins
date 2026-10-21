---
name: thread-limit
description: "Inspect or change global and per-host limits on concurrently running BB threads, enforced by the Thread limit plugin."
---

# Thread limits

Use `bb thread-limit status --json` to inspect current limits.

```sh
bb thread-limit global [unlimited|<limit>] [--json]
bb thread-limit host <host-id> [auto|<limit>] [--json]
bb thread-limit load [cpu|memory <percent|off>] [--json]
```

The overall limit is unlimited by default. Automatic host limits allow one
thread per available processor; `auto` returns a host override to that
default. A limit of `0` pauses new work. Resolve the host with
`bb machine list` before changing a host limit. Omit the value to inspect it;
change limits only for the requested scope and verify the resulting status.

A host also holds new turns while it is busy: by default while its CPU is at
least 85% busy or at most 10% of its memory is free. `bb thread-limit load`
prints each host's latest load; a held message names the host and the reason.

A pinned thread is never held by these limits, but its running turns still
count toward them. To let one thread through, pin it (`bb thread pin <id>`)
rather than raising a limit.
