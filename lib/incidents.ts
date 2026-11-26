import { workspaceId } from "./workspace";
import {
  appendStoredIncidentNote,
  ensureStoredIncidents,
  getStoredIncident,
  incidentKey,
  incidentPool,
  listStoredIncidents,
  listStoredIncidentHistory,
  updateStoredIncident,
} from "./incident-postgres";

export type IncidentStatus = "detected" | "investigating" | "mitigated" | "resolved";
export type IncidentSeverity = "SEV-1" | "SEV-2" | "SEV-3";

export type IncidentNote = { id: string; author: string; message: string; created_at: string };
export type IncidentRecord = {
  id: string;
  workspace_id: string;
  title: string;
  service_name: string;
  environment: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  owner: string | null;
  summary: string;
  started_at: string;
  updated_at: string;
  mitigated_at: string | null;
  resolved_at: string | null;
  notes: IncidentNote[];
};

export type IncidentCandidate = Pick<IncidentRecord, "workspace_id" | "title" | "service_name" | "environment" | "severity" | "summary">;
export type IncidentHistoryEntry = Pick<IncidentRecord,
  "id" | "title" | "environment" | "severity" | "status" | "owner" | "updated_at">;

export type IncidentPatch = Partial<Pick<IncidentRecord, "title" | "status" | "owner" | "severity" | "summary">>;

export class IncidentNotFoundError extends Error {
  constructor() {
    super("Incident not found");
  }
}

declare global {
  // eslint-disable-next-line no-var
  var signaldeckIncidents: IncidentRecord[] | undefined;
}

const memoryStore = globalThis.signaldeckIncidents ?? [];
globalThis.signaldeckIncidents = memoryStore;

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

function headers(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

export async function listIncidents(requestedWorkspace?: string) {
  const postgres = incidentPool();
  if (postgres) return listStoredIncidents(postgres, requestedWorkspace);
  return listLegacyIncidents(requestedWorkspace);
}

export const INCIDENT_HISTORY_LIMIT = 30;

export async function listIncidentHistory(): Promise<IncidentHistoryEntry[]> {
  const postgres = incidentPool();
  if (postgres) return listStoredIncidentHistory(postgres, INCIDENT_HISTORY_LIMIT);
  return listLegacyIncidents(undefined, INCIDENT_HISTORY_LIMIT);
}

async function listLegacyIncidents(requestedWorkspace?: string, limit?: number) {
  const selectedWorkspace = workspaceId(requestedWorkspace);
  const db = config();
  if (!db) {
    return memoryStore
      .filter((incident) => incident.workspace_id === selectedWorkspace)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }
  const response = await fetch(
    `${db.url}/rest/v1/incidents?select=*&workspace_id=eq.${encodeURIComponent(selectedWorkspace)}&order=updated_at.desc${limit === undefined ? "" : `&limit=${limit}`}`,
    { headers: headers(db.key), cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Incident query failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as IncidentRecord[];
}

export async function getIncident(id: string, requestedWorkspace?: string) {
  const postgres = incidentPool();
  if (postgres) return getStoredIncident(postgres, id, requestedWorkspace);
  const incidents = await listLegacyIncidents(requestedWorkspace);
  return incidents.find((incident) => incident.id === id) ?? null;
}

export async function ensureIncidents(inputs: IncidentCandidate[]) {
  if (!inputs.length) return [];
  const postgres = incidentPool();
  if (postgres) return ensureStoredIncidents(postgres, inputs);

  const normalized = inputs.map(input => ({ ...input, workspace_id: workspaceId(input.workspace_id) }));
  const workspaces = [...new Set(normalized.map(input => input.workspace_id))];
  const active = new Map<string, IncidentRecord>();
  const keyFor = (input: IncidentCandidate) => JSON.stringify([input.workspace_id, incidentKey(input)]);
  await Promise.all(workspaces.map(async workspace => {
    for (const incident of await listLegacyIncidents(workspace)) {
      const key = keyFor(incident);
      if (incident.status !== "resolved" && !active.has(key)) active.set(key, incident);
    }
  }));
  const unique = new Map(normalized.map(input => [keyFor(input), input]));
  const records = new Map(await Promise.all(Array.from(unique, async ([key, input]) =>
    [key, await ensureLegacyIncident(input, active.get(key))] as const,
  )));
  return normalized.map(input => records.get(keyFor(input))!);
}

export async function ensureIncident(input: IncidentCandidate) {
  const [incident] = await ensureIncidents([input]);
  return incident;
}

async function ensureLegacyIncident(input: IncidentCandidate, existing?: IncidentRecord) {
  if (existing) {
    if (existing.title !== input.title || existing.summary !== input.summary || existing.severity !== input.severity) {
      return updateLegacyIncident(existing, { title: input.title, summary: input.summary, severity: input.severity });
    }
    return existing;
  }

  const now = new Date().toISOString();
  const incident: IncidentRecord = {
    id: crypto.randomUUID(),
    ...input,
    status: "detected",
    owner: null,
    started_at: now,
    updated_at: now,
    mitigated_at: null,
    resolved_at: null,
    notes: [],
  };

  const db = config();
  if (!db) {
    memoryStore.unshift(incident);
    return incident;
  }

  const response = await fetch(`${db.url}/rest/v1/incidents`, {
    method: "POST",
    headers: { ...headers(db.key), Prefer: "return=representation" },
    body: JSON.stringify(incident),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Incident insert failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as IncidentRecord[])[0];
}

export async function updateIncident(id: string, patch: IncidentPatch, requestedWorkspace?: string) {
  const postgres = incidentPool();
  if (postgres) {
    const incident = await updateStoredIncident(postgres, id, patch, requestedWorkspace);
    if (!incident) throw new IncidentNotFoundError();
    return incident;
  }
  const current = await getIncident(id, requestedWorkspace);
  if (!current) throw new IncidentNotFoundError();
  return updateLegacyIncident(current, patch);
}

async function updateLegacyIncident(current: IncidentRecord, patch: IncidentPatch & { notes?: IncidentNote[] }) {
  const now = new Date().toISOString();
  const next: IncidentRecord = {
    ...current,
    ...patch,
    updated_at: now,
    mitigated_at: patch.status === "mitigated" && !current.mitigated_at ? now : current.mitigated_at,
    resolved_at: patch.status === "resolved" && !current.resolved_at ? now : current.resolved_at,
  };

  const db = config();
  if (!db) {
    const index = memoryStore.findIndex((incident) => incident.id === current.id && incident.workspace_id === current.workspace_id);
    memoryStore[index] = next;
    return next;
  }

  const response = await fetch(
    `${db.url}/rest/v1/incidents?id=eq.${encodeURIComponent(current.id)}&workspace_id=eq.${encodeURIComponent(current.workspace_id)}`,
    {
      method: "PATCH",
      headers: { ...headers(db.key), Prefer: "return=representation" },
      body: JSON.stringify(next),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error(`Incident update failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as IncidentRecord[])[0];
}

export async function addIncidentNote(id: string, author: string, message: string, requestedWorkspace?: string) {
  const note: IncidentNote = { id: crypto.randomUUID(), author, message, created_at: new Date().toISOString() };
  const postgres = incidentPool();
  if (postgres) {
    const incident = await appendStoredIncidentNote(postgres, id, note, requestedWorkspace);
    if (!incident) throw new IncidentNotFoundError();
    return incident;
  }
  const incident = await getIncident(id, requestedWorkspace);
  if (!incident) throw new IncidentNotFoundError();
  return updateLegacyIncident(incident, { notes: [...incident.notes, note] });
}
