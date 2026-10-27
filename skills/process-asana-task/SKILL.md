---
name: process-asana-task
description: Process an Asana task from specified Asana board
disable-model-invocation: true
---

Process Asana project GID <GID>. Use GIDs only, never search by name.

NOTIFY: send a Slack DM to user <ID> and a Slack message in channel <ID> with the message, the Asana task link, and this session's link.

NOTIFY-BLOCKED: NOTIFY, mark task [blocked], and move it to "Inbox".

BASE: release-<major>.x, where <major> is the first number of the Release version (v2.4.1 or 2.4.1 gives release-2.x). If BASE isn't on origin, NOTIFY-BLOCKED.

0. Fetch the project by GID. If it's missing NOTIFY and stop.

1. Take the oldest incomplete task in "Ready for agent". If none, stop silently. Immediately move task to "Agent working" and comment on each "Picked up, session: <link>".

2. Run `git fetch --all --tags` once. Reset to a clean state (`git reset --hard`, `git clean -fd`, `git switch --detach`).

a. Read the Asana description, comments, and links.

b. Read Repo, Type, Mode, Fix target, and Release version from the custom fields. Every ticket needs a Release version. If any custom field if missing, NOTIFY-BLOCKED.

c. MANDATORY: poteto-mode governs EVERY task, of every Type. Load it with the Skill tool (skill "pstack:poteto-mode", args: task description, Type, repo, BASE, Mode). If that fails NOTIFY-BLOCKED.

d. Write a result comment. Post it on the Asana task and NOTIFY.

e. Move the task to "Needs review".

3. End with a summary in this session's output, its outcome and its PR link.

Rules:

- Never merge unless Mode = merge and BASE is a release branch.
- Never edit CI config or secrets.
- Every branch starts BASE.
- Skill pstack:poteto-mode runs for every task. Follow its playbook exactly as loaded; do not skip, shorten, or reinterpret it.
- Never target main.
