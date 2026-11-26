import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { INCIDENT_HISTORY_LIMIT, listIncidentHistory } from "@/lib/incidents";
import { formatCentralDateTime } from "@/lib/time";
import "../incidents.css";

export const dynamic = "force-dynamic";

export default async function IncidentHistoryPage() {
  const incidents = await listIncidentHistory().catch(() => null);

  return <>
    <PageHeader eyebrow="INCIDENT COMMAND" title="Incident history"
      description={`Latest ${INCIDENT_HISTORY_LIMIT} incident records by last update`}>
      <Link className="incident-archive-view-all" href="/incidents">Current incidents</Link>
    </PageHeader>
    <section className="panel" aria-label="Incident records">
      {!incidents ? <p role="alert">Incident history is currently unavailable.</p> :
        incidents.length === 0 ? <p>No incidents have been recorded yet.</p> :
          <ul className="incident-archive-list">
            {incidents.map(incident => <li key={incident.id}>
              <Link className="incident-archive-entry" href={`/incidents/${incident.id}`} prefetch={false}>
                <div>
                  <strong>{incident.title}</strong>
                  <span className="incident-archive-environment">{incident.environment}</span>
                  <p>{incident.severity} · {incident.owner || "Unassigned"}</p>
                </div>
                <div className="incident-archive-meta">
                  <span className={`pill lifecycle-${incident.status}`}>{incident.status}</span>
                  <time dateTime={incident.updated_at}>{formatCentralDateTime(incident.updated_at)}</time>
                </div>
              </Link>
            </li>)}
          </ul>}
    </section>
  </>;
}
