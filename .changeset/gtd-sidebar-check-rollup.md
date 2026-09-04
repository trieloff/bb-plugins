---
"@smsunarto/bb-plugin-gtd-sidebar": minor
---

Read GitHub's combined check status so a PR whose CI is still running stops
looking like one whose CI failed. `mergeable_state` cannot separate them —
`blocked` and `unstable` each cover both — so `RestPull` now carries the head
sha and a normalized rollup, fetched alongside the merge queue in the same
per-repository GraphQL call.
