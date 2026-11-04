import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gate } from "./audit.mjs";
import { ghGet, head as headSha } from "./github.mjs";
import { readIfExists, readJson } from "./shell.mjs";
import { CI_RESULT, REVIEW_RESULT, loadState } from "./state.mjs";

export const reviewVerdict = (path) => readIfExists(path)?.trimStart().split("\n")[0].trim() ?? null;

const MERGE_CHECKS = [
  ["Mode is merge", (c) => /^merge$/i.test(c.mode)],
  ["the gate has no violations", (c) => c.violations.length === 0],
  ["the PR is open against BASE", (c) => c.pr?.state === "open" && c.pr.base === c.base],
  ["CI is green or the repo has none", (c) => ["green", "none"].includes(readJson(join(c.cwd, CI_RESULT))?.state)],
  ["an independent review returned PASS", (c) => reviewVerdict(join(c.cwd, REVIEW_RESULT)) === "PASS"],
];

export const failedMergeChecks = (ctx) => MERGE_CHECKS.filter(([, passes]) => !passes(ctx)).map(([name]) => name);

export function ciState(runs) {
  if (!runs.length) return { state: "none", failed: [] };
  if (runs.some((r) => r.status !== "completed")) return { state: "pending", failed: [] };
  const failed = runs.filter((r) => !["success", "neutral", "skipped"].includes(r.conclusion)).map((r) => r.name);
  return { state: failed.length ? "red" : "green", failed };
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function pollCi(cwd, slug, head, { timeoutMs, noneAfterMs, pollMs }) {
  const start = Date.now();
  for (;;) {
    const result = ciState(ghGet(cwd, `repos/${slug}/commits/${head}/check-runs?per_page=100`)?.check_runs ?? []);
    const waited = Date.now() - start;
    if (result.state === "green" || result.state === "red") return result;
    if (result.state === "none" && waited >= noneAfterMs) return result;
    if (waited >= timeoutMs) return { state: "timeout", failed: [] };
    sleep(pollMs);
  }
}

export function awaitCi(cwd, { timeoutMs = 30 * 60_000, noneAfterMs = 5 * 60_000, pollMs = 30_000 } = {}) {
  const { slug } = loadState(cwd);
  const head = headSha(cwd);
  const result = pollCi(cwd, slug, head, { timeoutMs, noneAfterMs, pollMs });
  writeFileSync(join(cwd, CI_RESULT), JSON.stringify({ head, ...result }, null, 2));
  return { ok: result.state === "green" || result.state === "none", head, ...result };
}

export function mergeCheck(cwd) {
  const state = loadState(cwd);
  const { pr, violations } = gate(cwd);
  const failed = failedMergeChecks({ ...state, pr, violations, cwd });
  return { ok: failed.length === 0, pr, failed };
}
