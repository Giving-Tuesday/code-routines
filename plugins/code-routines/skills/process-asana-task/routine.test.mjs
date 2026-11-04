import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allowedTools, auditResult, browserFact, buildPrompt, commentFindings, mergeRefusal, prReadiness, shrinkScreenshot, withScreenshots, findPrTemplate, missingTemplateHeadings, pstackRoot, preToolDecision, NO_DRIVER, NOT_DELEGATED, ciState, failedMergeChecks, reviewVerdict, buildRepairPrompt, seedTodo, stopDecision, summarizeDenials, TOOLCHAINS, pstackPlaybooks, auditTranscript, baseFor, parseTicket, playbookFor, playbookSteps, readTranscript, repoSlug, unreleasedSection } from "./routine.mjs";

const trySpawn = (cmd) => spawnSync(cmd, ["-version"]).status === 0;
const steps = playbookSteps(readFileSync(join(pstackPlaybooks(), "bug-fix.md"), "utf8"));

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
  ...["how", "why", "pstack:tdd", "run", "deslop", "no-comments", "technical-writing", "unslop"].flatMap((skill) => call("Skill", { skill })),
  ...call("Agent", { subagent_type: "pstack:poteto-agent", prompt: "fix" }),
  ...call("Bash", { command: "node /x/scripts/check-playbooks.mjs" }),
].join("\n");

const observedFailure = [prompt, ...call("Skill", { skill: "pstack:poteto-mode" }), ...call("Bash", { command: "npm test" })].join("\n");

test("bug-fix playbook has numbered steps to audit", () => {
  assert.ok(steps.length >= 5, `found ${steps.length} steps`);
});

test("compliant transcript passes", () => {
  assert.deepEqual(auditTranscript(readTranscript(compliant), "bug-fix", steps), []);
});

test("observed failure is blocked on every skipped step", () => {
  const problems = auditTranscript(readTranscript(observedFailure), "bug-fix", steps);
  for (const want of ["todolist lacks bug-fix step 1", "skill deslop never ran", "skill no-comments never ran", "skill how never ran", "no driver skill", "not delegated", "check-playbooks.mjs never ran", "skill why neither ran"]) {
    assert.ok(problems.some((p) => p.includes(want)), `missing: ${want}\n${problems.join("\n")}`);
  }
});

test("a todolist skip: reason excuses a skippable skill only", () => {
  const withSkip = compliant.replace(/"skill":"why"/, '"skill":"nope"') + "\n" + call("TaskCreate", { subject: "why: skip: new code, no regression history" }, "Task #99 created").join("\n");
  assert.deepEqual(auditTranscript(readTranscript(withSkip), "bug-fix", steps), []);
  const noDeslop = compliant.replace(/"skill":"deslop"/, '"skill":"nope"') + "\n" + call("TaskCreate", { subject: "deslop skip: small" }, "Task #98 created").join("\n");
  assert.deepEqual(auditTranscript(readTranscript(noDeslop), "bug-fix", steps), ["skill deslop never ran"]);
});

test("an incomplete step fails", () => {
  const pending = compliant.replace(/"taskId":"2","status":"completed"/, '"taskId":"2","status":"in_progress"');
  assert.deepEqual(auditTranscript(readTranscript(pending), "bug-fix", steps), ["todolist step 2 is in_progress, not completed"]);
});

test("subagent tool calls do not count for the lead", () => {
  const sidechain = compliant.replaceAll('"isSidechain":false', '"isSidechain":true');
  assert.ok(auditTranscript(readTranscript(sidechain), "bug-fix", steps).length > 5);
});

test("compliance table needs a row per step", () => {
  const rows = steps.map((s) => `| ${s.n} | step | ${s.n === 5 ? "skip: no cheap test" : "done"} | ev |`).join("\n");
  assert.deepEqual(auditResult(`## Playbook compliance\n${rows}`, steps), []);
  assert.deepEqual(auditResult(`## Playbook compliance\n${rows.replace(/\| 3 \|.*\n/, "")}`, steps), ["compliance table has no done or skip: row for step 3"]);
  assert.deepEqual(auditResult("all good", steps), ["result has no Playbook compliance table"]);
});

test("ticket fields map to playbook and BASE", () => {
  const fields = { Repo: "embed-app", Type: "Bug", Mode: "pr", "Fix target": "release", "Release version": "v2.4.1" };
  assert.deepEqual(parseTicket({ fields }), { playbook: "bug-fix", base: "release-2.x" });
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
  assert.ok(prompt.includes("repos/o/r/pulls/<number>"));
  assert.match(prompt, /Never rewrite pushed history/);
});

test("a uv repo gets uv and pytest; a Node-only repo does not", () => {
  const uv = allowedTools(TOOLCHAINS.filter((t) => t.lock === "uv.lock"));
  assert.ok(uv.includes("Bash(uv:*)") && uv.includes("Bash(pytest:*)"));
  assert.ok(!allowedTools(TOOLCHAINS.filter((t) => t.lock === "package-lock.json")).includes("Bash(uv:*)"));
});

test("the seeded todo.md satisfies the todolist check once ticked or skipped", () => {
  const todo = seedTodo("bug-fix", steps);
  assert.match(todo, /Opening a PR: run \/deslop/);
  const noTasks = readTranscript([prompt, ...call("Skill", { skill: "how" })].join("\n"));
  assert.ok(auditTranscript(noTasks, "bug-fix", steps, todo).some((p) => p.includes("step 1")));
  const ticked = todo.replace(/- \[ \] 1\./, "- [x] 1.").replace(/(- \[ \] 2\..*)/, "$1 skip: one file");
  const problems = auditTranscript(noTasks, "bug-fix", steps, ticked);
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

test("merge checks pass only for a clean merge-mode run against a release branch", () => {
  const ci = mkdtempSync(join(tmpdir(), "routine-"));
  mkdirSync(join(ci, ".audit"));
  writeFileSync(join(ci, ".audit/ci.json"), JSON.stringify({ state: "green" }));
  writeFileSync(join(ci, ".audit/review.md"), "PASS\n\nNo high or critical findings.\n");
  writeFileSync(join(ci, ".audit/comments.md"), "FINDINGS: 0\n");
  const clean = { cwd: ci, mode: "merge", base: "release-2.x", violations: [], findings: ["skill how never ran"], pr: { state: "open", base: "release-2.x" } };
  assert.deepEqual(failedMergeChecks(clean), []);
  writeFileSync(join(ci, ".audit/ci.json"), JSON.stringify({ state: "red" }));
  assert.deepEqual(failedMergeChecks(clean), ["CI is green or the repo has none"]);
  writeFileSync(join(ci, ".audit/ci.json"), JSON.stringify({ state: "green" }));
  assert.deepEqual(failedMergeChecks({ ...clean, mode: "pr" }), ["Mode is merge"]);
  assert.deepEqual(failedMergeChecks({ ...clean, base: "main", pr: { state: "open", base: "main" } }), ["BASE is a release branch"]);
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

test("order findings never block a merge, but outcome findings do", () => {
  const dir = mkdtempSync(join(tmpdir(), "outcome-"));
  mkdirSync(join(dir, ".audit"));
  writeFileSync(join(dir, ".audit/ci.json"), JSON.stringify({ state: "green" }));
  writeFileSync(join(dir, ".audit/review.md"), "PASS\n");
  writeFileSync(join(dir, ".audit/comments.md"), "FINDINGS: 0\n");
  const ctx = { cwd: dir, mode: "merge", base: "release-2.x", violations: [], pr: { state: "open", base: "release-2.x" } };
  assert.deepEqual(failedMergeChecks({ ...ctx, findings: ["skill how never ran", "todolist step 3 is pending, not completed"] }), []);
  assert.deepEqual(failedMergeChecks({ ...ctx, findings: [NO_DRIVER, NOT_DELEGATED] }), ["the change was checked on its real surface", "the code was written by a delegate"]);
});

test("the PreToolUse hook enforces delegation and skill order", () => {
  const t = (...skills) => readTranscript([prompt, ...skills.flatMap((skill) => call("Skill", { skill }))].join("\n"));
  const edit = (path, agent_id) => ({ tool_name: "Edit", tool_input: { file_path: `/w/${path}` }, agent_id });
  const bash = (command, agent_id) => ({ tool_name: "Bash", tool_input: { command }, agent_id });
  assert.match(preToolDecision(edit("src/tooltip.ts"), t(), "bug-fix", "/w", "release-1.x"), /Delegate this edit/);
  assert.equal(preToolDecision(edit("src/tooltip.ts", "a1"), t(), "bug-fix", "/w", "release-1.x"), null);
  assert.equal(preToolDecision(edit("tests/test_tooltip.py"), t(), "bug-fix", "/w", "release-1.x"), null);
  assert.equal(preToolDecision(edit("CHANGELOG.md"), t(), "bug-fix", "/w", "release-1.x"), null);
  assert.match(preToolDecision(bash("git commit -m x", "a1"), t(), "feature", "/w", "release-1.x"), /how, architect/);
  assert.equal(preToolDecision(bash("git commit -m x", "a1"), t("how", "architect"), "feature", "/w", "release-1.x"), null);
  assert.match(preToolDecision(bash("git add -A && git commit -m x"), t("how"), "bug-fix", "/w", "release-1.x"), /technical-writing, unslop, deslop/);
  assert.equal(preToolDecision(bash("git commit -m x"), t("how", "pstack:deslop", "technical-writing", "unslop"), "bug-fix", "/w", "release-1.x"), null);
  const editAfterDeslop = readTranscript([prompt, ...["how", "deslop", "technical-writing", "unslop"].flatMap((skill) => call("Skill", { skill })), ...call("Edit", { file_path: "/w/tests/a.py" })].join("\n"));
  assert.match(preToolDecision(bash("git commit -m x"), editAfterDeslop, "bug-fix", "/w", "release-1.x"), /deslop \(after your last edit\)/);
  for (const command of ["gh api repos/o/r/pulls -f head=b -f base=release-1.x -F body=@x", "gh api repos/o/r/pulls --input pr.json", "gh api -X PATCH repos/o/r/pulls/3 -f body=x", "gh api --method POST repos/o/r/pulls", "gh pr create --fill"]) {
    assert.match(preToolDecision(bash(command, "a1"), t("no-comments", "technical-writing", "unslop"), "bug-fix", "/w", "release-1.x"), /routine opens and updates the PR/, command);
  }
  assert.equal(preToolDecision(bash("gh api repos/o/r/pulls/3"), t(), "bug-fix", "/w", "release-1.x"), null);
  assert.equal(preToolDecision(edit("src/a.ts"), t(), "investigation", "/w", "release-1.x"), null);
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
  assert.match(prompt, /mkdir, echo, printf, cd, pwd, wc/);
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

test("the work session may not merge or push to trunk, lead or subagent, in any playbook", () => {
  for (const command of ["gh api -X PUT repos/o/r/pulls/12/merge", "gh pr merge 12 --merge", "git push origin release-2.x", "git push origin HEAD:release-2.x", "git push -f origin HEAD:refs/heads/main", "git push origin main"]) {
    assert.ok(mergeRefusal(command, "release-2.x"), command);
    for (const agent_id of [undefined, "a1"]) {
      assert.match(preToolDecision({ tool_name: "Bash", tool_input: { command }, agent_id }, readTranscript(prompt), "investigation", "/w", "release-2.x"), /routine merges/);
    }
  }
  for (const command of ["git push -u origin claude/fix-tooltip", "gh api repos/o/r/pulls/12", "git push origin claude/release-2.x-fix", "gh api repos/o/r/pulls/12/merged-files"]) {
    assert.equal(mergeRefusal(command, "release-2.x"), null, command);
  }
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

test("the comment review blocks a merge until no findings remain", () => {
  const dir = mkdtempSync(join(tmpdir(), "comments-"));
  const path = join(dir, "comments.md");
  assert.equal(commentFindings(path), null);
  writeFileSync(path, "FINDINGS: 2\n- src/a.ts:3 restates the code\n");
  assert.equal(commentFindings(path), 2);
  writeFileSync(path, "FINDINGS: 0\n");
  assert.equal(commentFindings(path), 0);
  writeFileSync(path, "No findings.\n");
  assert.equal(commentFindings(path), null);
});
