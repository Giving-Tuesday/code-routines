import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sh, trySh } from "./shell.mjs";

export function repoSlug(remoteUrl) {
  return remoteUrl.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/");
}

export const ghGet = (cwd, path) => JSON.parse(trySh("gh", ["api", path], cwd) ?? "null");

export const ghWrite = (cwd, method, path, body) =>
  JSON.parse(sh("gh", ["api", "-X", method, path, "--input", "-"], cwd, { input: JSON.stringify(body) }));

export const head = (cwd) => sh("git", ["rev-parse", "HEAD"], cwd);

export function findPr(cwd, { slug, branch }, prState) {
  return ghGet(cwd, `repos/${slug}/pulls?state=${prState}&head=${slug.split("/")[0]}:${branch}`)?.[0];
}

export function branchPushed(cwd, branch) {
  return trySh("git", ["ls-remote", "origin", `refs/heads/${branch}`], cwd)?.split("\t")[0] === head(cwd);
}

const PR_TEMPLATES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];
const TEMPLATE_DIR = ".github/PULL_REQUEST_TEMPLATE";

export function findPrTemplate(cwd) {
  const inDir = existsSync(join(cwd, TEMPLATE_DIR))
    ? readdirSync(join(cwd, TEMPLATE_DIR)).filter((f) => f.endsWith(".md")).sort().map((f) => `${TEMPLATE_DIR}/${f}`)
    : [];
  return [...PR_TEMPLATES, ...inDir].find((p) => existsSync(join(cwd, p))) ?? null;
}

const templateHeadings = (md) => md.split("\n").flatMap((l) => l.match(/^#{1,6}\s+(.+?)\s*$/)?.slice(1) ?? []);

export function missingTemplateHeadings(template, body) {
  const present = templateHeadings(body ?? "");
  return templateHeadings(template).filter((h) => !present.includes(h));
}
