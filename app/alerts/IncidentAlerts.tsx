import Link from "next/link";
import { incidentPool } from "@/lib/incident-postgres";
import { listInvestigationAcknowledgements } from "@/lib/investigation-acknowledgements";
import { listArchivedInvestigations } from "@/lib/investigation-archive";
import { formatCentralDateTime } from "@/lib/time";
import { acknowledgeAlert } from "./actions";

export async function IncidentAlerts({ outcome }: { outcome?: string }) {
  const result = await listArchivedInvestigations();
  if (result.status !== "ok") {
    return <p role="status">Archived incident alerts are unavailable.</p>;
  }

  const { investigations } = result.data;
  if (investigations.length === 0) return <p>No archived incident alerts yet.</p>;

  let acknowledgements: Map<string, string> | undefined;
  try {
    const db = incidentPool();
    if (db) acknowledgements = await listInvestigationAcknowledgements(db, investigations.map(item => item.id));
  } catch (error) {
    console.error("Unable to read alert acknowledgements", error instanceof Error ? error.name : "");
  }

  return <>
    {outcome === "acknowledged" && <p role="status">Alert acknowledged.</p>}
    {outcome === "not_found" && <p role="alert">This alert is no longer available.</p>}
    {(outcome === "unavailable" || !acknowledgements) && <p role="alert">Acknowledgements are unavailable.</p>}
    <ul className="list incident-alert-list">
      {investigations.map(item => {
        const acknowledgedAt = acknowledgements?.get(item.id);
        const service = item.impacted_service ?? "Unknown workload";
        return <li className="alert-card" key={item.id}>
          {acknowledgements &&
            <span className={acknowledgedAt ? "pill info" : "pill warning"}>
              {acknowledgedAt ? "Acknowledged" : "New"}
            </span>}
          <div>
            <strong>{service} · {item.environment}</strong>
            <p>Captured <time dateTime={item.created_at}>{formatCentralDateTime(item.created_at)}</time></p>
            {acknowledgedAt && <p>Acknowledged <time dateTime={acknowledgedAt}>{formatCentralDateTime(acknowledgedAt)}</time></p>}
          </div>
          <Link href={`/investigations/${item.id}`} prefetch={false}>Review evidence</Link>
          {acknowledgements && !acknowledgedAt && <form action={acknowledgeAlert}>
            <input type="hidden" name="investigationId" value={item.id} />
            <button type="submit" aria-label={`Acknowledge ${service} alert`}>Acknowledge</button>
          </form>}
        </li>;
      })}
    </ul>
  </>;
}
