import { readTelemetry, type TelemetryRecord } from "./telemetry";

const MINUTE = 60_000;
const MAX_HISTORICAL_DAYS = 90;

/** Accept an explicit UTC instant, never a browser-local ambiguous date. */
export function historicalInvestigationWindow(at: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at)) return null;
  const ms = Date.parse(at), now = Date.now();
  if (!Number.isFinite(ms) || ms > now || ms < now - (MAX_HISTORICAL_DAYS * 24 * 60 * MINUTE) + 30 * MINUTE) return null;
  return { from: new Date(ms - 30 * MINUTE).toISOString(), to: new Date(Math.min(now, ms + 30 * MINUTE)).toISOString() };
}

/**
 * Separate requests preserve failed traces and Kubernetes anomalies even when
 * high-volume healthy traces or state snapshots would otherwise evict them.
 * Historical mode reads a fixed 60-minute UTC window around a specific incident.
 */
export async function readInvestigationEvidence(
  minutes: 15 | 60 | 360 | 1440 | 10080 = 60,
  at?: string,
): Promise<TelemetryRecord[]> {
  const historical = at ? historicalInvestigationWindow(at) : null;
  if (at && !historical) throw new Error("Invalid historical incident timestamp");
  const filters = historical ? { minutes: 60, ...historical } : { minutes };
  const [applicationSpans, failingSpans, applicationLogs, kubernetesRecords, historicalAnomalies] = await Promise.all([
    readTelemetry(500, "trace", undefined, "applications", filters),
    readTelemetry(500, "trace", undefined, "applications", { ...filters, errorsOnly: true }),
    readTelemetry(500, "log", undefined, historical ? "history" : "investigation", filters),
    readTelemetry(500, "k8s_event", undefined, historical ? "history" : undefined, historical ? filters : undefined),
    readTelemetry(500, "k8s_event", undefined, "investigation", filters),
  ]);

  const cutoff = historical ? Date.parse(historical.from) : Date.now() - minutes * MINUTE;
  const upper = historical ? Date.parse(historical.to) : Date.now() + 5 * MINUTE;
  const unique = new Map<string, TelemetryRecord>();

  for (const record of [...applicationSpans, ...failingSpans, ...applicationLogs, ...kubernetesRecords, ...historicalAnomalies]) {
    const observed = Date.parse(record.observed_at);
    if (!Number.isFinite(observed) || observed < cutoff || observed > upper) continue;
    const key = record.id ?? [
      record.signal_type, record.service_name, record.observed_at,
      record.trace_id ?? "", record.span_id ?? "", record.message,
    ].join("|");
    if (!unique.has(key)) unique.set(key, record);
  }

  return [...unique.values()].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
}
