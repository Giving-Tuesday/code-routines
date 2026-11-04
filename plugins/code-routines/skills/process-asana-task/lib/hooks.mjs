import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gate, noPr } from "./audit.mjs";
import { PLAYBOOKS } from "./playbooks.mjs";
import { readIfExists } from "./shell.mjs";
import { PR_BODY, PR_TITLE, STOP_COUNT, TODO, loadState } from "./state.mjs";

const STOP_HOOK_LIMIT = 3;
const MERGE_CALL = /\bgh\s+api\b.*\/pulls\/\d+\/merge\b|\bgh\s+pr\s+merge\b/;
const GIT_PUSH = String.raw`\bgit(\s+(-[Cc]|--(git-dir|work-tree|namespace|config-env))\s+\S+|\s+-{1,2}[^\s-]\S*)*\s+push\b[^;&|]*`;
const FORCE_PUSH = new RegExp(`${GIT_PUSH}\\s(-[a-zA-Z]*f[a-zA-Z]*|--force\\S*|\\+\\S+)(\\s|$)`);
const API_WRITE = String.raw`(?=.*\s(-X\s*(POST|PATCH|PUT|DELETE)|--method\s+(POST|PATCH|PUT|DELETE)|-f\s|-F\s|--field\b|--raw-field\b|--input\b))`;
const GH_API = String.raw`\bgh\s+api\b`;
const PR_API_WRITE = new RegExp(String.raw`${GH_API}(?=.*\/pulls\b)${API_WRITE}`);
const PR_CLI_WRITE = /\bgh\s+pr\s+(create|edit)\b/;
const GRAPHQL_MUTATION = new RegExp(String.raw`${GH_API}(?=.*\sgraphql(\s|$))(?=.*\bmutation\b)`);
const MERGES_WRITE = new RegExp(String.raw`${GH_API}(?=.*\/merges(\s|$))${API_WRITE}`);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function trunkWrite(command, base) {
  const trunk = `(${escapeRe(base)}|main|master)(\\s|$)`;
  const pushToTrunk = new RegExp(`${GIT_PUSH}\\s(\\S*:)?(refs/heads/)?${trunk}`);
  const refWrite = new RegExp(`${GH_API}(?=.*/git/refs/heads/${trunk})${API_WRITE}`);
  const contentsWrite = new RegExp(`${GH_API}(?=.*/contents/)(?=.*\\bbranch=${trunk}|(?!.*\\bbranch=))${API_WRITE}`);
  return [MERGE_CALL, MERGES_WRITE, GRAPHQL_MUTATION, pushToTrunk, refWrite, contentsWrite].some((re) => re.test(command));
}

export function preToolDecision(call, playbook, base) {
  if (call.tool_name !== "Bash") return null;
  const command = String(call.tool_input.command).replace(/["']/g, "");
  if (trunkWrite(command, base)) {
    return "Never merge or push to the base branch. The routine merges this PR after its own checks pass.";
  }
  if (FORCE_PUSH.test(command)) return "Never rewrite pushed history: no force-push. Add a new commit instead.";
  if (PLAYBOOKS[playbook].opensPr && (PR_API_WRITE.test(command) || PR_CLI_WRITE.test(command))) {
    return `The routine opens and updates the PR. Write ${PR_TITLE} and ${PR_BODY} instead.`;
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
    `Close each one, or append skip: <reason> to its line in ${TODO}, then finish.`,
  ].join("\n");
  return { decision: "block", reason };
}

export function stopHook(cwd) {
  const countPath = join(cwd, STOP_COUNT);
  const count = Number(readIfExists(countPath) ?? 0);
  writeFileSync(countPath, String(count + 1));
  const { branch } = loadState(cwd);
  const { violations, findings } = gate(cwd);
  return stopDecision([...violations.filter((v) => v !== noPr(branch)), ...findings], count);
}
