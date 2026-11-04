import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gate } from "./audit.mjs";
import { PLAYBOOKS } from "./playbooks.mjs";
import { readIfExists } from "./shell.mjs";
import { STOP_COUNT, loadState } from "./state.mjs";
import { REFUSED } from "./transcript.mjs";

const STOP_HOOK_LIMIT = 3;
const MERGE_CALL = /\bgh\s+api\b.*\/pulls\/\d+\/merge\b|\bgh\s+pr\s+merge\b/;
const PR_API_WRITE =
  /\bgh\s+api\b(?=.*\/pulls\b)(?=.*\s(-X\s*(POST|PATCH|PUT)|--method\s+(POST|PATCH|PUT)|-f\s|-F\s|--field\b|--raw-field\b|--input\b))/;
const PR_CLI_WRITE = /\bgh\s+pr\s+(create|edit)\b/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function mergeRefusal(command, base) {
  const pushToTrunk = new RegExp(`\\bgit\\s+push\\b[^;&|]*\\s(\\S*:)?(refs/heads/)?(${escapeRe(base)}|main|master)(\\s|$)`);
  return MERGE_CALL.test(command) || pushToTrunk.test(command)
    ? "Never merge or push to the base branch. The routine merges this PR after its own checks pass."
    : null;
}

export function preToolDecision(call, playbook, base) {
  if (call.tool_name !== "Bash") return null;
  const command = String(call.tool_input.command);
  const refusal = mergeRefusal(command, base);
  if (refusal) return refusal;
  if (PLAYBOOKS[playbook].opensPr && (PR_API_WRITE.test(command) || PR_CLI_WRITE.test(command))) {
    return "The routine opens and updates the PR. Write .audit/pr-title.txt and .audit/pr-body.md instead.";
  }
  return null;
}

export function preToolHook(cwd) {
  const { playbook, base } = loadState(cwd);
  const reason = preToolDecision(JSON.parse(readFileSync(0, "utf8")), playbook, base);
  if (!reason) return null;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

export function stopDecision(gaps, count) {
  if (!gaps.length || count >= STOP_HOOK_LIMIT) return null;
  const reason = [
    "The routine's audit still finds these gaps:",
    ...gaps.map((g) => `- ${g}`),
    "Close each one, or append skip: <reason> to its line in .audit/todo.md, then finish.",
  ].join("\n");
  return { decision: "block", reason };
}

export function stopHook(cwd) {
  const countPath = join(cwd, STOP_COUNT);
  const count = Number(readIfExists(countPath) ?? 0);
  writeFileSync(countPath, String(count + 1));
  const { violations, findings } = gate(cwd);
  const gaps = [...violations.filter((v) => !v.startsWith("no PR for")), ...findings.filter((f) => !f.startsWith(REFUSED))];
  return stopDecision(gaps, count);
}
