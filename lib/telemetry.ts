export type SignalType = "log" | "trace" | "metric" | "k8s_event";

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
  const config = supabaseConfig();

  if (!config) {
    memoryStore.unshift(...records);
    memoryStore.splice(5000);
    return { backend: "memory", accepted: records.length };
  }

  const response = await fetch(`${config.url}/rest/v1/telemetry_events`, {
    method: "POST",
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(records),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Supabase insert failed: ${response.status} ${await response.text()}`);
  }

  return { backend: "supabase", accepted: records.length };
}

export async function readTelemetry(limit = 100, signalType?: SignalType) {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const config = supabaseConfig();

  if (!config) {
    const records = signalType
      ? memoryStore.filter((record) => record.signal_type === signalType)
      : memoryStore;
    return records.slice(0, safeLimit);
  }

  const filter = signalType ? `&signal_type=eq.${encodeURIComponent(signalType)}` : "";
  const response = await fetch(
    `${config.url}/rest/v1/telemetry_events?select=*&order=observed_at.desc&limit=${safeLimit}${filter}`,
    {
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`Supabase query failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as TelemetryRecord[];
}

export function verifyIngestionKey(request: Request) {
  const expected = process.env.SIGNALDECK_INGESTION_KEY ?? "dev-signaldeck-key";
  const supplied = request.headers.get("authorization");
  return supplied === `Bearer ${expected}`;
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
  if (!Number.isFinite(nanos)) return new Date().toISOString();
  return new Date(nanos / 1_000_000).toISOString();
}
