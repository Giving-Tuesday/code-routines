---
name: process-asana-task
description: Process an Asana task from specified Asana board
argument-hint: <project-gid> <slack-user-id> <slack-channel-id>
---

Arguments, in order: project GID = $0, Slack user ID = $1, Slack channel ID = $2.
If any argument is missing, stop and NOTIFY.

You run the envelope only. A separate `/pstack:poteto-mode` session does the task work, and `routine.mjs` (next to this file) checks it. Never edit the target repo, run a playbook, or judge the work yourself.

Process Asana project GID $0. Use GIDs only, never search by name.

NOTIFY: send a Slack DM to user $1 and a Slack message in channel $2 with the message, the Asana task link, and this session's link.

NOTIFY-BLOCKED: NOTIFY with the reasons, mark the task [blocked], and move it to "Inbox".

0. Fetch the project by GID. If it's missing, NOTIFY and stop.

1. Take the oldest incomplete task in "Ready for agent". If none, stop silently. Move it to "Agent working" and comment "Picked up, session: <link>".

2. Write `.audit/ticket.json` in the checkout of the task's Repo custom field. If that repo is not checked out in this session, NOTIFY-BLOCKED. The file holds `gid`, `url`, `name`, `text` (the description, every comment, and the content of linked pages), and `fields` with Repo, Type, Mode, Fix target and Release version exactly as Asana shows them.

3. From that checkout, run `node <this skill's directory>/routine.mjs prepare .audit/ticket.json`. It validates the fields, computes BASE, resets the branch to origin/BASE and installs dependencies. On a non-zero exit, NOTIFY-BLOCKED with its `problems`.

4. Run `node <this skill's directory>/routine.mjs run` in the background with a timeout of at least two hours, and wait for it. It starts the work session with only the shell tools of the repo's lockfiles allowed, a seeded `.audit/todo.md`, and a Stop hook that sends the gate's gaps back to the session up to three times before it may finish. On a non-zero exit, NOTIFY-BLOCKED with its `problems`.

5. Run `node <this skill's directory>/routine.mjs gate`. Then spawn the `code-routines:playbook-auditor` agent with the gate's `transcript` and `result` paths and the playbook name from `.audit/routine.json`. The gate's `violations` are hard-rule breaks. Its `findings` and the auditor's verdict are a report only.

   If the gate reports any `violations` or `findings`, or the auditor returns FAIL, write them to `.audit/audit.md`: the gate's `violations` and `findings`, then the auditor's missing and invalid-skip rows. Run `node <this skill's directory>/routine.mjs repair .audit/audit.md` in the background with a timeout of at least one hour, and wait for it. It resumes the work session once to close the gaps. Whatever its exit code, run the gate and the auditor again, and use only this second result from here on. Do one repair round, never more.

6. Post a comment on the Asana task with `.audit/result.md`, a "Process audit" section with the gate's `findings` and the auditor's verdict and table, and any `violations`.

7. If the gate reports `violations`, NOTIFY-BLOCKED with them and stop.

   If Mode is merge, run `node <this skill's directory>/routine.mjs await-ci` in the background with a timeout of at least 35 minutes, and wait for it. It waits for every check run on the PR head to finish. Then run `node <this skill's directory>/routine.mjs merge-check`. When it exits 0, merge the PR with the GitHub connector as a merge commit, never a squash, so the test commit stays ahead of the fix commit in history. When it exits non-zero, do not merge, and put its `failed` checks in the Asana comment.

   Move the task to "Needs review" and NOTIFY with the PR link, whether it merged, any failed merge checks, and the audit verdict.

8. End with a summary in this session's output: the outcome and the PR link.

Rules:

- Merge only in step 7, and only when `merge-check` exits 0.
- Never move a task to "Needs review" while the gate reports `violations`.
- Never edit CI config or secrets.
