import type { ArchivedEvidence } from "./investigation-archive";
import type { IncidentRecord } from "./incidents";
import type { TelemetryRecord } from "./telemetry";

export type RecoveryValidation = {
  investigation_id: string;
  failed_source_id: string;
  telemetry_source_id: string;
  trace_id: string;
  span_id: string;
  observed_at: string;
  mitigated_at: string;
  http_status: number;
};

const serverKind = (kind: unknown) => kind === 2 || kind === "2" || kind === "SPAN_KIND_SERVER";

function archivedServerFailures(evidence: ArchivedEvidence[], service: string | null) {
  return evidence.filter(item => item.source_type === "trace" &&
    serverKind(item.payload.span_kind) && typeof item.payload.status_code === "number" &&
    item.payload.status_code >= 500 && item.payload.status_code < 600 &&
    item.resource_name === service &&
    typeof item.payload.http_route === "string" && item.payload.http_route.startsWith("/") &&
    typeof item.payload.http_method === "string" && item.payload.http_method.length > 0);
}

export function suggestIncidentRecovery(evidence: ArchivedEvidence[], service: string | null) {
  const [failure] = archivedServerFailures(evidence, service);
  if (!failure) return null;
  const route = `${failure.payload.http_method} ${failure.payload.http_route}`;
  const { trace_id: traceId, span_id: spanId } = failure.payload;
  const downstream = typeof traceId === "string" && traceId && typeof spanId === "string" && spanId
    ? evidence.find(item => item.source_type === "trace" && item.resource_name === service &&
        item.payload.trace_id === traceId && item.payload.parent_span_id === spanId &&
        [3, "3", "SPAN_KIND_CLIENT"].includes(item.payload.span_kind as number | string) &&
        typeof item.payload.status_code === "number" && item.payload.status_code >= 500 &&
        typeof item.payload.peer_service === "string" && item.payload.peer_service.length > 0)
    : undefined;
  return {
    recovery: downstream
      ? `Check serving health and recent changes for ${downstream.payload.peer_service}. Confirm the failure mechanism before applying an approved mitigation.`
      : `Use the failed ${route} span to inspect the application's errors and confirm a mitigation before applying it.`,
    validation: `Repeat ${route} after mitigation and record the resulting successful server trace in Incident response.`,
    sourceIds: downstream ? [failure.source_event_id, downstream.source_event_id] : [failure.source_event_id],
  };
}

export function verifyRecoveryProbe(
  incident: IncidentRecord,
  investigationId: string,
  evidence: ArchivedEvidence[],
  traces: TelemetryRecord[],
  traceId: string,
): RecoveryValidation | null {
  const mitigation = incident.mitigated_at;
  if (incident.status !== "mitigated" || !mitigation) return null;
  const failures = archivedServerFailures(evidence, incident.service_name).filter(item =>
    item.source_event_at && Date.parse(item.source_event_at) <= Date.parse(mitigation),
  );
  for (const probe of traces) {
    const attrs = probe.attributes;
    const method = attrs["http.request.method"] ?? attrs["http.method"];
    const status = probe.status_code;
    if (probe.signal_type !== "trace" || probe.trace_id !== traceId || !probe.id || !probe.span_id ||
        probe.workspace_id !== incident.workspace_id || probe.service_name !== incident.service_name ||
        probe.environment !== incident.environment || !serverKind(attrs["otel.span.kind"]) ||
        !(Date.parse(probe.observed_at) > Date.parse(mitigation)) ||
        typeof status !== "number" || !Number.isInteger(status) || status < 200 || status >= 300 ||
        probe.severity?.toUpperCase() === "ERROR") continue;

    const failure = failures.find(item =>
      item.payload.trace_id !== traceId && item.payload.http_route === attrs["http.route"] && item.payload.http_method === method,
    );
    if (!failure) continue;
    return {
      investigation_id: investigationId,
      failed_source_id: failure.source_event_id,
      telemetry_source_id: probe.id,
      trace_id: traceId,
      span_id: probe.span_id,
      observed_at: probe.observed_at,
      mitigated_at: mitigation,
      http_status: status,
    };
  }
  return null;
}
