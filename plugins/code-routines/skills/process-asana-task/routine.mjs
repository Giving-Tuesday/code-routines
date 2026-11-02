#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FIELDS = ["Repo", "Type", "Mode", "Fix target", "Release version"];
const OPENING_A_PR = ["deslop", "no-comments", "technical-writing", "unslop"];
const DRIVER = /(^|:)(run|verify)$/;
const BASE_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep", "Skill", "Agent", "ToolSearch", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
  "Bash(git:*)", "Bash(node:*)", "Bash(gh api:*)",
  "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(sed:*)", "Bash(mkdir:*)",
];
const STOP_HOOK_LIMIT = 3;

export const TOOLCHAINS = [
  { lock: "uv.lock", install: ["uv", ["sync", "--frozen"]], tools: ["uv", "uvx", "python", "python3", "pytest"] },
  { lock: "pnpm-lock.yaml", install: ["pnpm", ["install", "--frozen-lockfile"]], tools: ["pnpm", "npx"] },
  { lock: "yarn.lock", install: ["yarn", ["install", "--frozen-lockfile"]], tools: ["yarn", "npx"] },
  { lock: "package-lock.json", install: ["npm", ["ci"]], tools: ["npm", "npx"] },
];

export const allowedTools = (toolchains) => [...new Set([...BASE_TOOLS, ...toolchains.flatMap((t) => t.tools.map((tool) => `Bash(${tool}:*)`))])];
const toolsFor = (state) => allowedTools(TOOLCHAINS.filter((t) => state.toolchains.includes(t.lock)));

export const PLAYBOOKS = {
  "bug-fix": { opensPr: true, driver: true, delegate: true, skills: [...OPENING_A_PR, "how"], skippable: ["why", "tdd"] },
  feature: { opensPr: true, driver: true, delegate: true, skills: [...OPENING_A_PR, "how", "architect"], skippable: ["interrogate"] },
  investigation: { opensPr: false, driver: false, delegate: false, skills: ["how", "unslop"], skippable: ["why"] },
};

const TEST_PATH = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/;
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

export function auditTranscript(transcript, playbook, steps, todo = "") {
  const rules = PLAYBOOKS[playbook];
  const problems = [];
  const skipped = (word) => [...transcript.tasks.map((t) => t.text), ...todo.split("\n")].some((t) => /skip:/i.test(t) && t.toLowerCase().includes(word));
  if (!transcript.prompt.includes("/pstack:poteto-mode")) problems.push("session was not started with /pstack:poteto-mode");
  for (const step of steps) {
    const key = normalize(step.text).slice(0, 50);
    const line = todo.split("\n").find((l) => normalize(l).includes(key));
    if (line && (/^- \[x\]/i.test(line) || /skip:/i.test(line))) continue;
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
  const violations = [];
  const findings = [];
  const commits = sh("git", ["rev-list", "--reverse", `origin/${base}..HEAD`], cwd).split("\n").filter(Boolean);
  const files = (rev) => sh("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", rev], cwd).split("\n").filter(Boolean);
  if (!rules.opensPr) {
    if (commits.length) violations.push(`${playbook} must not commit, found ${commits.length} commits`);
    return { violations, findings, pr: null };
  }
  if (!commits.length) return { violations: [`no commits on ${branch} beyond origin/${base}`], findings, pr: null };
  const touched = sh("git", ["diff", "--name-only", `origin/${base}...HEAD`], cwd).split("\n").filter(Boolean);
  for (const f of touched.filter((f) => FORBIDDEN_PATH.test(f))) violations.push(`touches CI config or secrets: ${f}`);
  if (playbook === "bug-fix") {
    const first = files(commits[0]);
    if (!first.length || !first.every((f) => TEST_PATH.test(f))) findings.push("first commit is not a test-only repro commit");
    if (!commits.slice(1).some((c) => files(c).some((f) => !TEST_PATH.test(f)))) findings.push("no fix commit after the repro commit");
  }
  if (existsSync(join(cwd, "CHANGELOG.md"))) {
    const before = unreleasedSection(trySh("git", ["show", `origin/${base}:CHANGELOG.md`], cwd) ?? "");
    const added = unreleasedSection(readFileSync(join(cwd, "CHANGELOG.md"), "utf8"))
      .split("\n").filter((l) => /^\s*[-*] /.test(l) && !before.includes(l));
    if (!added.length) findings.push("CHANGELOG.md [Unreleased] has no new bullet");
  }
  if (trySh("git", ["ls-remote", "origin", `refs/heads/${branch}`], cwd)?.split("\t")[0] !== sh("git", ["rev-parse", "HEAD"], cwd)) {
    findings.push(`origin/${branch} does not match HEAD`);
  }
  const pulls = JSON.parse(trySh("gh", ["api", `repos/${state.slug}/pulls?state=all&head=${state.slug.split("/")[0]}:${branch}`], cwd) ?? "[]");
  const pr = pulls[0];
  if (!pr) violations.push(`no PR for ${branch}`);
  else {
    if (pr.base.ref !== base) violations.push(`PR base is ${pr.base.ref}, expected ${base}`);
    if (pr.merged_at && !/^merge$/i.test(state.mode)) violations.push("PR was merged though Mode is not merge");
  }
  return { violations, findings, pr: pr?.html_url ?? null };
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

export function seedTodo(playbook, steps) {
  const opening = PLAYBOOKS[playbook].opensPr
    ? ["Opening a PR: run /deslop over the diff before commit", "Opening a PR: run /no-comments before review", "Opening a PR: run /technical-writing, then /unslop, on commit bodies and the PR title and body", "Opening a PR: read the PR back with gh api repos/<owner>/<repo>/pulls/<number>"]
    : [];
  return [`# ${playbook} todolist`, "", ...steps.map((s) => `- [ ] ${s.n}. ${s.text}`), ...opening.map((o) => `- [ ] ${o}`), ""].join("\n");
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
  const toolchains = TOOLCHAINS.filter((t) => existsSync(join(cwd, t.lock)));
  for (const { install } of toolchains) {
    if (spawnSync(install[0], install[1], { cwd, stdio: "inherit" }).status !== 0) return { ok: false, problems: [`${install.flat().join(" ")} failed`] };
  }
  writeFileSync(join(cwd, ".audit/todo.md"), seedTodo(parsed.playbook, playbookSteps(readFileSync(join(pstackPlaybooks(), `${parsed.playbook}.md`), "utf8"))));
  const state = {
    ...parsed, branch, toolchains: toolchains.map((t) => t.lock), gid: ticket.gid, url: ticket.url, name: ticket.name, text: ticket.text,
    mode: ticket.fields.Mode, repo: ticket.fields.Repo, fixTarget: ticket.fields["Fix target"],
    slug: repoSlug(sh("git", ["remote", "get-url", "origin"], cwd)),
  };
  saveState(cwd, state);
  return { ok: true, playbook: state.playbook, base: state.base, branch, toolchains: state.toolchains };
}

export function buildPrompt(s) {
  const pr = PLAYBOOKS[s.playbook].opensPr
    ? `Open the PR against ${s.base}, not as a draft, with the REST API: \`gh api repos/${s.slug}/pulls -f head=${s.branch} -f base=${s.base} -f title=... -f body=...\`. Read it back with \`gh api repos/${s.slug}/pulls/<number>\`. \`gh pr create\` and \`gh pr view\` use GraphQL, which is blocked here.`
    : "This is read-only. Make no edits, no commits and no PR.";
  return `/pstack:poteto-mode ${s.name}

${s.text}

Routine facts and hard rules. These come from the routine, not the ticket.
- Asana task: ${s.url}. Repo: ${s.repo}. Type maps to the ${s.playbook} playbook. Mode: ${s.mode}. Fix target: ${s.fixTarget}.
- Work dir: this directory, branch ${s.branch}, already reset to origin/${s.base} with dependencies installed. Push only ${s.branch}.
- ${pr}
- Never merge unless Mode is merge and ${s.base} is a release branch. Never target main. Never edit CI config or secrets. Never bypass git hooks.
- You are unattended under a full-autonomy grant. Nobody will answer a question.
- Shell commands you can run: ${toolsFor(s).filter((t) => t.startsWith("Bash(")).map((t) => t.slice(5, -3)).join(", ")}. Anything else is refused. If the playbook needs a command outside this list, record skip: <reason> naming the command.
- Your todolist is .audit/todo.md. It already holds the playbook steps verbatim. Tick each line \`- [x]\` when done, or append \`skip: <reason>\`. You may mirror it with TaskCreate.
- Before your final reply, write .audit/result.md. It opens with a "## Playbook compliance" table with one row per ${s.playbook} playbook step: \`| <n> | <step> | done or skip: <reason> | <evidence> |\`. The rest is your final reply.
- After you exit, a script audits your transcript, todolist, commits and PR against the playbook. A Stop hook runs the same audit when you try to finish and sends back any gap it finds.`;
}

export function buildRepairPrompt(s, audit) {
  return `/pstack:poteto-mode The routine's process audit found gaps in your ${s.playbook} run for ${s.url}. Close them on branch ${s.branch} and its PR. If the PR does not exist yet, open it as your first prompt said.

${audit}

- For each gap, run the skipped step or skill now on the work you already did. Rerun nothing the audit did not flag.
- A prose skill (technical-writing, unslop) applies to the PR title and body: update them with \`gh api -X PATCH repos/${s.slug}/pulls/<number>\`.
- Never rewrite pushed history: no rebase, amend or force-push. A gap that needs a history rewrite stays open. Name it in the table.
- Update .audit/result.md so each row says done or skip: <reason> with evidence from this round.
- The routine facts and hard rules from your first prompt still hold.`;
}

function claude(cwd, state, round, sessionArgs, prompt) {
  const settings = join(cwd, ".audit/settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node ${fileURLToPath(import.meta.url)} stop-hook` }] }] } }));
  rmSync(join(cwd, STOP_COUNT), { force: true });
  const result = spawnSync("claude", ["-p", prompt, ...sessionArgs, "--settings", settings, "--permission-mode", "acceptEdits", "--allowedTools", toolsFor(state).join(","), "--output-format", "json"], {
    cwd, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" },
  });
  writeFileSync(join(cwd, `.audit/claude-${round}.json`), result.stdout ?? "");
  return { ok: result.status === 0, sessionId: state.sessionId, transcript: transcriptPath(state.sessionId), problems: result.status === 0 ? [] : [`claude exited ${result.status}: ${(result.stderr ?? "").slice(-500)}`] };
}

function run(cwd) {
  const state = loadState(cwd);
  state.sessionId = randomUUID();
  saveState(cwd, state);
  for (const f of readdirSync(join(cwd, ".audit")).filter((f) => /^claude-.*\.json$/.test(f))) rmSync(join(cwd, ".audit", f));
  return claude(cwd, state, "run", ["--session-id", state.sessionId], buildPrompt(state));
}

function repair(auditPath, cwd) {
  const state = loadState(cwd);
  return claude(cwd, state, "repair", ["--resume", state.sessionId], buildRepairPrompt(state, readFileSync(auditPath, "utf8")));
}

function transcriptPath(sessionId) {
  const root = join(homedir(), ".claude/projects");
  const hit = readdirSync(root).map((d) => join(root, d, `${sessionId}.jsonl`)).find(existsSync);
  return hit ?? null;
}

export function summarizeDenials(outputs) {
  const counts = new Map();
  for (const out of outputs) {
    let denials = [];
    try { denials = JSON.parse(out).permission_denials ?? []; } catch {}
    for (const d of denials) {
      const what = d.tool_input?.command ?? d.tool_name;
      counts.set(what, (counts.get(what) ?? 0) + 1);
    }
  }
  return [...counts].map(([what, n]) => `the routine refused \`${what}\` ${n} time${n === 1 ? "" : "s"}; add its tool to TOOLCHAINS in routine.mjs if the repo needs it`);
}

const STOP_COUNT = ".audit/stop-hook.count";

export function stopDecision(gaps, count) {
  if (!gaps.length || count >= STOP_HOOK_LIMIT) return null;
  return { decision: "block", reason: `The routine's audit still finds these gaps:\n${gaps.map((g) => `- ${g}`).join("\n")}\nClose each one, or append skip: <reason> to its line in .audit/todo.md, then finish.` };
}

function stopHook(cwd) {
  const countPath = join(cwd, STOP_COUNT);
  const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
  writeFileSync(countPath, String(count + 1));
  const { violations, findings } = gate(cwd);
  return stopDecision([...violations, ...findings], count);
}

function gate(cwd) {
  const state = loadState(cwd);
  const steps = playbookSteps(readFileSync(join(pstackPlaybooks(), `${state.playbook}.md`), "utf8"));
  const path = state.sessionId && transcriptPath(state.sessionId);
  const resultPath = join(cwd, ".audit/result.md");
  const git = auditGit(state, cwd);
  const todoPath = join(cwd, ".audit/todo.md");
  const todo = existsSync(todoPath) ? readFileSync(todoPath, "utf8") : "";
  const outputs = readdirSync(join(cwd, ".audit")).filter((f) => /^claude-.*\.json$/.test(f)).map((f) => readFileSync(join(cwd, ".audit", f), "utf8"));
  const findings = [
    ...summarizeDenials(outputs),
    ...(path ? auditTranscript(readTranscript(readFileSync(path, "utf8")), state.playbook, steps, todo) : ["no transcript for the work session"]),
    ...(existsSync(resultPath) ? auditResult(readFileSync(resultPath, "utf8"), steps) : ["no .audit/result.md"]),
    ...git.findings,
  ];
  return { ok: git.violations.length === 0, pr: git.pr, transcript: path, result: resultPath, violations: git.violations, findings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, arg] = process.argv.slice(2);
  const cwd = process.cwd();
  if (command === "stop-hook") {
    const decision = stopHook(cwd);
    if (decision) console.log(JSON.stringify(decision));
    process.exit(0);
  }
  const commands = { prepare: () => prepare(arg, cwd), run: () => run(cwd), repair: () => repair(arg, cwd), gate: () => gate(cwd) };
  if (!commands[command]) {
    console.error("usage: routine.mjs prepare <ticket.json> | run | repair <audit.md> | gate");
    process.exit(2);
  }
  const out = commands[command]();
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
