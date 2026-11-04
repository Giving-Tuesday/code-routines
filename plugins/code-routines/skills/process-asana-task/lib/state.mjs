import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AUDIT_DIR = ".audit";
const STATE = ".audit/routine.json";
export const TODO = ".audit/todo.md";
export const RESULT = ".audit/result.md";
export const PR_TITLE = ".audit/pr-title.txt";
export const PR_BODY = ".audit/pr-body.md";
export const SETTINGS = ".audit/settings.json";
export const STOP_COUNT = ".audit/stop-hook.count";
export const CI_RESULT = ".audit/ci.json";
export const REVIEW_RESULT = ".audit/review.md";
export const SCREENSHOT_INDEX = ".audit/screenshots.index";
export const SHRUNK_DIR = ".audit/shrunk";
export const claudeOutput = (round) => `.audit/claude-${round}.json`;

export const loadState = (cwd) => JSON.parse(readFileSync(join(cwd, STATE), "utf8"));
export const saveState = (cwd, state) => writeFileSync(join(cwd, STATE), JSON.stringify(state, null, 2));

export const claudeOutputs = (cwd) =>
  readdirSync(join(cwd, AUDIT_DIR))
    .filter((f) => /^claude-.*\.json$/.test(f))
    .map((f) => join(cwd, AUDIT_DIR, f));
