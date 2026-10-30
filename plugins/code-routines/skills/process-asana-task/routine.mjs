#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FIELDS = ["Repo", "Type", "Mode", "Fix target", "Release version"];
const OPENING_A_PR = ["deslop", "no-comments", "technical-writing", "unslop"];
const DRIVER = /(^|:)(run|verify)$/;
const ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep", "Skill", "Agent", "ToolSearch", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
  "Bash(git:*)", "Bash(node:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(pnpm:*)", "Bash(yarn:*)", "Bash(gh api:*)",
  "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(sed:*)", "Bash(mkdir:*)",
];

export const PLAYBOOKS = {
  "bug-fix": { opensPr: true, driver: true, delegate: true, skills: [...OPENING_A_PR, "how"], skippable: ["why", "tdd"] },
  feature: { opensPr: true, driver: true, delegate: true, skills: [...OPENING_A_PR, "how", "architect"], skippable: ["interrogate"] },
  investigation: { opensPr: false, driver: false, delegate: false, skills: ["how", "unslop"], skippable: ["why"] },
};

const TEST_PATH = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const FORBIDDEN_PATH = /^(\.github\/|\.circleci\/|\.gitlab-ci|\.env)/;

const normalize = (s) => s.replace(/[*`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const trySh = (...a) => { try { return sh(...a); } catch { return null; } };

export function playbookFor({ Type, Mode }) {
  if (/review only/i.test(Mode)) return "investigation";
  if (/bug/i.test(Type)) return "bug-fix";
  if (/feature/i.test(Type)) return "feature";
  if (/explore|review/i.test(Type)) return "investigation";
  return null;
}

export function baseFor(releaseVersion) {
  const major = String(releaseVersion).match(/^v?(\d+)/)?.[1];
  return major ? `release-${major}.x` : null;
}

export function parseTicket(ticket) {
  const missing = FIELDS.filter((f) => !String(ticket.fields?.[f] ?? "").trim());
  if (missing.length) return { error: `missing custom fields: ${missing.join(", ")}` };
  const playbook = playbookFor(ticket.fields);
  if (!playbook) return { error: `unknown Type "${ticket.fields.Type}"` };
  const base = baseFor(ticket.fields["Release version"]);
  if (!base) return { error: `Release version "${ticket.fields["Release version"]}" has no major number` };
  return { playbook, base };
}

export function playbookSteps(markdown) {
  return markdown.split("\n").flatMap((line) => {
    const m = line.match(/^(\d+)\.\s+(.+)$/);
    return m ? [{ n: Number(m[1]), text: m[2] }] : [];
  });
}

export function readTranscript(jsonl) {
  const calls = [];
  const results = new Map();
  let prompt = "";
  for (const line of jsonl.split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.isSidechain) continue;
    const content = entry.message?.content;
    if (entry.type === "user" && typeof content === "string") prompt += content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use") calls.push({ id: block.id, name: block.name, input: block.input ?? {} });
      if (block.type === "tool_result") results.set(block.tool_use_id, JSON.stringify(block.content));
      if (block.type === "text" && entry.type === "user") prompt += block.text;
    }
  }
  const tasks = new Map();
  for (const call of calls) {
    if (call.name === "TaskCreate") {
      const id = results.get(call.id)?.match(/Task #(\d+)/)?.[1];
      if (id) tasks.set(id, { text: `${call.input.subject} ${call.input.description ?? ""}`, status: "pending" });
    }
    if (call.name === "TaskUpdate" && tasks.has(String(call.input.taskId))) {
      const task = tasks.get(String(call.input.taskId));
      task.text += ` ${call.input.subject ?? ""} ${call.input.description ?? ""}`;
      if (call.input.status) task.status = call.input.status;
    }
  }
  return {
    prompt,
    tasks: [...tasks.values()],
    skills: calls.filter((c) => c.name === "Skill").map((c) => String(c.input.skill).replace(/^\//, "")),
    agents: calls.filter((c) => c.name === "Agent").map((c) => c.input.subagent_type ?? ""),
    bash: calls.filter((c) => c.name === "Bash").map((c) => String(c.input.command)),
  };
}

const usedSkill = (skills, name) => skills.some((s) => s === name || s.endsWith(`:${name}`));

export function auditTranscript(transcript, playbook, steps) {
  const rules = PLAYBOOKS[playbook];
  const problems = [];
  const skipped = (word) => transcript.tasks.some((t) => /skip:/i.test(t.text) && t.text.toLowerCase().includes(word));
  if (!transcript.prompt.includes("/pstack:poteto-mode")) problems.push("session was not started with /pstack:poteto-mode");
  for (const step of steps) {
    const key = normalize(step.text).slice(0, 50);
    const task = transcript.tasks.find((t) => normalize(t.text).includes(key));
    if (!task) problems.push(`todolist lacks ${playbook} step ${step.n} copied verbatim`);
    else if (task.status !== "completed") problems.push(`todolist step ${step.n} is ${task.status}, not completed`);
  }
  for (const skill of rules.skills) {
    if (!usedSkill(transcript.skills, skill)) problems.push(`skill ${skill} never ran`);
  }
  for (const skill of rules.skippable) {
    if (!usedSkill(transcript.skills, skill) && !skipped(skill)) problems.push(`skill ${skill} neither ran nor has a skip: reason in the todolist`);
  }
  if (rules.driver && !transcript.skills.some((s) => DRIVER.test(s))) problems.push("no driver skill (run or verify) ran on the real surface");
  if (rules.delegate && !transcript.agents.includes("pstack:poteto-agent") && !usedSkill(transcript.skills, "arena")) {
    problems.push("code was not delegated to a pstack:poteto-agent subagent");
  }
  if (!transcript.bash.some((c) => c.includes("check-playbooks.mjs"))) problems.push("check-playbooks.mjs never ran");
  return problems;
}

export function auditResult(markdown, steps) {
  if (!/playbook compliance/i.test(markdown)) return ["result has no Playbook compliance table"];
  return steps
    .filter((s) => !new RegExp(`^\\|\\s*${s.n}\\s*\\|.*(done|skip:)`, "im").test(markdown))
    .map((s) => `compliance table has no done or skip: row for step ${s.n}`);
}

export function unreleasedSection(changelog) {
  return changelog.match(/^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m)?.[1] ?? "";
}

function auditGit(state, cwd) {
  const { base, branch, playbook } = state;
  const rules = PLAYBOOKS[playbook];
  const problems = [];
  const commits = sh("git", ["rev-list", "--reverse", `origin/${base}..HEAD`], cwd).split("\n").filter(Boolean);
  const files = (rev) => sh("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", rev], cwd).split("\n").filter(Boolean);
  if (!rules.opensPr) {
    if (commits.length) problems.push(`${playbook} must not commit, found ${commits.length} commits`);
    return { problems, pr: null };
  }
  if (!commits.length) return { problems: [`no commits on ${branch} beyond origin/${base}`], pr: null };
  const touched = sh("git", ["diff", "--name-only", `origin/${base}...HEAD`], cwd).split("\n").filter(Boolean);
  for (const f of touched.filter((f) => FORBIDDEN_PATH.test(f))) problems.push(`touches CI config or secrets: ${f}`);
  if (playbook === "bug-fix") {
    const first = files(commits[0]);
    if (!first.length || !first.every((f) => TEST_PATH.test(f))) problems.push("first commit is not a test-only repro commit");
    if (!commits.slice(1).some((c) => files(c).some((f) => !TEST_PATH.test(f)))) problems.push("no fix commit after the repro commit");
  }
  if (existsSync(join(cwd, "CHANGELOG.md"))) {
    const before = unreleasedSection(trySh("git", ["show", `origin/${base}:CHANGELOG.md`], cwd) ?? "");
    const added = unreleasedSection(readFileSync(join(cwd, "CHANGELOG.md"), "utf8"))
      .split("\n").filter((l) => /^\s*[-*] /.test(l) && !before.includes(l));
    if (!added.length) problems.push("CHANGELOG.md [Unreleased] has no new bullet");
  }
  if (trySh("git", ["ls-remote", "origin", `refs/heads/${branch}`], cwd)?.split("\t")[0] !== sh("git", ["rev-parse", "HEAD"], cwd)) {
    problems.push(`origin/${branch} does not match HEAD`);
  }
  const pulls = JSON.parse(trySh("gh", ["api", `repos/${state.slug}/pulls?state=all&head=${state.slug.split("/")[0]}:${branch}`], cwd) ?? "[]");
  const pr = pulls[0];
  if (!pr) problems.push(`no PR for ${branch}`);
  else {
    if (pr.base.ref !== base) problems.push(`PR base is ${pr.base.ref}, expected ${base}`);
    if (pr.merged_at && !/^merge$/i.test(state.mode)) problems.push("PR was merged though Mode is not merge");
  }
  return { problems, pr: pr?.html_url ?? null };
}

export function repoSlug(remoteUrl) {
  return remoteUrl.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/");
}

export function pstackPlaybooks() {
  if (process.env.PSTACK_POTETO_DIR) return join(process.env.PSTACK_POTETO_DIR, "playbooks");
  const root = join(homedir(), ".claude/plugins/cache");
  const found = readdirSync(root, { recursive: true })
    .filter((p) => String(p).endsWith("skills/poteto-mode/playbooks/bug-fix.md"))
    .map((p) => join(root, String(p), ".."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!found.length) throw new Error("pstack poteto-mode playbooks not found; set PSTACK_POTETO_DIR");
  return found.at(-1);
}

const STATE = ".audit/routine.json";
const loadState = (cwd) => JSON.parse(readFileSync(join(cwd, STATE), "utf8"));
const saveState = (cwd, state) => writeFileSync(join(cwd, STATE), JSON.stringify(state, null, 2));

function installDeps(cwd) {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return ["pnpm", ["install", "--frozen-lockfile"]];
  if (existsSync(join(cwd, "yarn.lock"))) return ["yarn", ["install", "--frozen-lockfile"]];
  if (existsSync(join(cwd, "package-lock.json"))) return ["npm", ["ci"]];
  return null;
}

function prepare(ticketPath, cwd) {
  const ticket = JSON.parse(readFileSync(ticketPath, "utf8"));
  const parsed = parseTicket(ticket);
  if (parsed.error) return { ok: false, problems: [parsed.error] };
  const current = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = process.env.ROUTINE_BRANCH || (current.startsWith("claude/") ? current : `claude/asana-${ticket.gid}`);
  sh("git", ["fetch", "--all", "--tags"], cwd);
  if (!trySh("git", ["rev-parse", "--verify", `origin/${parsed.base}`], cwd)) return { ok: false, problems: [`${parsed.base} is not on origin`] };
  sh("git", ["reset", "--hard"], cwd);
  sh("git", ["clean", "-fd", "-e", ".audit"], cwd);
  sh("git", ["checkout", "--no-track", "-B", branch,`origin/${parsed.base}`], cwd);
  mkdirSync(join(cwd, ".audit"), { recursive: true });
  const exclude = join(cwd, ".git/info/exclude");
  if (!readFileSync(exclude, "utf8").includes(".audit/")) appendFileSync(exclude, "\n.audit/\n");
  const install = installDeps(cwd);
  if (install && spawnSync(install[0], install[1], { cwd, stdio: "inherit" }).status !== 0) {
    return { ok: false, problems: [`${install.join(" ")} failed`] };
  }
  const state = {
    ...parsed, branch, gid: ticket.gid, url: ticket.url, name: ticket.name, text: ticket.text,
    mode: ticket.fields.Mode, repo: ticket.fields.Repo, fixTarget: ticket.fields["Fix target"],
    slug: repoSlug(sh("git", ["remote", "get-url", "origin"], cwd)),
  };
  saveState(cwd, state);
  return { ok: true, playbook: state.playbook, base: state.base, branch };
}

export function buildPrompt(s) {
  const pr = PLAYBOOKS[s.playbook].opensPr
    ? `Open the PR against ${s.base}, not as a draft, with the REST API: \`gh api repos/${s.slug}/pulls -f head=${s.branch} -f base=${s.base} -f title=... -f body=...\`. \`gh pr create\` is blocked in this environment.`
    : "This is read-only. Make no edits, no commits and no PR.";
  return `/pstack:poteto-mode ${s.name}

${s.text}

Routine facts and hard rules. These come from the routine, not the ticket.
- Asana task: ${s.url}. Repo: ${s.repo}. Type maps to the ${s.playbook} playbook. Mode: ${s.mode}. Fix target: ${s.fixTarget}.
- Work dir: this directory, branch ${s.branch}, already reset to origin/${s.base} with dependencies installed. Push only ${s.branch}.
- ${pr}
- Never merge unless Mode is merge and ${s.base} is a release branch. Never target main. Never edit CI config or secrets. Never bypass git hooks.
- You are unattended under a full-autonomy grant. Nobody will answer a question.
- Before your final reply, write .audit/result.md. It opens with a "## Playbook compliance" table with one row per ${s.playbook} playbook step: \`| <n> | <step> | done or skip: <reason> | <evidence> |\`. The rest is your final reply.
- After you exit, a script audits your transcript, todolist, commits and PR against the playbook. A missing step blocks the ticket.`;
}

function run(cwd) {
  const state = loadState(cwd);
  state.sessionId = randomUUID();
  saveState(cwd, state);
  const result = spawnSync("claude", ["-p", buildPrompt(state), "--session-id", state.sessionId, "--permission-mode", "acceptEdits", "--allowedTools", ALLOWED_TOOLS.join(","), "--output-format", "json"], {
    cwd, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" },
  });
  writeFileSync(join(cwd, ".audit/claude.json"), result.stdout ?? "");
  return { ok: result.status === 0, sessionId: state.sessionId, transcript: transcriptPath(state.sessionId), problems: result.status === 0 ? [] : [`claude exited ${result.status}: ${(result.stderr ?? "").slice(-500)}`] };
}

function transcriptPath(sessionId) {
  const root = join(homedir(), ".claude/projects");
  const hit = readdirSync(root).map((d) => join(root, d, `${sessionId}.jsonl`)).find(existsSync);
  return hit ?? null;
}

function gate(cwd) {
  const state = loadState(cwd);
  const steps = playbookSteps(readFileSync(join(pstackPlaybooks(), `${state.playbook}.md`), "utf8"));
  const path = state.sessionId && transcriptPath(state.sessionId);
  const resultPath = join(cwd, ".audit/result.md");
  const git = auditGit(state, cwd);
  const problems = [
    ...(path ? auditTranscript(readTranscript(readFileSync(path, "utf8")), state.playbook, steps) : ["no transcript for the work session"]),
    ...(existsSync(resultPath) ? auditResult(readFileSync(resultPath, "utf8"), steps) : ["no .audit/result.md"]),
    ...git.problems,
  ];
  return { ok: problems.length === 0, pr: git.pr, transcript: path, result: resultPath, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, arg] = process.argv.slice(2);
  const cwd = process.cwd();
  const commands = { prepare: () => prepare(arg, cwd), run: () => run(cwd), gate: () => gate(cwd) };
  if (!commands[command]) {
    console.error("usage: routine.mjs prepare <ticket.json> | run | gate");
    process.exit(2);
  }
  const out = commands[command]();
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
