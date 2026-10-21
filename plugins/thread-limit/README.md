# Thread limit

Keep bb from starting more agent threads than your machines can handle. When a
limit is reached, new turns wait in line and start as soon as a running thread
goes idle.

This is a copy of bb's built-in **Concurrency limit** plugin with two
additions: a host that is already busy holds new turns too, and a **pinned**
thread is never held. Its turns still run on the same
machines, so they still count toward every limit and hold back other threads.
Run this plugin instead of the built-in one, not beside it: with both enabled,
the built-in one still holds pinned threads.

## What you get

- An automatic limit for each host: one running thread per available processor.
- A per-host override. Set a fixed number, or set it back to `auto`.
- An overall limit across all hosts, or `unlimited`.
- A Settings section that lists every host with its capacity, its automatic
  limit, and its effective limit.
- Load limits: a host holds new turns while its CPU is at least 85% busy or at
  most 10% of its memory is free, even with threads to spare. Both thresholds
  can be changed or turned off.
- Pinning as a way through: pin a thread and its next turn starts even when a
  limit is reached. In GTD Sidebar, every row has a pin button on hover.

## How it works

Before bb sends a message to an idle thread, the plugin counts the threads that
are running. If the count meets the limit for that host, or the overall limit,
the message waits and the thread shows why, unless the thread is pinned. A
message to a thread that is already running is not held. When a thread goes
idle, fails, or is archived, or when a thread is pinned or unpinned, the line
is checked again, so pinning a waiting thread starts its turn.

## Load limits

Every 10 seconds the plugin asks each connected host for its load: how busy
its CPU was since the last check, how much memory the OS counts as available
(macOS memory pressure, Linux `MemAvailable`), and its load average. A send
reads the latest answer, so checking load never slows a message down.

A host at or over a threshold holds new turns, with a reason like
`Mac Studio is busy (CPU 92% busy)`. It lets them go once its CPU drops 15
points below the CPU threshold and its free memory rises 5 points above the
memory threshold, so a host that hovers at the line does not flip back and
forth. A host whose load has not been read for 30 seconds holds nothing for
load; the thread limits still apply.

Load only gates turns that are about to start. Work already running, such as
the builds and tests an agent runs mid-turn, keeps running, and a burst of
turns can start before the load catches up with them; the thread limits stay
the hard cap.

## For agents and scripts

- `bb thread-limit status` shows the effective limits.
- `bb thread-limit global unlimited|<limit>` sets the overall limit.
- `bb thread-limit host <host-id> auto|<limit>` sets one host.
- `bb thread-limit load` shows the load limits and each host's latest load.
- `bb thread-limit load cpu <percent>|off` and `bb thread-limit load memory <percent>|off`
  set the load limits.

Add `--json` for machine-readable output. Limits go from 0 to 10000. A limit of
0 holds every new turn in that scope, pinned threads excepted. Load limits are
whole percents from 1 to 100.

## Switching from the built-in plugin

Limits do not carry over. Read them with `bb concurrency-limit status`, set the
same ones with `bb thread-limit`, then `bb plugin disable concurrency-limit`.

## Credits

Copied from bb's `concurrency-limit` plugin
([get-bb/bb](https://github.com/get-bb/bb), MIT, Copyright (c) 2026 Michael
Yong) at `desktop-v0.46.1`.
