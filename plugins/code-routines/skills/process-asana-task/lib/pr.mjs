import { join } from "node:path";
import { prBodyFindings, prReadiness } from "./audit.mjs";
import { branchPushed, findPr, ghWrite } from "./github.mjs";
import { opensPr } from "./playbooks.mjs";
import { readIfExists } from "./shell.mjs";
import { PR_BODY, PR_TITLE, RESULT, loadState } from "./state.mjs";
import { NO_TRANSCRIPT, loadTranscript } from "./transcript.mjs";

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
  const { title, body, findings: defaults } = prText(cwd, state);
  const transcript = loadTranscript(state);
  const findings = [
    ...defaults,
    ...(transcript ? prReadiness(transcript) : [NO_TRANSCRIPT]),
    ...prBodyFindings(cwd, state, body),
  ];
  if (!branchPushed(cwd, state.branch)) return { ok: false, problems: [`origin/${state.branch} does not match HEAD`], findings };
  const open = findPr(cwd, state, "open");
  const pr = open
    ? ghWrite(cwd, "PATCH", `repos/${state.slug}/pulls/${open.number}`, { title, body })
    : ghWrite(cwd, "POST", `repos/${state.slug}/pulls`, { title, body, head: state.branch, base: state.base, draft: false });
  return { ok: true, pr: pr.html_url, findings };
}
