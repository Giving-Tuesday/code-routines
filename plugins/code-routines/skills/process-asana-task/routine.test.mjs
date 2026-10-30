import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { auditResult, pstackPlaybooks, auditTranscript, baseFor, parseTicket, playbookFor, playbookSteps, readTranscript, repoSlug, unreleasedSection } from "./routine.mjs";

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
