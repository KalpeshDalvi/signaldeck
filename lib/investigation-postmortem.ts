import type { ArchivedEvidence, ArchivedInvestigation } from "./investigation-archive";
import { formatCentralDateTime } from "./time";

function value(text: string | null, fallback: string) {
  // Keep archive strings on a single line and escape Markdown control characters.
  return (text?.trim() || fallback)
    .replace(/\s+/g, " ")
    .replace(/[\\`*_\[\]{}<>|!~#]/g, "\\$&");
}

export function investigationPostmortem(record: ArchivedInvestigation, evidence: ArchivedEvidence[]) {
  const field = (label: string, text: string | null, fallback = "Pending investigation") =>
    `- **${label}** — ${value(text, fallback)}`;
  return [
    `# Draft postmortem for ${value(record.impacted_service, "Unknown workload")}`,
    "",
    field("Environment", record.environment),
    field("Incident status", record.status),
    field("Observed", formatCentralDateTime(record.incident_at)),
    `- **Saved investigation** — ${record.id}`,
    "",
    "## Finding and confidence",
    field("Working hypothesis", record.hypothesis),
    field("Verified mechanism", record.verified_mechanism, "Unverified"),
    field("Initiating change", record.initiating_change, "Unknown"),
    field("Limitations", record.limitations, "No limitations recorded"),
    "",
    "## Response and follow-up",
    field("Recovery", record.immediate_recovery),
    field("Recurrence prevention", record.recurrence_prevention),
    field("Validation", record.verification_plan),
    "",
    "## Preserved evidence",
    ...(evidence.length ? evidence.map(item => {
      const when = item.source_event_at ? formatCentralDateTime(item.source_event_at) : "Unknown observation time";
      const captured = formatCentralDateTime(item.captured_at);
      return `- ${value(when, "Unknown observation time")} · ${value(item.source_type, "Evidence")} · ${value(item.summary, "No summary")} · Source ID ${value(item.source_event_id, "Unknown")} · Captured ${value(captured, "Unknown")}`;
    }) : ["No preserved source records were returned."]),
    ...(evidence.length === 200 ? ["", "The archive response reached its 200-record limit."] : []),
    "",
  ].join("\n");
}
