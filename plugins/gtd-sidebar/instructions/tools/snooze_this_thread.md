Snooze this thread: take it out of the user's GTD Sidebar inbox until a wake time, because the work is waiting on something outside this thread, such as CI, a code review, a deploy, a long-running job, or another person, and the user has nothing to do here until then.

The snooze starts when your current turn ends. The thread comes back at the wake time, or sooner when the user writes in it. Give `pullRequestUrl` to also bring it back when that pull request changes: checks finish, a review lands, or it merges.

Parameters:

- `until`: the wake time, in ISO 8601 with an offset, such as 2026-10-22T09:00:00+02:00. At most 30 days ahead.
- `minutes`: wake after this many minutes instead, from 1 to 43200.
- Give neither to let the sidebar pick, the same way its one-click snooze does: the next working morning, longer each time the thread is snoozed again without news.
- `pullRequestUrl`: a GitHub pull request URL to watch while the thread is snoozed.

Do not snooze while the user is waiting on an answer from you, or to put off work you can do now.
