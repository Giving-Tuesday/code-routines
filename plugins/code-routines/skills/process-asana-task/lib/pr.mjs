import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { prBodyFindings, prReadiness } from "./audit.mjs";
import { branchPushed, findPr } from "./github.mjs";
import { opensPr } from "./playbooks.mjs";
import { readIfExists, trySh } from "./shell.mjs";
import { AUDIT_DIR, PR_BODY, PR_TITLE, RESULT, SCREENSHOT_INDEX, SHRUNK_DIR, loadState } from "./state.mjs";
import { readTranscript, transcriptPath } from "./transcript.mjs";

const nonEmpty = (path) => {
  const text = readIfExists(path);
  return text?.trim() ? text : null;
};

function prText(cwd, state) {
  const title = nonEmpty(join(cwd, PR_TITLE))?.trim();
  const body = nonEmpty(join(cwd, PR_BODY));
  const result = nonEmpty(join(cwd, RESULT));
  return {
    title: title ?? state.name,
    body: body ?? result ?? `Asana task: ${state.url}\n`,
    findings: [
      ...(title ? [] : [`no ${PR_TITLE}, used the ticket name`]),
      ...(body ? [] : [`no ${PR_BODY}, used ${result ? RESULT : "a line naming the Asana task"}`]),
    ],
  };
}

export function openPr(cwd) {
  const state = loadState(cwd);
  if (!opensPr(state.playbook)) return { ok: true, skipped: `${state.playbook} opens no PR` };
  const path = transcriptPath(state.sessionId);
  const { title, body, findings: defaults } = prText(cwd, state);
  const findings = [
    ...defaults,
    ...(path ? prReadiness(readTranscript(readFileSync(path, "utf8"))) : ["no transcript for the work session"]),
    ...prBodyFindings(cwd, state, body),
  ];
  if (!branchPushed(cwd, state.branch)) return { ok: false, problems: [`origin/${state.branch} does not match HEAD`], findings };
  const api = (args, input) =>
    JSON.parse(execFileSync("gh", ["api", ...args, "--input", "-"], { cwd, encoding: "utf8", input: JSON.stringify(input) }));
  const open = findPr(cwd, state, "open");
  const pr = open
    ? api(["-X", "PATCH", `repos/${state.slug}/pulls/${open.number}`], { title, body })
    : api(["-X", "POST", `repos/${state.slug}/pulls`], { title, body, head: state.branch, base: state.base, draft: false });
  return { ok: true, pr: pr.html_url, findings };
}

const SCREENSHOT_BRANCH = "routine-screenshots";
const SCREENSHOTS_START = "<!-- routine-screenshots -->";
const SCREENSHOTS_END = "<!-- /routine-screenshots -->";

export function withScreenshots(body, images) {
  const block = [SCREENSHOTS_START, ...images.map(({ name, url }) => `![${name}](${url})`), SCREENSHOTS_END].join("\n");
  const text = (body ?? "").replace(new RegExp(`\\n*${SCREENSHOTS_START}[\\s\\S]*?${SCREENSHOTS_END}`), "");
  const heading = text.match(/^#{1,6}\s*screenshots?\b.*$/im);
  if (heading) return text.replace(heading[0], `${heading[0]}\n\n${block}`);
  return `${text.trimEnd()}\n\n## Screenshots\n\n${block}\n`;
}

export function shrinkScreenshot(file, outDir) {
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, file.split("/").pop());
  const converted = trySh("convert", [file, "-resize", "1280x>", "-strip", "-colors", "256", `PNG8:${out}`], outDir);
  return converted === null ? file : out;
}

function uploadScreenshots(files, cwd) {
  const git = (args, env = {}) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
  const index = { GIT_INDEX_FILE: join(cwd, SCREENSHOT_INDEX) };
  const message = `routine screenshots: ${files.map((f) => f.path).join(", ")}`;
  for (let attempt = 0; ; attempt++) {
    const fetched = trySh("git", ["fetch", "-q", "origin", SCREENSHOT_BRANCH], cwd) !== null;
    const parent = fetched ? git(["rev-parse", "FETCH_HEAD"]) : null;
    git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], index);
    for (const { path, file } of files) {
      git(["update-index", "--add", "--cacheinfo", `100644,${git(["hash-object", "-w", file])},${path}`], index);
    }
    const tree = git(["write-tree"], index);
    const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
    if (trySh("git", ["push", "-q", "origin", `${commit}:refs/heads/${SCREENSHOT_BRANCH}`], cwd) !== null) return commit;
    if (attempt === 2) throw new Error(`could not push ${SCREENSHOT_BRANCH}`);
  }
}

export function attachScreenshots(cwd) {
  const state = loadState(cwd);
  const pngs = readdirSync(join(cwd, AUDIT_DIR)).filter((f) => f.endsWith(".png")).sort();
  const pr = findPr(cwd, state, "open");
  if (!pngs.length || !pr) return { ok: true, attached: 0, reason: pngs.length ? "no open PR" : `no ${AUDIT_DIR}/*.png` };
  const files = pngs.map((name) => ({
    name,
    path: `${state.branch}/${name}`,
    file: shrinkScreenshot(join(cwd, AUDIT_DIR, name), join(cwd, SHRUNK_DIR)),
  }));
  const commit = uploadScreenshots(files, cwd);
  const images = files.map(({ name, path }) => ({
    name,
    url: `https://github.com/${state.slug}/blob/${commit}/${path}?raw=true`,
  }));
  execFileSync("gh", ["api", "-X", "PATCH", `repos/${state.slug}/pulls/${pr.number}`, "--input", "-"], {
    cwd,
    input: JSON.stringify({ body: withScreenshots(pr.body, images) }),
    stdio: ["pipe", "ignore", "pipe"],
  });
  return { ok: true, attached: images.length, pr: pr.html_url };
}
