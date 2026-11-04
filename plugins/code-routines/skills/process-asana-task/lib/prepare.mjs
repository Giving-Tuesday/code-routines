import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { findPrTemplate, repoSlug } from "./github.mjs";
import { playbookStepsFor, seedTodo } from "./playbooks.mjs";
import { TOOLCHAINS } from "./session.mjs";
import { readIfExists, sh, trySh } from "./shell.mjs";
import { AUDIT_DIR, TODO, saveState } from "./state.mjs";
import { parseTicket } from "./ticket.mjs";

export function checkoutWorkBranch(cwd, branch, base) {
  const dirty = sh("git", ["status", "--porcelain", "--untracked-files=all"], cwd)
    .split("\n")
    .map((l) => l.replace(/^\s*\S+\s+/, ""))
    .filter((p) => p && !p.startsWith(`${AUDIT_DIR}/`));
  if (dirty.length) return [`the checkout has uncommitted changes, so the routine will not touch it: ${dirty.join(", ")}`];
  if (trySh("git", ["rev-parse", "--verify", `refs/heads/${branch}`], cwd)) {
    const unpushed = sh("git", ["rev-list", branch, "--not", "--remotes"], cwd);
    if (unpushed) return [`${branch} has commits that are on no remote, so the routine will not move it`];
  }
  sh("git", ["switch", "--no-track", "-C", branch, `origin/${base}`], cwd);
  return [];
}

export function ignoreAudit(cwd) {
  const exclude = resolve(cwd, sh("git", ["rev-parse", "--git-path", "info/exclude"], cwd));
  if ((readIfExists(exclude) ?? "").includes(`${AUDIT_DIR}/`)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `\n${AUDIT_DIR}/\n`);
}

function clearAudit(cwd) {
  const dir = join(cwd, AUDIT_DIR);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir).filter((f) => f !== "ticket.json")) rmSync(join(dir, f), { recursive: true });
}

function workBranch(cwd, gid) {
  const current = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return process.env.ROUTINE_BRANCH || (current.startsWith("claude/") ? current : `claude/asana-${gid}`);
}

export function prepare(ticketPath, cwd) {
  const parsed = parseTicket(JSON.parse(readFileSync(ticketPath, "utf8")));
  if (parsed.error) return { ok: false, problems: [parsed.error] };
  const branch = workBranch(cwd, parsed.gid);
  if ([parsed.base, "main", "master"].includes(branch)) return { ok: false, problems: [`the work branch ${branch} is a trunk branch`] };
  sh("git", ["fetch", "origin", "--tags"], cwd);
  if (!trySh("git", ["rev-parse", "--verify", `origin/${parsed.base}`], cwd)) {
    return { ok: false, problems: [`${parsed.base} is not on origin`] };
  }
  const checkout = checkoutWorkBranch(cwd, branch, parsed.base);
  if (checkout.length) return { ok: false, problems: checkout };
  clearAudit(cwd);
  ignoreAudit(cwd);
  const toolchains = TOOLCHAINS.filter((t) => existsSync(join(cwd, t.lock)));
  for (const { install } of toolchains) {
    if (spawnSync(install[0], install[1], { cwd, stdio: "inherit" }).status !== 0) {
      return { ok: false, problems: [`${install.flat().join(" ")} failed`] };
    }
  }
  writeFileSync(join(cwd, TODO), seedTodo(parsed.playbook, playbookStepsFor(parsed.playbook)));
  const state = {
    ...parsed,
    branch,
    toolchains: toolchains.map((t) => t.lock),
    slug: repoSlug(sh("git", ["remote", "get-url", "origin"], cwd)),
    baseSha: sh("git", ["rev-parse", `origin/${parsed.base}`], cwd),
    prTemplate: findPrTemplate(cwd),
  };
  saveState(cwd, state);
  return { ok: true, playbook: state.playbook, base: state.base, branch, toolchains: state.toolchains };
}
