#!/usr/bin/env node
import process from "node:process";
import { gate } from "./lib/audit.mjs";
import { preToolHook, stopHook } from "./lib/hooks.mjs";
import { awaitCi, mergeCheck } from "./lib/merge.mjs";
import { openPr } from "./lib/pr.mjs";
import { prepare } from "./lib/prepare.mjs";
import { attachScreenshots } from "./lib/screenshots.mjs";
import { repair, run } from "./lib/session.mjs";

const USAGE =
  "usage: routine.mjs prepare <ticket.json> | run | repair <audit.md> | gate | open-pr | attach-screenshots | await-ci | merge-check";

const [command, arg] = process.argv.slice(2);
const cwd = process.cwd();

const hooks = {
  "pre-tool-hook": () => preToolHook(arg ?? cwd),
  "stop-hook": () => stopHook(arg ?? cwd),
};

const commands = {
  prepare: () => prepare(arg, cwd),
  run: () => run(cwd),
  repair: () => repair(arg, cwd),
  gate: () => gate(cwd),
  "merge-check": () => mergeCheck(cwd),
  "await-ci": () => awaitCi(cwd),
  "attach-screenshots": () => attachScreenshots(cwd),
  "open-pr": () => openPr(cwd),
};

if (hooks[command]) {
  const output = hooks[command]();
  if (output) console.log(JSON.stringify(output));
  process.exit(0);
}

if (!commands[command]) {
  console.error(USAGE);
  process.exit(2);
}

function runCommand() {
  try {
    return commands[command]();
  } catch (error) {
    return { ok: false, problems: [error.message] };
  }
}

const out = runCommand();
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
