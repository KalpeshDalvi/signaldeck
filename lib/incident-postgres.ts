import { Pool, type PoolClient } from "pg";
import type { IncidentCandidate, IncidentHistoryEntry, IncidentNote, IncidentPatch, IncidentRecord } from "./incidents";
import { workspaceId } from "./workspace";

type IncidentRow = Omit<IncidentRecord, "started_at" | "updated_at" | "mitigated_at" | "resolved_at"> & {
  started_at: Date;
  updated_at: Date;
  mitigated_at: Date | null;
  resolved_at: Date | null;
};

declare global {
  // The page and API route can load separate server bundles in the same process.
  var signaldeckIncidentPool: Pool | undefined;
}

export function incidentPool() {
  const host = process.env.SIGNALDECK_INCIDENT_DB_HOST;
  const database = process.env.SIGNALDECK_INCIDENT_DB_NAME;
  const password = process.env.SIGNALDECK_INCIDENT_DB_PASSWORD;
  const port = Number(process.env.SIGNALDECK_INCIDENT_DB_PORT ?? 5432);
  if ([host, database, password, process.env.SIGNALDECK_INCIDENT_DB_PORT].every(value => value === undefined)) {
    return undefined;
  }
  if (!host || !database || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Incomplete incident database configuration");
  }
  if (!globalThis.signaldeckIncidentPool) {
    const pool = new Pool({
      host, database, password, port, user: "signaldeck_incident_writer",
      max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, idleTimeoutMillis: 10000,
    });
    pool.on("error", () => console.error("Idle incident database connection failed"));
    globalThis.signaldeckIncidentPool = pool;
  }
  return globalThis.signaldeckIncidentPool;
}

export function incidentKey({ environment, service_name }: IncidentCandidate) {
  return JSON.stringify([service_name, environment]);
}

function toIncident(row: IncidentRow): IncidentRecord {
  return {
    ...row,
    started_at: row.started_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    mitigated_at: row.mitigated_at?.toISOString() ?? null,
    resolved_at: row.resolved_at?.toISOString() ?? null,
  };
}

function scopedWorkspace(requestedWorkspace?: string) {
  const workspace = workspaceId();
  if (workspaceId(requestedWorkspace) !== workspace) throw new Error("Incident workspace is unavailable");
  return workspace;
}

export async function listStoredIncidents(db: Pool, requestedWorkspace?: string) {
  const { rows } = await db.query<IncidentRow>(`
    SELECT * FROM public.incidents WHERE workspace_id = $1 ORDER BY updated_at DESC
  `, [scopedWorkspace(requestedWorkspace)]);
  return rows.map(toIncident);
}

export async function listStoredIncidentHistory(db: Pool, limit: number): Promise<IncidentHistoryEntry[]> {
  type HistoryRow = Omit<IncidentHistoryEntry, "updated_at"> & { updated_at: Date };
  const { rows } = await db.query<HistoryRow>(`
    SELECT id, title, environment, severity, status, owner, updated_at
    FROM public.incidents
    WHERE workspace_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2
  `, [scopedWorkspace(), limit]);
  return rows.map(row => ({ ...row, updated_at: row.updated_at.toISOString() }));
}

function incidentParams(id: string, requestedWorkspace?: string) {
  const workspace = scopedWorkspace(requestedWorkspace);
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? [workspace, id] : null;
}

export async function getStoredIncident(db: Pool, id: string, requestedWorkspace?: string) {
  const params = incidentParams(id, requestedWorkspace);
  if (!params) return null;
  const { rows } = await db.query<IncidentRow>(`
    SELECT * FROM public.incidents WHERE workspace_id = $1 AND id = $2
  `, params);
  return rows[0] ? toIncident(rows[0]) : null;
}

export async function updateStoredIncident(db: Pool, id: string, patch: IncidentPatch, requestedWorkspace?: string) {
  const params = incidentParams(id, requestedWorkspace);
  if (!params) return null;
  const { rows } = await db.query<IncidentRow>(`
    WITH input AS (SELECT $3::jsonb AS patch)
    UPDATE public.incidents AS incident
    SET title = COALESCE(input.patch->>'title', incident.title),
        status = COALESCE(input.patch->>'status', incident.status),
        owner = CASE WHEN input.patch ? 'owner' THEN input.patch->>'owner' ELSE incident.owner END,
        severity = COALESCE(input.patch->>'severity', incident.severity),
        summary = COALESCE(input.patch->>'summary', incident.summary),
        updated_at = statement_timestamp(),
        mitigated_at = CASE WHEN input.patch->>'status' = 'mitigated'
          THEN COALESCE(incident.mitigated_at, statement_timestamp()) ELSE incident.mitigated_at END,
        resolved_at = CASE WHEN input.patch->>'status' = 'resolved'
          THEN COALESCE(incident.resolved_at, statement_timestamp()) ELSE incident.resolved_at END
    FROM input
    WHERE incident.workspace_id = $1 AND incident.id = $2
    RETURNING incident.*
  `, [...params, JSON.stringify(patch)]);
  return rows[0] ? toIncident(rows[0]) : null;
}

export async function appendStoredIncidentNote(db: Pool, id: string, note: IncidentNote, requestedWorkspace?: string) {
  const params = incidentParams(id, requestedWorkspace);
  if (!params) return null;
  const { rows } = await db.query<IncidentRow>(`
    UPDATE public.incidents
    SET notes = notes || jsonb_build_array($3::jsonb), updated_at = statement_timestamp()
    WHERE workspace_id = $1 AND id = $2
    RETURNING *
  `, [...params, JSON.stringify(note)]);
  return rows[0] ? toIncident(rows[0]) : null;
}

async function findActiveIncidents(db: Pool | PoolClient, workspace: string, candidates: string, lock: boolean) {
  const { rows } = await db.query<IncidentRow>(`
    SELECT incident.*
    FROM jsonb_to_recordset($2::jsonb) AS candidate(service_name text, environment text)
    CROSS JOIN LATERAL (
      SELECT * FROM public.incidents
      WHERE workspace_id = $1
        AND service_name = candidate.service_name AND environment = candidate.environment
        AND status <> 'resolved'
      ORDER BY updated_at DESC, id
      LIMIT 1
      ${lock ? "FOR NO KEY UPDATE" : ""}
    ) AS incident
  `, [workspace, candidates]);
  return new Map(rows.map(row => [incidentKey(row), row]));
}

function needsUpdate(current: IncidentRow, candidate: IncidentCandidate) {
  return current.title !== candidate.title || current.summary !== candidate.summary || current.severity !== candidate.severity;
}

export async function ensureStoredIncidents(db: Pool, inputs: IncidentCandidate[]) {
  const workspace = scopedWorkspace();
  const candidates = new Map(inputs.map(input => {
    scopedWorkspace(input.workspace_id);
    return [incidentKey(input), input];
  }));
  const requested = JSON.stringify([...candidates.values()]);
  const active = await findActiveIncidents(db, workspace, requested, false);
  const inInputOrder = (rows: Map<string, IncidentRow>) => inputs.map(input => toIncident(rows.get(incidentKey(input))!));
  const requiresWrite = [...candidates].some(([key, candidate]) => {
    const current = active.get(key);
    return !current || needsUpdate(current, candidate);
  });
  if (!requiresWrite) return inInputOrder(active);

  const client = await db.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    // Recheck after taking the lock so simultaneous renders cannot create duplicate active incidents.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('signaldeck.incidents:' || $1, 0))", [workspace]);
    const rows = await findActiveIncidents(client, workspace, requested, true);
    const inserts: IncidentCandidate[] = [];
    const updates: (IncidentCandidate & { id: string })[] = [];
    for (const [key, candidate] of candidates) {
      const current = rows.get(key);
      if (!current) inserts.push(candidate);
      else if (needsUpdate(current, candidate)) updates.push({ ...candidate, id: current.id });
    }
    if (inserts.length) {
      const inserted = await client.query<IncidentRow>(`
        INSERT INTO public.incidents (workspace_id, title, service_name, environment, severity, status, summary)
        SELECT $1, title, service_name, environment, severity, 'detected', summary
        FROM jsonb_to_recordset($2::jsonb) AS candidate(title text, service_name text, environment text, severity text, summary text)
        RETURNING *
      `, [workspace, JSON.stringify(inserts)]);
      for (const row of inserted.rows) rows.set(incidentKey(row), row);
    }
    if (updates.length) {
      const updated = await client.query<IncidentRow>(`
        UPDATE public.incidents AS incident
        SET title = candidate.title, severity = candidate.severity, summary = candidate.summary, updated_at = statement_timestamp()
        FROM jsonb_to_recordset($2::jsonb) AS candidate(id uuid, title text, severity text, summary text)
        WHERE incident.workspace_id = $1 AND incident.id = candidate.id
        RETURNING incident.*
      `, [workspace, JSON.stringify(updates)]);
      for (const row of updated.rows) rows.set(incidentKey(row), row);
    }
    await client.query("COMMIT");
    return inInputOrder(rows);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
