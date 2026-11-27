import type { Pool } from "pg";
import { workspaceId } from "./workspace";

type Acknowledgement = { investigation_id: string; acknowledged_at: Date };
type AcknowledgeResult = "acknowledged" | "not_found";

export async function listInvestigationAcknowledgements(db: Pool, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();

  const { rows } = await db.query<Acknowledgement>(
    `SELECT investigation_id, acknowledged_at
     FROM public.investigation_acknowledgements
     WHERE workspace_id = $1 AND investigation_id = ANY($2::uuid[])`,
    [workspaceId(), ids],
  );
  return new Map(rows.map(row => [row.investigation_id, row.acknowledged_at.toISOString()]));
}

export async function acknowledgeInvestigation(db: Pool, id: string): Promise<AcknowledgeResult> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return "not_found";

  try {
    await db.query(
      `INSERT INTO public.investigation_acknowledgements (workspace_id, investigation_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [workspaceId(), id],
    );
    return "acknowledged";
  } catch (error) {
    if ((error as { code?: string }).code === "23503") return "not_found";
    throw error;
  }
}
