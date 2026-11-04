import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./shell.mjs";

export const skillName = (call) => String(call.input.skill).replace(/^\//, "");

export const usedSkill = (skills, name) => skills.some((s) => s === name || s.endsWith(`:${name}`));

function taskList(calls, results) {
  const tasks = new Map();
  for (const call of calls) {
    if (call.name === "TaskCreate") {
      const id = results.get(call.id)?.match(/Task #(\d+)/)?.[1];
      if (id) tasks.set(id, { text: `${call.input.subject} ${call.input.description ?? ""}`, status: "pending" });
    }
    if (call.name === "TaskUpdate" && tasks.has(String(call.input.taskId))) {
      const task = tasks.get(String(call.input.taskId));
      task.text += ` ${call.input.subject ?? ""} ${call.input.description ?? ""}`;
      if (call.input.status) task.status = call.input.status;
    }
  }
  return [...tasks.values()];
}

export function readTranscript(jsonl) {
  const calls = [];
  const results = new Map();
  let prompt = "";
  for (const line of jsonl.split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.isSidechain) continue;
    const content = entry.message?.content;
    if (entry.type === "user" && typeof content === "string") prompt += content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use") calls.push({ id: block.id, name: block.name, input: block.input ?? {} });
      if (block.type === "tool_result") results.set(block.tool_use_id, JSON.stringify(block.content));
      if (block.type === "text" && entry.type === "user") prompt += block.text;
    }
  }
  const named = (name) => calls.filter((c) => c.name === name);
  return {
    prompt,
    tasks: taskList(calls, results),
    skills: named("Skill").map(skillName),
    agents: named("Agent").map((c) => c.input.subagent_type ?? ""),
    bash: named("Bash").map((c) => String(c.input.command)),
    calls,
  };
}

export function transcriptPath(sessionId) {
  const root = join(configDir(), "projects");
  return readdirSync(root).map((d) => join(root, d, `${sessionId}.jsonl`)).find(existsSync) ?? null;
}

export function summarizeDenials(outputs) {
  const counts = new Map();
  for (const out of outputs) {
    let denials = [];
    try {
      denials = JSON.parse(out).permission_denials ?? [];
    } catch {}
    for (const d of denials) {
      const what = d.tool_input?.command ?? d.tool_name ?? "an unnamed tool call";
      counts.set(what, (counts.get(what) ?? 0) + 1);
    }
  }
  return [...counts].map(([what, n]) => {
    const shown = what.length > 120 ? `${what.slice(0, 117)}...` : what;
    return `the routine refused \`${shown}\` ${n} time${n === 1 ? "" : "s"}`;
  });
}
