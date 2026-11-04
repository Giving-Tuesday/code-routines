const FIELDS = ["Repo", "Type", "Mode", "Fix target", "Release version"];

export function playbookFor({ Type, Mode }) {
  if (/review only/i.test(Mode)) return "investigation";
  if (/bug/i.test(Type)) return "bug-fix";
  if (/feature/i.test(Type)) return "feature";
  if (/explore|review/i.test(Type)) return "investigation";
  return null;
}

export function baseFor(releaseVersion) {
  const major = String(releaseVersion).match(/^v?(\d+)/)?.[1];
  return major ? `release-${major}.x` : null;
}

export function parseTicket(ticket) {
  const missing = FIELDS.filter((f) => !String(ticket.fields?.[f] ?? "").trim());
  if (missing.length) return { error: `missing custom fields: ${missing.join(", ")}` };
  const playbook = playbookFor(ticket.fields);
  if (!playbook) return { error: `unknown Type "${ticket.fields.Type}"` };
  const base = baseFor(ticket.fields["Release version"]);
  if (!base) return { error: `Release version "${ticket.fields["Release version"]}" has no major number` };
  return { playbook, base };
}
