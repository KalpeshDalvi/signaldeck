import { incidentPool } from "./incident-postgres";
import { workspaceId } from "./workspace";

export async function listIncidentInvestigationIds(incidentId: string) {
  const pool = incidentPool();
  if (!pool) return null;
  const { rows } = await pool.query<{ investigation_id: string }>(
    `SELECT investigation_id FROM public.incident_investigation_links
     WHERE workspace_id = $1 AND incident_id = $2
     ORDER BY investigation_id`, [workspaceId(), incidentId],
  );
  return rows.map(row => row.investigation_id);
}

export async function getInvestigationIncidentId(investigationId: string) {
  const pool = incidentPool();
  if (!pool) return null;
  const { rows } = await pool.query<{ incident_id: string }>(
    `SELECT incident_id FROM public.incident_investigation_links
     WHERE workspace_id = $1 AND investigation_id = $2`, [workspaceId(), investigationId],
  );
  return rows[0]?.incident_id ?? null;
}

export async function linkIncidentInvestigation(incidentId: string, investigationId: string) {
  const pool = incidentPool();
  if (!pool) return "unavailable";
  const workspace = workspaceId();
  // A replay of the same association succeeds. Concurrent claims of the same archive cannot both win.
  await pool.query(
    `INSERT INTO public.incident_investigation_links (workspace_id, incident_id, investigation_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [workspace, incidentId, investigationId],
  );
  return (await getInvestigationIncidentId(investigationId)) === incidentId ? "linked" : "conflict";
}
