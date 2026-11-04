import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export const sh = (cmd, args, cwd, { input, env } = {}) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    input,
    env: env && { ...process.env, ...env },
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();

export function trySh(...args) {
  try {
    return sh(...args);
  } catch {
    return null;
  }
}

export const readIfExists = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

export const readJson = (path) => JSON.parse(readIfExists(path) ?? "null");

export const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
