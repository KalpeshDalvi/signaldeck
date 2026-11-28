import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { getArchivedInvestigation } from "@/lib/investigation-archive";
import { formatCentralDateTime } from "@/lib/time";
import { Suspense } from "react";
import { suggestIncidentRecovery } from "@/lib/incident-recovery";
import { getInvestigationIncidentId } from "@/lib/incident-investigation-links";

export const dynamic = "force-dynamic";

async function IncidentResponseLink({ id }: { id: string }) {
  const incidentId = await getInvestigationIncidentId(id).catch((error: unknown) => {
    console.error("Unable to retrieve investigation incident", error instanceof Error ? error.name : "");
    return null;
  });
  return incidentId ? <Link href={`/incidents/${incidentId}`}>Open incident response</Link> : null;
}

export default async function SavedInvestigationPage({ params }: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params;
  const result = await getArchivedInvestigation(id);
  if (result.status !== "ok") {
    return <>
      <PageHeader eyebrow="DURABLE EVIDENCE" title="Investigation unavailable"
        description="The requested archived investigation could not be retrieved." />
      <article className="panel">
        <p>{result.status === "not_found"
          ? "This investigation does not exist in the configured workspace."
          : "The archive could not be read. Check the read API configuration or database availability."}</p>
        <Link href="/investigations">Return to saved investigations</Link>
      </article>
    </>;
  }
  const { investigation: record, evidence } = result.data;
  const guidance = suggestIncidentRecovery(evidence, record.impacted_service);
  return <>
    <PageHeader eyebrow="SAVED INVESTIGATION"
      title={`${record.impacted_service ?? "Unknown workload"} · ${record.environment}`}
      description={`Evidence recorded around ${formatCentralDateTime(record.incident_at)}`}>
      <span className="pill info">{record.status}</span>
      <Suspense><IncidentResponseLink id={record.id} /></Suspense>
      <a href={`/investigations/${record.id}/postmortem`}>Download draft postmortem</a>
    </PageHeader>
    <p style={{ marginBottom: 16 }}><Link href="/investigations">All saved investigations</Link></p>
    <article className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-title"><div><h2>Finding and confidence boundary</h2>
        <p>Captured findings are distinct from independently verified causation</p></div></div>
      <p><strong>Working hypothesis:</strong> {record.hypothesis ?? "Not determined"}</p>
      <p><strong>Verified mechanism:</strong> {record.verified_mechanism ?? "Not independently verified"}</p>
      <p><strong>Initiating change:</strong> {record.initiating_change ?? "Not yet identified"}</p>
      <p><strong>Initiating identity:</strong> {record.initiating_actor ?? "Not yet identified"}</p>
      <p><strong>Immediate recovery:</strong> {record.immediate_recovery ?? guidance?.recovery ?? "Requires investigation"}</p>
      <p><strong>Prevention:</strong> {record.recurrence_prevention ?? "Requires further evidence"}</p>
      <p><strong>Verification:</strong> {record.verification_plan ?? guidance?.validation ?? "Requires validation"}</p>
      {guidance && (!record.immediate_recovery || !record.verification_plan) &&
        <p>Suggested recovery checks use source IDs {guidance.sourceIds.join(", ")}.</p>}
      <p><strong>Limitations:</strong> {record.limitations ?? "No limitations recorded"}</p>
    </article>
    <article className="panel">
      <div className="panel-title"><div><h2>Preserved evidence timeline</h2>
        <p>{evidence.length} saved source record{evidence.length === 1 ? "" : "s"} · retained independently of raw telemetry · US Central Time</p></div></div>
      {evidence.length === 0 ? <p>No evidence records have been stored for this investigation.</p> :
        <div className="list">{evidence.map(item =>
          <div className="list-item" key={item.id}><div style={{ width: "100%" }}>
            <strong>{item.source_type} · {item.summary}</strong>
            <p>Observed: {item.source_event_at ? <time dateTime={item.source_event_at}>{formatCentralDateTime(item.source_event_at)}</time> : "Unknown"}
              {" · "}Captured: <time dateTime={item.captured_at}>{formatCentralDateTime(item.captured_at)}</time></p>
            <small>Resource: {item.resource_name ?? "Unknown"} · Source ID: {item.source_event_id}</small>
            <pre style={{ fontSize: 12, overflowWrap: "anywhere", whiteSpace: "pre-wrap", marginTop: 8 }}>
              {JSON.stringify(item.payload, null, 2)}
            </pre>
          </div></div>
        )}</div>}
    </article>
  </>;
}
