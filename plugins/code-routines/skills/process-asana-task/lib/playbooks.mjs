import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { configDir } from "./shell.mjs";
import { PR_BODY, PR_TITLE } from "./state.mjs";

export const PLAYBOOKS = {
  "bug-fix": { opensPr: true, driver: true, delegate: true, skills: ["how"], skippable: ["why", "tdd"] },
  feature: { opensPr: true, driver: true, delegate: true, skills: ["how", "architect"], skippable: ["interrogate"] },
  investigation: { opensPr: false, driver: false, delegate: false, skills: ["how", "unslop"], skippable: ["why"] },
};

export const opensPr = (playbook) => PLAYBOOKS[playbook].opensPr;

export function pstackPlaybooks() {
  if (process.env.PSTACK_POTETO_DIR) return join(process.env.PSTACK_POTETO_DIR, "playbooks");
  const root = join(configDir(), "plugins/cache");
  const found = readdirSync(root, { recursive: true })
    .filter((p) => String(p).endsWith("skills/poteto-mode/playbooks/bug-fix.md"))
    .map((p) => join(root, String(p), ".."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!found.length) throw new Error("pstack poteto-mode playbooks not found; set PSTACK_POTETO_DIR");
  return found.at(-1);
}

export const pstackRoot = () => join(pstackPlaybooks(), "../../..");

function playbookSteps(markdown) {
  return markdown.split("\n").flatMap((line) => {
    const m = line.match(/^(\d+)\.\s+(.+)$/);
    return m ? [{ n: Number(m[1]), text: m[2] }] : [];
  });
}

export const playbookStepsFor = (playbook) =>
  playbookSteps(readFileSync(join(pstackPlaybooks(), `${playbook}.md`), "utf8"));

const OPENING_A_PR = [
  "Opening a PR: run /deslop over the diff before commit",
  "Opening a PR: run /no-comments before review",
  "Opening a PR: run /technical-writing, then /unslop, on commit bodies and the PR title and body",
  `Opening a PR: write the PR title to ${PR_TITLE} and the body to ${PR_BODY}`,
];

export function seedTodo(playbook, steps) {
  const opening = opensPr(playbook) ? OPENING_A_PR : [];
  return [
    `# ${playbook} todolist`,
    "",
    ...steps.map((s) => `- [ ] ${s.n}. ${s.text}`),
    ...opening.map((o) => `- [ ] ${o}`),
    "",
  ].join("\n");
}
