---
"@smsunarto/bb-plugin-gtd-sidebar": minor
---

Tell merged pull requests apart from shipped ones. A merged PR keeps bb's purple
until the repository publishes a GitHub release that carries it, then the badge
deepens to a darker purple and its tooltip reads "Merged and released pull
request". The state comes from one `releases/latest` call per repository per
tick, and a `release` webhook repaints the badges as soon as a release is
published. Stacked PRs merged into a parent branch and repositories that have
never released stay in plain purple.
