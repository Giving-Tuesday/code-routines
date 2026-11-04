import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export const PLAYBOOKS = {
  "bug-fix": { opensPr: true, driver: true, delegate: true, skills: ["how"], skippable: ["why", "tdd"] },
  feature: { opensPr: true, driver: true, delegate: true, skills: ["how", "architect"], skippable: ["interrogate"] },
  investigation: { opensPr: false, driver: false, delegate: false, skills: ["how", "unslop"], skippable: ["why"] },
};

const BASE_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep", "Skill", "Agent", "ToolSearch",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop",
  "Bash(git:*)", "Bash(node:*)", "Bash(gh api:*)",
  "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(grep:*)", "Bash(rg:*)",
  "Bash(find:*)", "Bash(sed:*)", "Bash(mkdir:*)", "Bash(echo:*)", "Bash(printf:*)", "Bash(cd:*)",
  "Bash(pwd)", "Bash(wc:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(diff:*)", "Bash(test:*)",
  "Bash(jq:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(touch:*)",
];

export const TOOLCHAINS = [
  { lock: "uv.lock", install: ["uv", ["sync", "--frozen"]], tools: ["uv", "uvx", "python", "python3", "pytest"] },
  { lock: "pnpm-lock.yaml", install: ["pnpm", ["install", "--frozen-lockfile"]], tools: ["pnpm", "npx"] },
  { lock: "yarn.lock", install: ["yarn", ["install", "--frozen-lockfile"]], tools: ["yarn", "npx"] },
  { lock: "package-lock.json", install: ["npm", ["ci"]], tools: ["npm", "npx"] },
];

export function allowedTools(toolchains) {
  const shellTools = toolchains.flatMap((t) => t.tools.map((tool) => `Bash(${tool}:*)`));
  return [...new Set([...BASE_TOOLS, ...shellTools])];
}

export const toolsFor = (state) => allowedTools(TOOLCHAINS.filter((t) => state.toolchains.includes(t.lock)));

export const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

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
  "Opening a PR: read the PR back with gh api repos/<owner>/<repo>/pulls/<number>",
];

export function seedTodo(playbook, steps) {
  const opening = PLAYBOOKS[playbook].opensPr ? OPENING_A_PR : [];
  return [
    `# ${playbook} todolist`,
    "",
    ...steps.map((s) => `- [ ] ${s.n}. ${s.text}`),
    ...opening.map((o) => `- [ ] ${o}`),
    "",
  ].join("\n");
}
