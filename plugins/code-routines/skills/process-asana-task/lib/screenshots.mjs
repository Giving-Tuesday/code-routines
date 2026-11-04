import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findPr, ghWrite } from "./github.mjs";
import { sh, trySh } from "./shell.mjs";
import { AUDIT_DIR, SCREENSHOT_INDEX, SHRUNK_DIR, loadState } from "./state.mjs";

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
  const git = (args, env) => sh("git", args, cwd, { env });
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
  ghWrite(cwd, "PATCH", `repos/${state.slug}/pulls/${pr.number}`, { body: withScreenshots(pr.body, images) });
  return { ok: true, attached: images.length, pr: pr.html_url };
}
