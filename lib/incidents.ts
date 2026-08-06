export type IncidentStatus = "detected" | "investigating" | "mitigated" | "resolved";
export type IncidentSeverity = "SEV-1" | "SEV-2" | "SEV-3";

export type IncidentNote = {
  id: string;
  author: string;
  message: string;
  created_at: string;
};

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

export async function listIncidents() {
  const db = config();
  if (!db) return [...memoryStore].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const response = await fetch(`${db.url}/rest/v1/incidents?select=*&order=updated_at.desc`, { headers: headers(db.key), cache: "no-store" });
  if (!response.ok) throw new Error(`Incident query failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as IncidentRecord[];
}

export async function getIncident(id: string) {
  const incidents = await listIncidents();
  return incidents.find((incident) => incident.id === id) ?? null;
}

export async function ensureIncident(input: Pick<IncidentRecord, "workspace_id" | "title" | "service_name" | "environment" | "severity" | "summary">) {
  const incidents = await listIncidents();
  const existing = incidents.find((incident) => incident.service_name === input.service_name && incident.environment === input.environment && incident.status !== "resolved");
  if (existing) return existing;

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

export async function updateIncident(id: string, patch: Partial<Pick<IncidentRecord, "status" | "owner" | "severity" | "summary" | "notes">>) {
  const current = await getIncident(id);
  if (!current) throw new Error("Incident not found");
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
    const index = memoryStore.findIndex((incident) => incident.id === id);
    memoryStore[index] = next;
    return next;
  }

  const response = await fetch(`${db.url}/rest/v1/incidents?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...headers(db.key), Prefer: "return=representation" },
    body: JSON.stringify(next),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Incident update failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as IncidentRecord[])[0];
}

export async function addIncidentNote(id: string, author: string, message: string) {
  const incident = await getIncident(id);
  if (!incident) throw new Error("Incident not found");
  const note: IncidentNote = { id: crypto.randomUUID(), author, message, created_at: new Date().toISOString() };
  return updateIncident(id, { notes: [...incident.notes, note] });
}
