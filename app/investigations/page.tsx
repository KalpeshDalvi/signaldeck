import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { listArchivedInvestigations } from "@/lib/investigation-archive";

export const dynamic = "force-dynamic";
export default async function InvestigationsPage() {
  const result = await listArchivedInvestigations();
  const investigations = result.status === "ok" ? result.data.investigations : [];
  return <>
    <PageHeader eyebrow="DURABLE EVIDENCE" title="Saved investigations"
      description="Archived incident evidence persists independently of raw telemetry retention." />
    <article className="panel" style={{ marginBottom: 18 }}>
      <p>Saved investigations contain only evidence captured after the archive is enabled. Historical failures cannot be reconstructed from records that were never retained. Findings are observations and working hypotheses until verified.</p>
    </article>
    {result.status !== "ok" ?
      <article className="panel">
        <h2>Investigation archive unavailable</h2>
        <p>{result.status === "not_configured"
          ? "The authenticated read API is not configured."
          : "The archive schema or read API may not be deployed, or the database may be temporarily unavailable. Check the Cloud Run read API logs before treating this as an empty archive."}</p>
      </article> :
      investigations.length === 0 ?
      <article className="panel"><h2>No saved investigations yet</h2>
        <p>After migration 003 is applied and SIGNALDECK_ARCHIVE_ENABLED=true is set on the ingestion service, new qualifying failures will create saved investigations automatically.</p>
      </article> :
      <div className="list panel">
        {investigations.map(item => <div className="alert-card" key={item.id}>
          <span className="pill info">{item.status}</span>
          <div>
            <strong>{item.impacted_service ?? "Unknown workload"} · {item.environment}</strong>
            <p>{new Date(item.incident_at).toLocaleString()} · {item.hypothesis ?? "Evidence captured; diagnosis pending"}</p>
            <small>{item.verified_mechanism
              ? "Verified mechanism recorded"
              : "Root cause not independently verified"}</small>
          </div>
          <Link href={`/investigations/${item.id}`}>Review evidence →</Link>
        </div>)}
      </div>}
  </>;
}
