import "server-only";
import { GoogleAuth } from "google-auth-library";

export type ArchivedInvestigation = {
  id: string;
  incident_key: string;
  incident_at: string;
  environment: string;
  impacted_service: string | null;
  suspected_dependency: string | null;
  status: "investigating" | "mitigated" | "resolved" | "incomplete";
  hypothesis: string | null;
  verified_mechanism: string | null;
  initiating_change: string | null;
  initiating_actor: string | null;
  immediate_recovery: string | null;
  recurrence_prevention: string | null;
  verification_plan: string | null;
  limitations: string | null;
  created_at: string;
  updated_at: string;
};
export type ArchivedEvidence = {
  id: string;
  source_type: string;
  source_event_id: string;
  source_event_at: string | null;
  captured_at: string;
  resource_name: string | null;
  summary: string;
  payload: Record<string, unknown>;
};
export type ArchiveRead<T> =
  | { status: "ok"; data: T }
  | { status: "unavailable" | "not_configured" | "not_found"; data: null };

async function archiveFetch<T>(path: string): Promise<ArchiveRead<T>> {
  const base = process.env.SIGNALDECK_READ_API_URL;
  const key = process.env.SIGNALDECK_READ_API_KEY;
  if (!base || !key) return { status: "not_configured", data: null };
  try {
    const url = new URL(path, base);
    const audience = new URL(base).origin;
    const idClient = await new GoogleAuth().getIdTokenClient(audience);
    const headers = await idClient.getRequestHeaders(audience);
    const idToken = headers.Authorization ?? headers.authorization;
    if (!idToken) return { status: "unavailable", data: null };
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, "X-Serverless-Authorization": idToken },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return { status: "not_found", data: null };
    if (!response.ok) {
      console.error("Signaldeck archive read returned HTTP", response.status);
      return { status: "unavailable", data: null };
    }
    const data = await response.json() as T;
    return { status: "ok", data };
  } catch (error) {
    console.error("Signaldeck archive read error", error instanceof Error ? error.name : "unknown");
    return { status: "unavailable", data: null };
  }
}

export async function listArchivedInvestigations(): Promise<ArchiveRead<{ investigations: ArchivedInvestigation[] }>> {
  return archiveFetch("/v1/investigations?limit=30");
}
export async function getArchivedInvestigation(id: string): Promise<ArchiveRead<{
  investigation: ArchivedInvestigation;
  evidence: ArchivedEvidence[];
}>> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: "not_found", data: null };
  return archiveFetch(`/v1/investigations/${id}`);
}
