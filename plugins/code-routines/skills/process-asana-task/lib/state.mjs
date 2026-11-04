import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AUDIT_DIR = ".audit";
const STATE = `${AUDIT_DIR}/routine.json`;
export const TODO = `${AUDIT_DIR}/todo.md`;
export const RESULT = `${AUDIT_DIR}/result.md`;
export const PR_TITLE = `${AUDIT_DIR}/pr-title.txt`;
export const PR_BODY = `${AUDIT_DIR}/pr-body.md`;
export const SETTINGS = `${AUDIT_DIR}/settings.json`;
export const STOP_COUNT = `${AUDIT_DIR}/stop-hook.count`;
export const CI_RESULT = `${AUDIT_DIR}/ci.json`;
export const REVIEW_RESULT = `${AUDIT_DIR}/review.md`;
export const SCREENSHOT_INDEX = `${AUDIT_DIR}/screenshots.index`;
export const SHRUNK_DIR = `${AUDIT_DIR}/shrunk`;
export const claudeOutput = (round) => `${AUDIT_DIR}/claude-${round}.json`;

export const loadState = (cwd) => JSON.parse(readFileSync(join(cwd, STATE), "utf8"));
export const saveState = (cwd, state) => writeFileSync(join(cwd, STATE), JSON.stringify(state, null, 2));

export const claudeOutputs = (cwd) =>
  readdirSync(join(cwd, AUDIT_DIR))
    .filter((f) => /^claude-.*\.json$/.test(f))
    .map((f) => join(cwd, AUDIT_DIR, f));
