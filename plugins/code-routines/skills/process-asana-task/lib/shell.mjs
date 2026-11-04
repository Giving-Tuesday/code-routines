import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function trySh(...args) {
  try {
    return sh(...args);
  } catch {
    return null;
  }
}

export const readIfExists = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

export const readJson = (path) => JSON.parse(readIfExists(path) ?? "null");
