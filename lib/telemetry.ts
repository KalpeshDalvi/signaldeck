import { workspaceId } from "./workspace";
import { GoogleAuth } from "google-auth-library";

export type SignalType = "log" | "trace" | "metric" | "k8s_event" | "deployment";

export type TelemetryRecord = {
  id?: string;
  workspace_id: string;
  signal_type: SignalType;
  service_name: string;
  environment: string;
  severity?: string;
  message: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  duration_ms?: number;
  status_code?: number;
  attributes: Record<string, unknown>;
  observed_at: string;
};

declare global {
  // eslint-disable-next-line no-var
  var signaldeckTelemetry: TelemetryRecord[] | undefined;
}

const memoryStore = globalThis.signaldeckTelemetry ?? [];
globalThis.signaldeckTelemetry = memoryStore;

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

export async function saveTelemetry(records: TelemetryRecord[]) {
  const normalized = records.map((record) => ({
    workspace_id: workspaceId(record.workspace_id), signal_type: record.signal_type, service_name: record.service_name,
    environment: record.environment, severity: record.severity ?? null, message: record.message,
    trace_id: record.trace_id ?? null, span_id: record.span_id ?? null, parent_span_id: record.parent_span_id ?? null,
    duration_ms: record.duration_ms ?? null, status_code: record.status_code ?? null, attributes: record.attributes ?? {}, observed_at: record.observed_at,
  }));
  const config = supabaseConfig();
  if (!config) { memoryStore.unshift(...(normalized as TelemetryRecord[])); memoryStore.splice(5000); return { backend: "memory", accepted: normalized.length }; }
  const response = await fetch(`${config.url}/rest/v1/telemetry_events`, {
    method: "POST",
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(normalized), cache: "no-store",
  });
  if (!response.ok) throw new Error(`Supabase insert failed: ${response.status} ${await response.text()}`);
  return { backend: "supabase", accepted: normalized.length };
}

export async function readTelemetry(limit = 100, signalType?: SignalType, requestedWorkspace?: string, view?: "applications", traceFilters?: { minutes?: number; service?: string; errorsOnly?: boolean }) {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const selectedWorkspace = workspaceId(requestedWorkspace);
  const readApiUrl = process.env.SIGNALDECK_READ_API_URL;
  if (readApiUrl) {
    const key = process.env.SIGNALDECK_READ_API_KEY;
    if (!key) throw new Error("SIGNALDECK_READ_API_KEY is required when the read API is configured");
    // The read API fixes the workspace server-side. Never allow a caller to choose another tenant.
    if (selectedWorkspace !== (process.env.SIGNALDECK_WORKSPACE_ID ?? "default")) {
      throw new Error("Requested workspace does not match the configured read API workspace");
    }
    const endpoint = new URL("/v1/telemetry", readApiUrl);
    endpoint.searchParams.set("limit", String(safeLimit));
    if (signalType) endpoint.searchParams.set("type", signalType);
    if (signalType === "trace" && view === "applications") {
      endpoint.searchParams.set("view", view);
      if (traceFilters?.minutes) endpoint.searchParams.set("minutes", String(traceFilters.minutes));
      if (traceFilters?.service) endpoint.searchParams.set("service", traceFilters.service);
      if (traceFilters?.errorsOnly) endpoint.searchParams.set("errors", "1");
    }
    const audience = new URL(readApiUrl).origin;
    const identityClient = await new GoogleAuth().getIdTokenClient(audience);
    const identityHeaders = await identityClient.getRequestHeaders(audience);
    const identityToken = identityHeaders.Authorization ?? identityHeaders.authorization;
    if (!identityToken) throw new Error("Unable to obtain Cloud Run identity token");
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${key}`, "X-Serverless-Authorization": identityToken },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Telemetry read API returned HTTP ${response.status}`);
    const result = (await response.json()) as { records?: TelemetryRecord[] };
    if (!Array.isArray(result.records)) throw new Error("Unexpected telemetry read API response");
    return result.records;
  }
  const config = supabaseConfig();
  if (!config) {
    const records = memoryStore.filter((record) => record.workspace_id === selectedWorkspace && (!signalType || record.signal_type === signalType));
    return records.slice(0, safeLimit);
  }
  const signalFilter = signalType ? `&signal_type=eq.${encodeURIComponent(signalType)}` : "";
  const response = await fetch(
    `${config.url}/rest/v1/telemetry_events?select=*&workspace_id=eq.${encodeURIComponent(selectedWorkspace)}&order=observed_at.desc&limit=${safeLimit}${signalFilter}`,
    {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
      next: { revalidate: 10 },
    },
  );
  if (!response.ok) throw new Error(`Supabase query failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as TelemetryRecord[];
}

export function verifyIngestionKey(request: Request) {
  const expected = process.env.SIGNALDECK_INGESTION_KEY;
  return Boolean(expected) && request.headers.get("authorization") === `Bearer ${expected}`;
}

export function valueOf(attributeList: Array<{ key?: string; value?: Record<string, unknown> }> | undefined, key: string) {
  const item = attributeList?.find((attribute) => attribute.key === key);
  if (!item?.value) return undefined;
  const value = item.value;
  return value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue;
}

export function nanosToIso(value: string | number | undefined) {
  if (!value) return new Date().toISOString();
  const nanos = Number(value);
  return Number.isFinite(nanos) ? new Date(nanos / 1_000_000).toISOString() : new Date().toISOString();
}
