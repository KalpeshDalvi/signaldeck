import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/AppShell";
import { getIncident } from "@/lib/incidents";
import { formatCentralDateTime } from "@/lib/time";
import IncidentControls from "../IncidentControls";
import "../incidents.css";

export const dynamic = "force-dynamic";

export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const incident = await getIncident(id);
  if (!incident) notFound();

  return <>
    <PageHeader eyebrow="INCIDENT RECORD" title={incident.title}
      description={`${incident.service_name} · ${incident.environment}`}>
      <Link className="incident-archive-view-all" href="/incidents/history">Incident history</Link>
    </PageHeader>
    <article className="panel incident-archive">
      <div className="panel-title"><h2>Working summary</h2><span className="pill critical">{incident.severity}</span></div>
      <p>{incident.summary || "No summary recorded."}</p>
      <p>Started <time dateTime={incident.started_at}>{formatCentralDateTime(incident.started_at)}</time></p>
    </article>
    <IncidentControls key={incident.id} incident={incident} />
    <section className="panel" aria-labelledby="responder-notes-title">
      <div className="panel-title"><h2 id="responder-notes-title">Responder notes</h2></div>
      {incident.notes.length === 0 ? <p>No notes yet.</p> : <ul className="incident-archive-list">
        {incident.notes.map(note => <li key={note.id}>
          <article className="incident-archive-entry incident-note-entry">
            <div><strong>{note.author}</strong><p>{note.message}</p></div>
            <div className="incident-archive-meta">
              <time dateTime={note.created_at}>{formatCentralDateTime(note.created_at)}</time>
            </div>
          </article>
        </li>)}
      </ul>}
    </section>
  </>;
}
