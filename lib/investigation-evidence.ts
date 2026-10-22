import { readTelemetry, type TelemetryRecord } from "./telemetry";

/**
 * Investigations need time-scoped error traces as well as current traces.
 * A single mixed-signal "latest 500" query is dominated by frequent
 * Kubernetes state snapshots and can miss short failures entirely.
 */
export async function readInvestigationEvidence(minutes: 15 | 60 | 360 | 1440 | 10080 = 60): Promise<TelemetryRecord[]> {
  const [applicationSpans, failingSpans, applicationLogs, kubernetesRecords] = await Promise.all([
    readTelemetry(500, "trace", undefined, "applications", { minutes }),
    readTelemetry(500, "trace", undefined, "applications", { minutes, errorsOnly: true }),
    readTelemetry(500, "log"),
    readTelemetry(500, "k8s_event"),
  ]);

  const cutoff = Date.now() - minutes * 60_000;
  const unique = new Map<string, TelemetryRecord>();

  for (const record of [...applicationSpans, ...failingSpans, ...applicationLogs, ...kubernetesRecords]) {
    const observed = Date.parse(record.observed_at);
    if (!Number.isFinite(observed) || observed < cutoff || observed > Date.now() + 5 * 60_000) continue;
    const key = record.id ?? [
      record.signal_type, record.service_name, record.observed_at,
      record.trace_id ?? "", record.span_id ?? "", record.message,
    ].join("|");
    if (!unique.has(key)) unique.set(key, record);
  }

  return [...unique.values()].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
}
