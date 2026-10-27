---
name: process-asana-task
description: Process an Asana task from specified Asana board
argument-hint: <project-gid> <slack-user-id> <slack-channel-id>
---

Arguments, in order: project GID = $0, Slack user ID = $1, Slack channel ID = $2.
If any argument is missing, stop and NOTIFY.

Process Asana project GID $0. Use GIDs only, never search by name.

NOTIFY: send a Slack DM to user $1 and a Slack message in channel $2 with the message, the Asana task link, and this session's link.

NOTIFY-BLOCKED: NOTIFY, mark task [blocked], and move it to "Inbox".

BASE: release-<major>.x, where <major> is the first number of the Release version (v2.4.1 or 2.4.1 gives release-2.x). If BASE isn't on origin, NOTIFY-BLOCKED.

0. Fetch the project by GID. If it's missing NOTIFY and stop.

1. Take the oldest incomplete task in "Ready for agent". If none, stop silently. Immediately move task to "Agent working" and comment on each "Picked up, session: <link>".

2. Read the Asana description, comments, and links.

3. Read Repo, Type, Mode, Fix target, and Release version from the custom fields. Every ticket needs a Release version. If any custom field is missing, NOTIFY-BLOCKED.

4. Run `git fetch --all --tags` once. Reset to a clean state (`git reset --hard`, `git clean -fd`, `git switch --detach`).

5. Load pstack:poteto-mode with the Skill tool (args: task description, Type,
   repo, BASE, Mode). If that fails, NOTIFY-BLOCKED.
   a. Run the playbook in THIS session. If you delegate, use only the
   implementer, verifier, or reviewer agents, and only for work a playbook
   phase assigns. Never use general-purpose for task work.
   b. Before writing any code, open the playbook for this Type and create one
   TaskCreate entry per phase and per principle skill it names.
   c. You are unattended. At any checkpoint that would ask the user, decide,
   record the decision for the result comment, and continue. Never skip
   the phase.
   d. Step 5 is done only when every task from (b) is completed. Before step 6,
   list each phase with its evidence (Skill call or task ID). If any phase
   has no evidence, go back and do it.

6. Write a result comment. Post it on the Asana task and NOTIFY.

7. Move the task to "Needs review".

8. End with a summary in this session's output, its outcome and its PR link.

Rules:

- Never merge unless Mode = merge and BASE is a release branch.
- Never edit CI config or secrets.
- Every branch starts from origin/BASE.
- Skill pstack:poteto-mode runs for every task. Follow its playbook exactly as loaded; never skip, shorten, or reinterpret it.
- Never target main.
