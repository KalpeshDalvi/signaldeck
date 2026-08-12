import type { TelemetryRecord } from "./telemetry";
import { summarizeServices, type ServiceSummary } from "./analytics";
import { correlateIncident, type CorrelationFinding } from "./incident-correlation";

export type IncidentCandidate = {
  key: string;
  service: ServiceSummary;
  finding: CorrelationFinding;
  records: TelemetryRecord[];
  firstFailureAt?: string;
  lastFailureAt?: string;
  traceIds: string[];
};

function isFailure(record: TelemetryRecord) {
  return (record.status_code ?? 0) >= 500 || record.severity?.toUpperCase() === "ERROR";
}

function candidateRecords(records: TelemetryRecord[], service: ServiceSummary) {
  const serviceFailures = records.filter((record) => record.signal_type === "trace" && record.service_name === service.name && record.environment === service.environment && isFailure(record));
  const traceIds = new Set(serviceFailures.map((record) => record.trace_id).filter(Boolean));
  const tracePath = records.filter((record) => record.signal_type === "trace" && record.trace_id && traceIds.has(record.trace_id));
  const terms = new Set([service.name]);
  for (const record of tracePath) {
    const url = String(record.attributes?.["http.url"] ?? record.attributes?.["url.full"] ?? "");
    const peer = String(record.attributes?.["peer.service"] ?? record.attributes?.["server.address"] ?? "");
    for (const value of [url, peer]) {
      const match = value.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
      if (match) terms.add(match);
    }
  }
  const support = records.filter((record) => {
    if (record.signal_type === "trace") return false;
    const haystack = `${record.service_name} ${record.message} ${JSON.stringify(record.attributes)}`.toLowerCase();
    return [...terms].some((term) => haystack.includes(term.toLowerCase()));
  });
  return [...tracePath, ...support];
}

export function clusterIncidentCandidates(records: TelemetryRecord[]): IncidentCandidate[] {
  const services = summarizeServices(records).filter((service) => service.status !== "Healthy");
  const candidates: IncidentCandidate[] = [];

  for (const service of services) {
    const scoped = candidateRecords(records, service);
    const finding = correlateIncident(scoped.length ? scoped : records, service);
    if (!finding) continue;
    const failures = records
      .filter((record) => record.signal_type === "trace" && record.service_name === service.name && record.environment === service.environment && isFailure(record))
      .sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());
    const traceIds = [...new Set(failures.map((record) => record.trace_id).filter(Boolean) as string[])];
    candidates.push({
      key: `${service.environment}:${service.name}`,
      service,
      finding,
      records: scoped,
      firstFailureAt: failures[0]?.observed_at,
      lastFailureAt: failures[failures.length - 1]?.observed_at,
      traceIds,
    });
  }

  return candidates.sort((a, b) => b.finding.score - a.finding.score || b.service.errorRate - a.service.errorRate || b.service.p95 - a.service.p95);
}
