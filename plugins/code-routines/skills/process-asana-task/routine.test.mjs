import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditGit, auditResult, auditTranscript, gate, prBodyFindings, prReadiness, unreleasedSection, NO_DRIVER, NOT_DELEGATED } from "./lib/audit.mjs";
import { findPrTemplate, missingTemplateHeadings, repoSlug } from "./lib/github.mjs";
import { preToolDecision, stopDecision, stopHook } from "./lib/hooks.mjs";
import { ciState, failedMergeChecks, reviewVerdict } from "./lib/merge.mjs";
import { playbookStepsFor, pstackPlaybooks, pstackRoot, seedTodo } from "./lib/playbooks.mjs";
import { openPr } from "./lib/pr.mjs";
import { checkoutWorkBranch, ignoreAudit } from "./lib/prepare.mjs";
import { shrinkScreenshot, withScreenshots } from "./lib/screenshots.mjs";
import { browserFact, buildPrompt, buildRepairPrompt, toolsFor } from "./lib/session.mjs";
import { baseFor, parseTicket, playbookFor } from "./lib/ticket.mjs";
import { readTranscript, summarizeDenials, transcriptPath } from "./lib/transcript.mjs";

const trySpawn = (cmd) => spawnSync(cmd, ["-version"]).status === 0;
const steps = playbookStepsFor("bug-fix");

let n = 0;
const line = (type, content) => JSON.stringify({ type, isSidechain: false, message: { content } });
const call = (name, input, result = "ok") => {
  const id = `t${++n}`;
  return [line("assistant", [{ type: "tool_use", id, name, input }]), line("user", [{ type: "tool_result", tool_use_id: id, content: result }])];
};
const prompt = line("user", "<command-name>/pstack:poteto-mode</command-name> fix tooltip");

const compliant = [
  prompt,
  ...steps.flatMap((s, i) => [
    ...call("TaskCreate", { subject: `${s.n}. ${s.text}`, description: "" }, `Task #${i + 1} created successfully`),
    ...call("TaskUpdate", { taskId: String(i + 1), status: "completed" }),
  ]),
  ...call("Agent", { subagent_type: "pstack:poteto-agent", prompt: "fix" }),
  ...["how", "why", "pstack:tdd", "run", "deslop", "no-comments", "technical-writing", "unslop"].flatMap((skill) => call("Skill", { skill })),
  ...call("Bash", { command: "node /x/scripts/check-playbooks.mjs" }),
].join("\n");

const observedFailure = [prompt, ...call("Skill", { skill: "pstack:poteto-mode" }), ...call("Bash", { command: "npm test" })].join("\n");

test("bug-fix playbook has numbered steps to audit", () => {
  assert.ok(steps.length >= 5, `found ${steps.length} steps`);
});

test("compliant transcript passes", () => {
  assert.deepEqual(auditTranscript(readTranscript(compliant), { playbook: "bug-fix", steps }), []);
});

test("observed failure is blocked on every skipped step", () => {
  const problems = auditTranscript(readTranscript(observedFailure), { playbook: "bug-fix", steps, projectPlaybooks: true });
  for (const want of ["todolist lacks bug-fix step 1", "deslop has not run", "no-comments has not run", "technical-writing has not run", "skill how never ran", "no driver skill", "not delegated", "check-playbooks.mjs never ran", "skill why neither ran"]) {
    assert.ok(problems.some((p) => p.includes(want)), `missing: ${want}\n${problems.join("\n")}`);
  }
});

test("a todolist skip: reason excuses a skippable skill only", () => {
  const withSkip = compliant.replace(/"skill":"why"/, '"skill":"nope"') + "\n" + call("TaskCreate", { subject: "why: skip: new code, no regression history" }, "Task #99 created").join("\n");
  assert.deepEqual(auditTranscript(readTranscript(withSkip), { playbook: "bug-fix", steps }), []);
  const noDeslop = compliant.replace(/"skill":"deslop"/, '"skill":"nope"') + "\n" + call("TaskCreate", { subject: "deslop skip: small" }, "Task #98 created").join("\n");
  assert.deepEqual(auditTranscript(readTranscript(noDeslop), { playbook: "bug-fix", steps }), ["deslop has not run after the last delegate's work"]);
});

test("an incomplete step fails", () => {
  const pending = compliant.replace(/"taskId":"2","status":"completed"/, '"taskId":"2","status":"in_progress"');
  assert.deepEqual(auditTranscript(readTranscript(pending), { playbook: "bug-fix", steps }), ["todolist step 2 is in_progress, not completed"]);
});

test("subagent tool calls do not count for the lead", () => {
  const sidechain = compliant.replaceAll('"isSidechain":false', '"isSidechain":true');
  assert.ok(auditTranscript(readTranscript(sidechain), { playbook: "bug-fix", steps }).length > 5);
});

test("compliance table needs a row per step", () => {
  const rows = steps.map((s) => `| ${s.n} | step | ${s.n === 5 ? "skip: no cheap test" : "done"} | ev |`).join("\n");
  assert.deepEqual(auditResult(`## Playbook compliance\n${rows}`, steps), []);
  assert.deepEqual(auditResult(`## Playbook compliance\n${rows.replace(/\| 3 \|.*\n/, "")}`, steps), ["compliance table has no done or skip: row for step 3"]);
  assert.deepEqual(auditResult("all good", steps), ["result has no Playbook compliance table"]);
});

test("ticket fields map to playbook and BASE", () => {
  const fields = { Repo: "embed-app", Type: "Bug", Mode: "pr", "Fix target": "release", "Release version": "v2.4.1" };
  const ticket = { gid: "1", url: "https://app.asana.com/0/0/1", name: "n", text: "t", fields };
  assert.deepEqual(parseTicket(ticket), { gid: "1", url: ticket.url, name: "n", text: "t", mode: "pr", repo: "embed-app", fixTarget: "release", playbook: "bug-fix", base: "release-2.x" });
  assert.equal(playbookFor({ Type: "Feature", Mode: "review only" }), "investigation");
  assert.equal(playbookFor({ Type: "Explore", Mode: "pr" }), "investigation");
  assert.equal(baseFor("3.0.0"), "release-3.x");
  assert.match(parseTicket({ fields: { ...fields, "Release version": "" } }).error, /Release version/);
  assert.match(parseTicket({ fields: { ...fields, Type: "Chore" } }).error, /unknown Type/);
});

test("changelog Unreleased section and repo slug parse", () => {
  const log = "# Changelog\n\n## [Unreleased]\n- Fix tooltip\n\n## [2.4.0]\n- Old\n";
  assert.equal(unreleasedSection(log).trim(), "- Fix tooltip");
  assert.equal(unreleasedSection("## [Unreleased]\n- Only\n").trim(), "- Only");
  assert.equal(repoSlug("http://local_proxy@127.0.0.1:1234/git/Giving-Tuesday/embed-app"), "Giving-Tuesday/embed-app");
  assert.equal(repoSlug("git@github.com:Giving-Tuesday/embed-app.git"), "Giving-Tuesday/embed-app");
});

test("repair prompt resumes poteto-mode with the audit and forbids history rewrites", () => {
  const prompt = buildRepairPrompt({ playbook: "bug-fix", url: "https://app.asana.com/0/0/1", branch: "claude/x", slug: "o/r" }, "- skill unslop never ran");
  assert.match(prompt, /^\/pstack:poteto-mode /);
  assert.ok(prompt.includes("- skill unslop never ran"));
  assert.match(prompt, /Rewrite \.audit\/pr-title\.txt and \.audit\/pr-body\.md/);
  assert.ok(!/gh api -X PATCH/.test(prompt));
  assert.match(prompt, /Never rewrite pushed history/);
});

test("a uv repo gets uv and pytest; a Node-only repo does not", () => {
  const uv = toolsFor({ toolchains: ["uv.lock"] });
  assert.ok(uv.includes("Bash(uv:*)") && uv.includes("Bash(pytest:*)"));
  assert.ok(!toolsFor({ toolchains: ["package-lock.json"] }).includes("Bash(uv:*)"));
});

test("the seeded todo.md satisfies the todolist check once ticked or skipped", () => {
  const todo = seedTodo("bug-fix", steps);
  assert.match(todo, /Opening a PR: run \/deslop/);
  assert.match(todo, /Opening a PR: write the PR title to \.audit\/pr-title\.txt and the body to \.audit\/pr-body\.md/);
  assert.doesNotMatch(todo, /read the PR back/);
  const noTasks = readTranscript([prompt, ...call("Skill", { skill: "how" })].join("\n"));
  assert.ok(auditTranscript(noTasks, { playbook: "bug-fix", steps, todo }).some((p) => p.includes("step 1")));
  const ticked = todo.replace(/- \[ \] 1\./, "- [x] 1.").replace(/(- \[ \] 2\..*)/, "$1 skip: one file");
  const problems = auditTranscript(noTasks, { playbook: "bug-fix", steps, todo: ticked });
  assert.ok(!problems.some((p) => /step (1|2)\b/.test(p)), problems.join("\n"));
});

test("permission refusals are counted per command", () => {
  const out = JSON.stringify({ permission_denials: [{ tool_name: "Bash", tool_input: { command: "uv run pytest" } }, { tool_name: "Bash", tool_input: { command: "uv run pytest" } }] });
  assert.deepEqual(summarizeDenials([out, ""]), ["the routine refused `uv run pytest` 2 times"]);
});

test("the Stop hook blocks while gaps remain, up to its limit", () => {
  assert.equal(stopDecision([], 0), null);
  assert.match(stopDecision(["skill unslop never ran"], 0).reason, /- skill unslop never ran/);
  assert.equal(stopDecision(["skill unslop never ran"], 0).decision, "block");
  assert.equal(stopDecision(["skill unslop never ran"], 3), null);
});

test("merge checks pass only for a clean merge-mode run", () => {
  const ci = mkdtempSync(join(tmpdir(), "routine-"));
  mkdirSync(join(ci, ".audit"));
  writeFileSync(join(ci, ".audit/ci.json"), JSON.stringify({ state: "green" }));
  writeFileSync(join(ci, ".audit/review.md"), "PASS\n\nNo high or critical findings.\n");
  const clean = { cwd: ci, mode: "merge", base: "release-2.x", violations: [], findings: ["skill how never ran"], pr: { state: "open", base: "release-2.x" } };
  assert.deepEqual(failedMergeChecks(clean), []);
  writeFileSync(join(ci, ".audit/ci.json"), JSON.stringify({ state: "red" }));
  assert.deepEqual(failedMergeChecks(clean), ["CI is green or the repo has none"]);
  writeFileSync(join(ci, ".audit/ci.json"), JSON.stringify({ state: "green" }));
  assert.deepEqual(failedMergeChecks({ ...clean, mode: "pr" }), ["Mode is merge"]);
  assert.deepEqual(failedMergeChecks({ ...clean, violations: ["no PR"], pr: null }), ["the gate has no violations", "the PR is open against BASE"]);
});

test("CI state reads check runs", () => {
  assert.deepEqual(ciState([]), { state: "none", failed: [] });
  assert.equal(ciState([{ name: "lint", status: "in_progress" }]).state, "pending");
  assert.deepEqual(ciState([{ name: "lint", status: "completed", conclusion: "success" }, { name: "test", status: "completed", conclusion: "failure" }]), { state: "red", failed: ["test"] });
  assert.equal(ciState([{ name: "lint", status: "completed", conclusion: "skipped" }]).state, "green");
});

test("the review verdict is the first line of review.md, and a missing file fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-"));
  assert.equal(reviewVerdict(join(dir, "review.md")), null);
  writeFileSync(join(dir, "review.md"), "\nFAIL\n| high | src/a.ts:3 | null deref |\n");
  assert.equal(reviewVerdict(join(dir, "review.md")), "FAIL");
});

test("playbook findings never fail a merge check, but gate violations do", () => {
  const dir = mkdtempSync(join(tmpdir(), "outcome-"));
  mkdirSync(join(dir, ".audit"));
  writeFileSync(join(dir, ".audit/ci.json"), JSON.stringify({ state: "green" }));
  writeFileSync(join(dir, ".audit/review.md"), "PASS\n");
  writeFileSync(join(dir, ".audit/comments.md"), "FINDINGS: 3\n");
  const ctx = { cwd: dir, mode: "merge", base: "release-2.x", violations: [], pr: { state: "open", base: "release-2.x" } };
  assert.deepEqual(failedMergeChecks({ ...ctx, findings: ["skill how never ran", "todolist step 3 is pending, not completed", "deslop has not run", NO_DRIVER, NOT_DELEGATED] }), []);
  assert.deepEqual(failedMergeChecks({ ...ctx, findings: [], violations: ["touches CI config or secrets: .github/x.yml"] }), ["the gate has no violations"]);
});

test("the PreToolUse hook refuses only merges, trunk pushes and PR writes", () => {
  const edit = (path) => ({ tool_name: "Edit", tool_input: { file_path: path } });
  const bash = (command, agent_id) => ({ tool_name: "Bash", tool_input: { command }, agent_id });
  for (const playbook of ["bug-fix", "feature"]) {
    assert.equal(preToolDecision(edit("/w/src/tooltip.ts"), playbook, "release-1.x"), null);
    assert.equal(preToolDecision(edit("/tmp/scratch.js"), playbook, "release-1.x"), null);
    assert.equal(preToolDecision(edit("/w/.audit/todo.md"), playbook, "release-1.x"), null);
    assert.equal(preToolDecision(bash("git add -A && git commit -m x"), playbook, "release-1.x"), null);
    assert.match(preToolDecision(bash("git push origin HEAD:release-1.x"), playbook, "release-1.x"), /routine merges/);
    assert.match(preToolDecision(bash("gh pr merge 3"), playbook, "release-1.x"), /routine merges/);
  }
  for (const command of ["gh api repos/o/r/pulls -f head=b -f base=release-1.x -F body=@x", "gh api repos/o/r/pulls --input pr.json", "gh api -X PATCH repos/o/r/pulls/3 -f body=x", "gh api --method POST repos/o/r/pulls", "gh pr create --fill"]) {
    for (const agent_id of [undefined, "a1"]) assert.match(preToolDecision(bash(command, agent_id), "bug-fix", "release-1.x"), /routine opens and updates the PR/, command);
  }
  assert.equal(preToolDecision(bash("gh api repos/o/r/pulls/3"), "bug-fix", "release-1.x"), null);
});

test("the prompt names the Playwright browser only where one is installed", () => {
  assert.equal(browserFact({}), "");
  assert.match(browserFact({ PLAYWRIGHT_BROWSERS_PATH: "/opt/pw-browsers" }), /require\("playwright"\).*\/opt\/pw-browsers.*google-chrome is not installed/s);
});

test("the pstack root handed to --add-dir holds the poteto-mode playbooks", () => {
  assert.ok(existsSync(join(pstackRoot(), "skills/poteto-mode/playbooks/bug-fix.md")));
});

test("the repo's PR template is found and its headings are checked in the PR body", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpl-"));
  assert.equal(findPrTemplate(dir), null);
  mkdirSync(join(dir, ".github/PULL_REQUEST_TEMPLATE"), { recursive: true });
  writeFileSync(join(dir, ".github/PULL_REQUEST_TEMPLATE/feature.md"), "## Summary\n");
  assert.equal(findPrTemplate(dir), ".github/PULL_REQUEST_TEMPLATE/feature.md");
  writeFileSync(join(dir, ".github/pull_request_template.md"), "## Summary\n\n<!-- what -->\n\n## Test plan\n\n### Screenshots\n");
  assert.equal(findPrTemplate(dir), ".github/pull_request_template.md");
  const template = readFileSync(join(dir, ".github/pull_request_template.md"), "utf8");
  assert.deepEqual(missingTemplateHeadings(template, "## Summary\nFixes it.\n## Test plan\nRan it.\n### Screenshots\nnone\n"), []);
  assert.deepEqual(missingTemplateHeadings(template, "## Why\nFixes it.\n## Test plan\n"), ["Summary", "Screenshots"]);
  assert.deepEqual(missingTemplateHeadings(template, null), ["Summary", "Test plan", "Screenshots"]);
  const prompt = buildPrompt({ playbook: "bug-fix", base: "release-1.x", slug: "o/r", branch: "b", toolchains: [], prTemplate: ".github/pull_request_template.md", name: "n", text: "t", url: "u", repo: "r", mode: "pr", fixTarget: "f" });
  assert.match(prompt, /headings of the repo's template, \.github\/pull_request_template\.md/);
  assert.match(prompt, /mkdir, echo, printf, cd, pwd, wc, sort, uniq, diff, test, jq, cp, mv, touch\./);
});

test("screenshots go under the template's Screenshots heading, once, however often attached", () => {
  const img = [{ name: "after.png", url: "https://github.com/o/r/blob/abc/b/after.png?raw=true" }];
  const appended = withScreenshots("## Why\nFix.", img);
  assert.match(appended, /## Why\nFix\.\n\n## Screenshots\n\n<!-- routine-screenshots -->\n!\[after\.png\]\(https:\/\/github\.com\/o\/r\/blob\/abc\/b\/after\.png\?raw=true\)/);
  assert.equal(withScreenshots(appended, img), appended);
  const templated = withScreenshots("## Summary\nx\n\n### Screenshots\n\n## Test plan\ny", img);
  assert.match(templated, /### Screenshots\n\n<!-- routine-screenshots -->\n!\[after\.png\][^\n]*\n<!-- \/routine-screenshots -->\n\n## Test plan/);
  assert.equal((templated.match(/## Screenshots/g) ?? []).length, 1);
});

test("screenshots shrink to at most 1280 px wide before upload", { skip: !trySpawn("convert") }, () => {
  const dir = mkdtempSync(join(tmpdir(), "shrink-"));
  const big = join(dir, "big.png");
  execFileSync("convert", ["-size", "2560x1600", "gradient:#3b82f6-#1e3a8a", big]);
  const small = shrinkScreenshot(big, join(dir, "out"));
  assert.notEqual(small, big);
  assert.equal(execFileSync("identify", ["-format", "%w", small], { encoding: "utf8" }), "1280");
  assert.ok(statSync(small).size < statSync(big).size);
});

test("the work session may not merge or write to trunk, lead or subagent, in any playbook", () => {
  const decide = (command, agent_id) => preToolDecision({ tool_name: "Bash", tool_input: { command }, agent_id }, "investigation", "release-2.x");
  const refused = [
    "gh api -X PUT repos/o/r/pulls/12/merge",
    "gh pr merge 12 --merge",
    "git push origin release-2.x",
    "git push origin HEAD:release-2.x",
    "git push -f origin HEAD:refs/heads/main",
    "git push origin main",
    "git -C /w push origin HEAD:release-2.x",
    "git --no-pager push origin HEAD:main",
    "git -c push.default=current push origin HEAD:master",
    "git push origin 'HEAD:release-2.x'",
    'git push origin "HEAD:main"',
    "gh api -X PATCH repos/o/r/git/refs/heads/release-2.x -f sha=abc",
    "gh api repos/o/r/merges -f base=release-2.x -f head=claude/x",
    "gh api -X POST repos/o/r/merges --input m.json",
    "gh api -X PUT repos/o/r/contents/a.txt -f message=x -f content=eA== -f branch=release-2.x",
    "gh api -X PUT repos/o/r/contents/a.txt -f message=x -f content=eA== -f 'branch=main'",
    "gh api -X PUT repos/o/r/contents/a.txt -f message=x -f content=eA==",
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
  ];
  for (const command of refused) {
    for (const agent_id of [undefined, "a1"]) assert.match(decide(command, agent_id) ?? "", /routine merges/, command);
  }
  const allowed = [
    "git push -u origin claude/fix-tooltip",
    "gh api repos/o/r/pulls/12",
    "git push origin claude/release-2.x-fix",
    "gh api repos/o/r/pulls/12/merged-files",
    "gh api repos/o/r/git/refs/heads/release-2.x",
    "gh api repos/o/r/contents/a.txt?ref=main",
    "gh api -X PUT repos/o/r/contents/a.txt -f message=x -f content=eA== -f branch=claude/x",
    "gh api graphql -f query='query { viewer { login } }'",
  ];
  for (const command of allowed) assert.equal(decide(command), null, command);
});

test("the work session may not force-push, but may push new commits", () => {
  const decide = (command) => preToolDecision({ tool_name: "Bash", tool_input: { command } }, "bug-fix", "release-2.x");
  const forced = [
    "git push --force origin claude/x",
    "git push -f origin claude/x",
    "git push --force-with-lease origin claude/x",
    "git push origin +claude/x",
    "git push -fu origin claude/x",
    "git push -uf origin claude/x",
    "git --no-pager push -f origin claude/x",
    "git -c core.askPass=x push -f origin claude/x",
    "git push origin '+claude/x'",
    'git push "--force" origin claude/x',
  ];
  for (const command of forced) assert.match(decide(command) ?? "", /Never rewrite pushed history/, command);
  const allowed = [
    "git push -u origin claude/x",
    'git commit -m "push -f"',
    'git --no-pager commit -m "push -f"',
    "git --no-pager log -n 1",
    "git push --follow-tags origin claude/x",
  ];
  for (const command of allowed) assert.equal(decide(command), null, command);
});

test("the PR is ready only when deslop and no-comments ran after the last delegate", () => {
  const seq = (...steps) => readTranscript([prompt, ...steps.flatMap(([name, input]) => call(name, input))].join("\n"));
  const skill = (s) => ["Skill", { skill: s }];
  const delegate = ["Agent", { subagent_type: "pstack:poteto-agent", prompt: "fix" }];
  const sicko = ["Agent", { subagent_type: "pstack:comment-sicko", prompt: "review" }];
  assert.deepEqual(prReadiness(seq(delegate, skill("pstack:deslop"), skill("no-comments"), sicko, skill("technical-writing"), skill("unslop"))), []);
  assert.deepEqual(prReadiness(seq(skill("deslop"), skill("no-comments"), delegate, skill("technical-writing"), skill("unslop"))), ["deslop has not run after the last delegate's work", "no-comments has not run after the last delegate's work"]);
  assert.deepEqual(prReadiness(seq(delegate, skill("deslop"), skill("no-comments"))), ["technical-writing has not run", "unslop has not run"]);
});

test("prepare's checkout never discards uncommitted changes or unpushed commits", () => {
  const root = mkdtempSync(join(tmpdir(), "checkout-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "-q", "--bare", "origin.git");
  git(root, "init", "-q", "-b", "main", "work");
  const work = join(root, "work");
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-qm", "base");
  git(work, "remote", "add", "origin", join(root, "origin.git"));
  git(work, "push", "-q", "origin", "main:release-2.x", "main:main");
  git(work, "fetch", "-q", "origin");
  git(work, "switch", "-q", "-c", "claude/session");
  mkdirSync(join(work, ".audit"));
  writeFileSync(join(work, ".audit/ticket.json"), "{}");

  writeFileSync(join(work, "a.txt"), "edited\n");
  assert.match(checkoutWorkBranch(work, "claude/session", "release-2.x")[0], /uncommitted changes.*a\.txt/);
  assert.equal(readFileSync(join(work, "a.txt"), "utf8"), "edited\n");
  git(work, "checkout", "-q", "a.txt");

  writeFileSync(join(work, "b.txt"), "b\n");
  git(work, "add", "b.txt");
  git(work, "commit", "-qm", "local only");
  assert.match(checkoutWorkBranch(work, "claude/session", "release-2.x")[0], /commits that are on no remote/);
  assert.ok(existsSync(join(work, "b.txt")));

  git(work, "push", "-q", "origin", "claude/session");
  assert.deepEqual(checkoutWorkBranch(work, "claude/session", "release-2.x"), []);
  assert.equal(git(work, "rev-parse", "HEAD"), git(work, "rev-parse", "origin/release-2.x"));
  assert.ok(existsSync(join(work, ".audit/ticket.json")));
  assert.deepEqual(checkoutWorkBranch(work, "claude/asana-1", "release-2.x"), []);
  assert.equal(git(work, "rev-parse", "--abbrev-ref", "HEAD"), "claude/asana-1");
});

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function workRepo() {
  const root = mkdtempSync(join(tmpdir(), "gate-"));
  git(root, "init", "-q", "--bare", "origin.git");
  git(root, "init", "-q", "-b", "main", "work");
  const work = join(root, "work");
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-qm", "base");
  git(work, "remote", "add", "origin", join(root, "origin.git"));
  git(work, "push", "-q", "origin", "main:release-2.x");
  git(work, "fetch", "-q", "origin");
  return { root, work, base: git(work, "rev-parse", "HEAD") };
}

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); }
};

test("check-playbooks.mjs is required only when the repo has project playbooks", () => {
  const transcript = readTranscript(observedFailure);
  assert.ok(!auditTranscript(transcript, { playbook: "bug-fix", steps }).some((p) => p.includes("check-playbooks.mjs")));
  assert.ok(auditTranscript(transcript, { playbook: "bug-fix", steps, projectPlaybooks: true }).some((p) => p.includes("check-playbooks.mjs never ran")));
});

test("a worktree, or a checkout with no info/exclude, still gets .audit/ ignored", () => {
  const { root, work } = workRepo();
  rmSync(join(work, ".git/info/exclude"), { force: true });
  const tree = join(root, "tree");
  git(work, "worktree", "add", "-q", "-b", "wt", tree);
  ignoreAudit(tree);
  ignoreAudit(tree);
  assert.equal(readFileSync(join(work, ".git/info/exclude"), "utf8").split(".audit/").length, 2);
  mkdirSync(join(tree, ".audit"));
  writeFileSync(join(tree, ".audit/x"), "x");
  assert.doesNotMatch(git(tree, "status", "--porcelain", "--untracked-files=all"), /\.audit/);
});

test("a slash or plugin prefix on a skill name counts for every skill check", () => {
  const seq = (...names) => readTranscript([prompt, ...call("Agent", { subagent_type: "pstack:poteto-agent", prompt: "fix" }), ...names.flatMap((skill) => call("Skill", { skill }))].join("\n"));
  assert.deepEqual(prReadiness(seq("/deslop", "pstack:no-comments", "/pstack:technical-writing", "unslop")), []);
  const problems = auditTranscript(seq("/how", "/pstack:verify", "/pstack:deslop", "/why", "/tdd", "/no-comments", "/technical-writing", "/unslop"), { playbook: "bug-fix", steps });
  assert.ok(!problems.some((p) => /never ran|has not run|no driver|neither ran/.test(p)), problems.join("\n"));
});

test("env files are forbidden at any depth and CI dirs only at the root", () => {
  const { work, base } = workRepo();
  git(work, "switch", "-q", "-c", "claude/t");
  mkdirSync(join(work, "apps/web"), { recursive: true });
  mkdirSync(join(work, "docs/.github"), { recursive: true });
  for (const f of ["apps/web/.env", "apps/web/.env.local", ".circleci/c.yml", "docs/.github/n.md", "apps/web/env.ts", "apps/web/.env.example", "src/.environment.ts"]) {
    mkdirSync(join(work, f, ".."), { recursive: true });
    writeFileSync(join(work, f), "x\n");
  }
  git(work, "add", "-A", "-f");
  git(work, "commit", "-qm", "work");
  const state = { baseSha: base, base: "release-2.x", branch: "claude/t", playbook: "feature", slug: "none/none" };
  const { violations } = auditGit(state, work);
  assert.deepEqual(violations.filter((v) => v.startsWith("touches")), ["touches CI config or secrets: .circleci/c.yml", "touches CI config or secrets: apps/web/.env", "touches CI config or secrets: apps/web/.env.local"]);
});

test("a compliance row passes only when its third cell starts with done or skip:", () => {
  const table = (cell) => `## Playbook compliance\n${steps.map((s) => `| ${s.n} | step | ${s.n === 1 ? cell : "done"} | ev |`).join("\n")}`;
  assert.deepEqual(auditResult(table("done"), steps), []);
  assert.deepEqual(auditResult(table("skip: no cheap test"), steps), []);
  assert.deepEqual(auditResult(table("missing"), steps).length, 1);
  assert.equal(auditResult(`## Playbook compliance\n| 1 | x | missing | not done |`, steps).length, steps.length);
});

test("CLAUDE_CONFIG_DIR relocates the transcripts and the pstack playbooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  mkdirSync(join(dir, "projects/p"), { recursive: true });
  writeFileSync(join(dir, "projects/p/sess.jsonl"), "");
  const playbooks = join(dir, "plugins/cache/m/pstack/1.0.0/skills/poteto-mode/playbooks");
  mkdirSync(playbooks, { recursive: true });
  writeFileSync(join(playbooks, "bug-fix.md"), "1. x\n");
  withEnv({ CLAUDE_CONFIG_DIR: dir, PSTACK_POTETO_DIR: undefined }, () => {
    assert.equal(transcriptPath("sess"), join(dir, "projects/p/sess.jsonl"));
    assert.equal(pstackPlaybooks(), playbooks);
  });
});

test("a denial with neither a command nor a tool name is still summarized", () => {
  assert.equal(summarizeDenials([JSON.stringify({ permission_denials: [{}] })]).length, 1);
});

test("the PR body is checked against the template, from pr-body.md before the PR opens", () => {
  const { work, base } = workRepo();
  git(work, "switch", "-q", "-c", "claude/t");
  writeFileSync(join(work, "b.txt"), "b\n");
  git(work, "add", "b.txt");
  git(work, "commit", "-qm", "work");
  mkdirSync(join(work, ".audit"));
  writeFileSync(join(work, "tpl.md"), "## Summary\n\n## Test plan\n");
  const state = { baseSha: base, base: "release-2.x", branch: "claude/t", playbook: "feature", slug: "none/none", prTemplate: "tpl.md" };
  assert.deepEqual(auditGit(state, work).findings.filter((f) => f.startsWith("PR body")), []);
  writeFileSync(join(work, ".audit/pr-body.md"), "## Why\nx\n## Test plan\n");
  assert.deepEqual(auditGit(state, work).findings.filter((f) => f.startsWith("PR body")), ["PR body lacks the template headings: Summary"]);
  assert.deepEqual(prBodyFindings(work, state, ""), ["PR body lacks the template headings: Summary, Test plan"]);
  assert.deepEqual(prBodyFindings(work, { ...state, prTemplate: null }, ""), []);
});

test("the allowlist includes jq, cp, mv, touch and TaskStop", () => {
  const tools = toolsFor({ toolchains: [] });
  for (const t of ["Bash(jq:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(touch:*)", "TaskStop"]) assert.ok(tools.includes(t), t);
});

function pushedWorkBranch() {
  const repo = workRepo();
  git(repo.work, "switch", "-q", "-c", "claude/t");
  writeFileSync(join(repo.work, "b.txt"), "b\n");
  git(repo.work, "add", "b.txt");
  git(repo.work, "commit", "-qm", "work");
  git(repo.work, "push", "-q", "origin", "claude/t");
  mkdirSync(join(repo.work, ".audit"));
  const state = { baseSha: repo.base, base: "release-2.x", branch: "claude/t", playbook: "feature", slug: "o/r", name: "Fix the tooltip", url: "https://app.asana.com/0/0/1" };
  writeFileSync(join(repo.work, ".audit/routine.json"), JSON.stringify(state));
  return { ...repo, state };
}

function fakeGh(root) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "gh-input.json");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$*" in\n  *--input*) cat > ${log}; echo '{"html_url":"https://github.com/o/r/pull/1","number":1}' ;;\n  *) echo '[]' ;;\nesac\n`, { mode: 0o755 });
  const cfg = join(root, "cfg");
  mkdirSync(join(cfg, "projects"), { recursive: true });
  const env = { PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: cfg, PSTACK_POTETO_DIR: join(pstackPlaybooks(), "..") };
  return { env, sent: () => JSON.parse(readFileSync(log, "utf8")) };
}

test("open-pr opens the PR without pr-title.txt or pr-body.md and reports each default", () => {
  const { root, work, state } = pushedWorkBranch();
  const gh = fakeGh(root);
  const bare = withEnv(gh.env, () => openPr(work));
  assert.equal(bare.ok, true);
  assert.deepEqual(gh.sent(), { title: "Fix the tooltip", body: "Asana task: https://app.asana.com/0/0/1\n", head: "claude/t", base: "release-2.x", draft: false });
  assert.deepEqual(bare.findings.slice(0, 2), ["no .audit/pr-title.txt, used the ticket name", "no .audit/pr-body.md, used a line naming the Asana task"]);
  writeFileSync(join(work, ".audit/result.md"), "## Playbook compliance\n| 1 | x | done | e |\n");
  const fromResult = withEnv(gh.env, () => openPr(work));
  assert.equal(gh.sent().body, "## Playbook compliance\n| 1 | x | done | e |\n");
  assert.ok(fromResult.findings.includes("no .audit/pr-body.md, used .audit/result.md"));
  writeFileSync(join(work, ".audit/pr-title.txt"), "fix(ui): clamp the tooltip\n");
  writeFileSync(join(work, ".audit/pr-body.md"), "## Why\nx\n");
  const written = withEnv(gh.env, () => openPr(work));
  assert.deepEqual([gh.sent().title, gh.sent().body], ["fix(ui): clamp the tooltip", "## Why\nx\n"]);
  assert.ok(!written.findings.some((f) => f.startsWith("no .audit/pr-")), written.findings.join("\n"));
  writeFileSync(join(work, "c.txt"), "c\n");
  git(work, "add", "c.txt");
  git(work, "commit", "-qm", "unpushed");
  assert.deepEqual(withEnv(gh.env, () => openPr(work)).problems, [`origin/${state.branch} does not match HEAD`]);
});

test("permission refusals are reported apart from findings and never reach the Stop hook", () => {
  const { root, work } = pushedWorkBranch();
  const gh = fakeGh(root);
  const denial = { tool_name: "Bash", tool_input: { command: "uv run pytest" } };
  writeFileSync(join(work, ".audit/claude-run.json"), JSON.stringify({ permission_denials: [denial] }));
  const result = withEnv(gh.env, () => gate(work));
  assert.deepEqual(result.refusals, ["the routine refused `uv run pytest` 1 time"]);
  assert.ok(!result.findings.some((f) => f.includes("refused")), result.findings.join("\n"));
  assert.ok(result.violations.includes("no PR for claude/t"));
  const reason = withEnv(gh.env, () => stopHook(work))?.reason ?? "";
  assert.doesNotMatch(reason, /refused|no PR for/);
});
