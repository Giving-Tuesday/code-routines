import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { opensPr, pstackRoot } from "./playbooks.mjs";
import { AUDIT_DIR, PR_BODY, PR_TITLE, RESULT, SETTINGS, STOP_COUNT, TODO, claudeOutput, claudeOutputs, loadState, saveState } from "./state.mjs";
import { transcriptPath } from "./transcript.mjs";

const ROUTINE = fileURLToPath(new URL("../routine.mjs", import.meta.url));

const BASE_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep", "Skill", "Agent", "ToolSearch",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop",
  "Bash(git:*)", "Bash(node:*)", "Bash(gh api:*)",
  "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(grep:*)", "Bash(rg:*)",
  "Bash(find:*)", "Bash(sed:*)", "Bash(mkdir:*)", "Bash(echo:*)", "Bash(printf:*)", "Bash(cd:*)",
  "Bash(pwd)", "Bash(wc:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(diff:*)", "Bash(test:*)",
  "Bash(jq:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(touch:*)",
];

export const TOOLCHAINS = [
  { lock: "uv.lock", install: ["uv", ["sync", "--frozen"]], tools: ["uv", "uvx", "python", "python3", "pytest"] },
  { lock: "pnpm-lock.yaml", install: ["pnpm", ["install", "--frozen-lockfile"]], tools: ["pnpm", "npx"] },
  { lock: "yarn.lock", install: ["yarn", ["install", "--frozen-lockfile"]], tools: ["yarn", "npx"] },
  { lock: "package-lock.json", install: ["npm", ["ci"]], tools: ["npm", "npx"] },
];

export function toolsFor({ toolchains }) {
  const shellTools = TOOLCHAINS.filter((t) => toolchains.includes(t.lock)).flatMap((t) => t.tools);
  return [...new Set([...BASE_TOOLS, ...shellTools.map((tool) => `Bash(${tool}:*)`)])];
}

const sentences = (...parts) => parts.join(" ");

export function browserFact(env) {
  if (!env.PLAYWRIGHT_BROWSERS_PATH) return "";
  return `\n- ${sentences(
    'For a browser check, write a Node script that uses `require("playwright")` and `chromium.launch()` with no options,',
    "run it as plain `node <script>` with no environment prefix, since require resolves playwright from any directory,",
    `and save each screenshot as ${AUDIT_DIR}/<what-it-shows>.png.`,
    `The routine adds every ${AUDIT_DIR}/*.png to the PR description, so save only screenshots a reviewer should see.`,
    `Chromium is installed under ${env.PLAYWRIGHT_BROWSERS_PATH}.`,
    "google-chrome is not installed, and npx playwright install is not needed.",
  )}`;
}

function prRule(s) {
  if (!opensPr(s.playbook)) return "This is read-only. Make no edits, no commits and no PR.";
  return sentences(
    `Do not open the PR yourself. Push ${s.branch}, write the PR title to ${PR_TITLE} and its body to ${PR_BODY},`,
    `and the routine opens the PR against ${s.base}.`,
    ...(s.prTemplate
      ? [
          `Write the PR body with the headings of the repo's template, ${s.prTemplate}, in its order,`,
          "in place of the Opening a PR default headings. Keep every heading.",
        ]
      : []),
  );
}

export function buildPrompt(s) {
  const shellTools = toolsFor(s)
    .filter((t) => t.startsWith("Bash("))
    .map((t) => t.slice(5, -1).replace(/:\*$/, ""))
    .join(", ");
  return [
    `/pstack:poteto-mode ${s.name}`,
    "",
    s.text,
    "",
    "Routine facts and hard rules. These come from the routine, not the ticket.",
    sentences(
      `- Asana task: ${s.url}. Repo: ${s.repo}. Type maps to the ${s.playbook} playbook.`,
      `Mode: ${s.mode}. Fix target: ${s.fixTarget}.`,
    ),
    sentences(
      `- Work dir: this directory, branch ${s.branch}, already reset to origin/${s.base} with dependencies installed.`,
      `Push only ${s.branch}.`,
    ),
    `- ${prRule(s)}`,
    sentences(
      "- Never merge. The routine merges after its own checks when Mode is merge.",
      "Never target main. Never edit CI config or secrets. Never bypass git hooks.",
      "Never rewrite pushed history: no rebase, amend or force-push of a pushed commit.",
    ),
    "- You are unattended under a full-autonomy grant. Nobody will answer a question.",
    sentences(
      `- Shell commands you can run: ${shellTools}. Anything else is refused.`,
      `If the playbook needs a command outside this list, record skip: <reason> naming the command.${browserFact(process.env)}`,
    ),
    sentences(
      `- Your todolist is ${TODO}. It already holds the playbook steps verbatim.`,
      "Tick each line `- [x]` when done, or append `skip: <reason>`. You may mirror it with TaskCreate.",
    ),
    sentences(
      `- Before your final reply, write ${RESULT}. It opens with a "## Playbook compliance" table`,
      `with one row per ${s.playbook} playbook step: \`| <n> | <step> | done or skip: <reason> | <evidence> |\`.`,
      "The rest is your final reply.",
    ),
    sentences(
      "- After you exit, a script audits your transcript, todolist, commits and PR against the playbook.",
      "A Stop hook runs the same audit when you try to finish and sends back any gap it finds.",
    ),
  ].join("\n");
}

export function buildRepairPrompt(s, audit) {
  return [
    sentences(
      `/pstack:poteto-mode The routine's process audit found gaps in your ${s.playbook} run for ${s.url}.`,
      `Close them on branch ${s.branch} and its PR. If the PR does not exist yet, open it as your first prompt said.`,
    ),
    "",
    audit,
    "",
    "- For each gap, run the skipped step or skill now on the work you already did. Rerun nothing the audit did not flag.",
    sentences(
      "- A prose skill (technical-writing, unslop) applies to the PR title and body.",
      `Rewrite ${PR_TITLE} and ${PR_BODY}, and the routine applies them to the PR.`,
    ),
    sentences(
      "- Never rewrite pushed history: no rebase, amend or force-push.",
      "A gap that needs a history rewrite stays open. Name it in the table.",
    ),
    `- Update ${RESULT} so each row says done or skip: <reason> with evidence from this round.`,
    "- The routine facts and hard rules from your first prompt still hold.",
  ].join("\n");
}

export function writeSettings(cwd) {
  const hook = (name) => ({ hooks: [{ type: "command", command: `node ${JSON.stringify(ROUTINE)} ${name} ${JSON.stringify(cwd)}` }] });
  const settings = { hooks: { Stop: [hook("stop-hook")], PreToolUse: [{ matcher: "Bash", ...hook("pre-tool-hook") }] } };
  writeFileSync(join(cwd, SETTINGS), JSON.stringify(settings));
}

function claude(cwd, state, round, sessionArgs, prompt) {
  writeSettings(cwd);
  rmSync(join(cwd, STOP_COUNT), { force: true });
  const args = [
    "-p", prompt,
    ...sessionArgs,
    "--settings", join(cwd, SETTINGS),
    "--add-dir", pstackRoot(),
    "--permission-mode", "acceptEdits",
    "--allowedTools", toolsFor(state).join(","),
    "--output-format", "json",
  ];
  const result = spawnSync("claude", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" },
  });
  writeFileSync(join(cwd, claudeOutput(round)), result.stdout ?? "");
  const ok = result.status === 0;
  return {
    ok,
    sessionId: state.sessionId,
    transcript: transcriptPath(state.sessionId),
    problems: ok ? [] : [`claude exited ${result.status}: ${(result.stderr ?? "").slice(-500)}`],
  };
}

export function run(cwd) {
  const state = loadState(cwd);
  state.sessionId = randomUUID();
  saveState(cwd, state);
  for (const f of claudeOutputs(cwd)) rmSync(f);
  return claude(cwd, state, "run", ["--session-id", state.sessionId], buildPrompt(state));
}

export function repair(auditPath, cwd) {
  const state = loadState(cwd);
  return claude(cwd, state, "repair", ["--resume", state.sessionId], buildRepairPrompt(state, readFileSync(auditPath, "utf8")));
}
