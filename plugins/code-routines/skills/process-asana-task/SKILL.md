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

4. Run `node <this skill's directory>/routine.mjs run` in the background with a timeout of at least two hours, and wait for it. It starts the work session. On a non-zero exit, NOTIFY-BLOCKED with its `problems`.

5. Run `node <this skill's directory>/routine.mjs gate`. Then spawn the `code-routines:playbook-auditor` agent with the gate's `transcript` and `result` paths and the playbook name from `.audit/routine.json`. The task passes only when the gate exits 0 and the auditor returns PASS.

6. Post a comment on the Asana task with `.audit/result.md`, the gate's `problems`, and the auditor's table.

7. On pass, move the task to "Needs review" and NOTIFY with the PR link. On fail, NOTIFY-BLOCKED with the gate's `problems` and the auditor's failed rows.

8. End with a summary in this session's output: the outcome and the PR link.

Rules:

- Never merge, and never move a task to "Needs review" without a passing gate and auditor.
- Never edit CI config or secrets.
