---
"@smsunarto/bb-plugin-gtd-sidebar": patch
---

Give a PR whose checks are still running its own yellow. It shared
`--warning-text` with the merge queue, so "CI is thinking" and "GitHub is about
to merge this" were the same ochre. Pending now shifts that token to hue 102 — a
real yellow at the theme's own lightness and chroma, so it reads on both
surfaces without a second token to keep in sync.
