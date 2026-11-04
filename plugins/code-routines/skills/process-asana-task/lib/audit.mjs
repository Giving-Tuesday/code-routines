import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { branchPushed, findPr, missingTemplateHeadings } from "./github.mjs";
import { PLAYBOOKS, playbookStepsFor } from "./playbooks.mjs";
import { readIfExists, sh, trySh } from "./shell.mjs";
import { PR_BODY, RESULT, TODO, claudeOutputs, loadState } from "./state.mjs";
import { readTranscript, skillName, summarizeDenials, transcriptPath, usedSkill } from "./transcript.mjs";

export const NO_DRIVER = "no driver skill (run or verify) ran on the real surface";
export const NOT_DELEGATED = "code was not delegated to a pstack:poteto-agent subagent";
export const noPr = (branch) => `no PR for ${branch}`;
const DRIVERS = ["run", "verify"];
const DELEGATE = "pstack:poteto-agent";
const TEST_PATH = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/;
const FORBIDDEN_PATH = /^(\.github\/|\.circleci\/|\.gitlab-ci)|(^|\/)\.env($|\.(?!example$|sample$|template$))/;

const normalize = (s) => s.replace(/[*`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

function todolistGaps(transcript, playbook, steps, todo) {
  const problems = [];
  for (const step of steps) {
    const key = normalize(step.text).slice(0, 50);
    const line = todo.split("\n").find((l) => normalize(l).includes(key));
    if (line && (/^- \[x\]/i.test(line) || /skip:/i.test(line))) continue;
    const task = transcript.tasks.find((t) => normalize(t.text).includes(key));
    if (!task) problems.push(`todolist lacks ${playbook} step ${step.n} copied verbatim`);
    else if (task.status !== "completed") problems.push(`todolist step ${step.n} is ${task.status}, not completed`);
  }
  return problems;
}

export function auditTranscript(transcript, playbook, steps, todo = "", { projectPlaybooks = false } = {}) {
  const rules = PLAYBOOKS[playbook];
  const ran = (skill) => usedSkill(transcript.skills, skill);
  const skipped = (word) =>
    [...transcript.tasks.map((t) => t.text), ...todo.split("\n")].some((t) => /skip:/i.test(t) && t.toLowerCase().includes(word));
  const problems = [];
  if (!transcript.prompt.includes("/pstack:poteto-mode")) problems.push("session was not started with /pstack:poteto-mode");
  problems.push(...todolistGaps(transcript, playbook, steps, todo));
  for (const skill of rules.skills.filter((s) => !ran(s))) problems.push(`skill ${skill} never ran`);
  if (rules.opensPr) problems.push(...prReadiness(transcript));
  for (const skill of rules.skippable.filter((s) => !ran(s) && !skipped(s))) {
    problems.push(`skill ${skill} neither ran nor has a skip: reason in the todolist`);
  }
  if (rules.driver && !DRIVERS.some(ran)) problems.push(NO_DRIVER);
  if (rules.delegate && !transcript.agents.includes(DELEGATE) && !ran("arena")) problems.push(NOT_DELEGATED);
  if (projectPlaybooks && !transcript.bash.some((c) => c.includes("check-playbooks.mjs"))) {
    problems.push("check-playbooks.mjs never ran");
  }
  return problems;
}

export function prReadiness(transcript) {
  const lastDelegate = transcript.calls.findLastIndex((c) => c.name === "Agent" && c.input.subagent_type === DELEGATE);
  const ranAfter = (skill) =>
    transcript.calls.some((c, i) => i > lastDelegate && c.name === "Skill" && usedSkill([skillName(c)], skill));
  return [
    ...["deslop", "no-comments"].filter((s) => !ranAfter(s)).map((s) => `${s} has not run after the last delegate's work`),
    ...["technical-writing", "unslop"].filter((s) => !usedSkill(transcript.skills, s)).map((s) => `${s} has not run`),
  ];
}

export function auditResult(markdown, steps) {
  if (!/playbook compliance/i.test(markdown)) return ["result has no Playbook compliance table"];
  return steps
    .filter((s) => !new RegExp(`^\\|\\s*${s.n}\\s*\\|[^|]*\\|\\s*(done|skip:)`, "im").test(markdown))
    .map((s) => `compliance table has no done or skip: row for step ${s.n}`);
}

export function unreleasedSection(changelog) {
  return changelog.match(/^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m)?.[1] ?? "";
}

export function prBodyFindings(cwd, state, body) {
  if (!state.prTemplate || body === null) return [];
  const missing = missingTemplateHeadings(readFileSync(join(cwd, state.prTemplate), "utf8"), body);
  return missing.length ? [`PR body lacks the template headings: ${missing.join(", ")}`] : [];
}

function changelogFindings(cwd, from) {
  const changelog = readIfExists(join(cwd, "CHANGELOG.md"));
  if (changelog === null) return [];
  const before = unreleasedSection(trySh("git", ["show", `${from}:CHANGELOG.md`], cwd) ?? "");
  const added = unreleasedSection(changelog)
    .split("\n")
    .filter((l) => /^\s*[-*] /.test(l) && !before.includes(l));
  return added.length ? [] : ["CHANGELOG.md [Unreleased] has no new bullet"];
}

export function auditGit(state, cwd) {
  const from = state.baseSha ?? `origin/${state.base}`;
  const { base, branch, playbook } = state;
  const lines = (args) => sh("git", args, cwd).split("\n").filter(Boolean);
  const files = (rev) => lines(["diff-tree", "--no-commit-id", "--name-only", "-r", rev]);
  const commits = lines(["rev-list", "--reverse", `${from}..HEAD`]);
  const violations = [];
  const findings = [];
  if (!PLAYBOOKS[playbook].opensPr) {
    if (commits.length) violations.push(`${playbook} must not commit, found ${commits.length} commits`);
    return { violations, findings, pr: null };
  }
  if (!commits.length) return { violations: [`no commits on ${branch} beyond ${from}`], findings, pr: null };
  for (const f of lines(["diff", "--name-only", `${from}...HEAD`]).filter((f) => FORBIDDEN_PATH.test(f))) {
    violations.push(`touches CI config or secrets: ${f}`);
  }
  if (playbook === "bug-fix") {
    const isTest = (f) => TEST_PATH.test(f);
    const first = files(commits[0]);
    if (!first.length || !first.every(isTest)) findings.push("first commit is not a test-only repro commit");
    if (commits.slice(1).every((c) => files(c).every(isTest))) findings.push("no fix commit after the repro commit");
  }
  findings.push(...changelogFindings(cwd, from));
  if (!branchPushed(cwd, branch)) findings.push(`origin/${branch} does not match HEAD`);
  const pr = findPr(cwd, state, "all");
  if (!pr) violations.push(noPr(branch));
  else {
    if (pr.base.ref !== base) violations.push(`PR base is ${pr.base.ref}, expected ${base}`);
    if (pr.merged_at) violations.push("the work session merged the PR; only the routine merges");
  }
  findings.push(...prBodyFindings(cwd, state, pr ? pr.body ?? "" : readIfExists(join(cwd, PR_BODY))));
  if (!pr) return { violations, findings, pr: null };
  return {
    violations,
    findings,
    pr: { url: pr.html_url, number: pr.number, base: pr.base.ref, head: pr.head.sha, state: pr.state },
  };
}

export function gate(cwd) {
  const state = loadState(cwd);
  const steps = playbookStepsFor(state.playbook);
  const path = state.sessionId && transcriptPath(state.sessionId);
  const resultPath = join(cwd, RESULT);
  const resultMd = readIfExists(resultPath);
  const git = auditGit(state, cwd);
  const todo = readIfExists(join(cwd, TODO)) ?? "";
  const audit = { projectPlaybooks: existsSync(join(cwd, ".agents/playbooks")) };
  const refusals = summarizeDenials(claudeOutputs(cwd).map((f) => readFileSync(f, "utf8")));
  const findings = [
    ...(path
      ? auditTranscript(readTranscript(readFileSync(path, "utf8")), state.playbook, steps, todo, audit)
      : ["no transcript for the work session"]),
    ...(resultMd === null ? [`no ${RESULT}`] : auditResult(resultMd, steps)),
    ...git.findings,
  ];
  const { violations, pr } = git;
  return { ok: violations.length === 0, pr, transcript: path, result: resultPath, violations, findings, refusals };
}
