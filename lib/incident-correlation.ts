import type { TelemetryRecord } from "./telemetry";
import type { ServiceSummary } from "./analytics";

export type CorrelationFinding = {
  score: number;
  confidence: "High" | "Medium" | "Low";
  affectedService: string;
  dependency?: string;
  pod?: string;
  workload?: string;
  summary: string;
  evidence: string[];
};

function text(record: TelemetryRecord) {
  return `${record.service_name} ${record.message} ${JSON.stringify(record.attributes)}`.toLowerCase();
}

function isFailure(record: TelemetryRecord) {
  return (record.status_code ?? 0) >= 500 || record.severity?.toUpperCase() === "ERROR";
}

function attr(record: TelemetryRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record.attributes?.[key];
    if (value !== undefined && value !== null && String(value)) return String(value);
  }
  return undefined;
}

export function correlateIncident(records: TelemetryRecord[], primary?: ServiceSummary): CorrelationFinding | null {
  if (!primary) return null;
  const traces = records.filter((r) => r.signal_type === "trace");
  const failures = traces.filter(isFailure);
  const serviceFailures = failures.filter((r) => r.service_name === primary.name);
  const relatedTraceIds = new Set(serviceFailures.map((r) => r.trace_id).filter(Boolean));
  const relatedSpans = traces.filter((r) => r.trace_id && relatedTraceIds.has(r.trace_id));

  const dependencyCounts = new Map<string, number>();
  for (const span of relatedSpans) {
    if (span.service_name !== primary.name && isFailure(span)) dependencyCounts.set(span.service_name, (dependencyCounts.get(span.service_name) ?? 0) + 1);
    const peer = attr(span, "peer.service", "server.address", "http.host", "net.peer.name");
    if (peer && peer !== primary.name && isFailure(span)) dependencyCounts.set(peer, (dependencyCounts.get(peer) ?? 0) + 1);
  }
  const dependency = [...dependencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const kube = records.filter((r) => r.signal_type === "k8s_event");
  const serviceTerms = [primary.name, dependency].filter(Boolean) as string[];
  const relatedKube = kube.filter((r) => serviceTerms.some((term) => text(r).includes(term.toLowerCase())));
  const unhealthyKube = relatedKube.filter((r) => {
    const phase = attr(r, "k8s.pod.phase") ?? "";
    const reason = attr(r, "k8s.pod.reason", "k8s.event.reason") ?? "";
    return r.severity === "ERROR" || phase === "Failed" || phase === "Pending" || /crash|oom|failed|unhealthy|backoff|error/i.test(`${reason} ${r.message}`);
  });
  const strongestKube = unhealthyKube[0] ?? relatedKube[0];
  const pod = strongestKube ? attr(strongestKube, "k8s.pod.name", "k8s.object.name") : undefined;
  const workload = strongestKube ? attr(strongestKube, "k8s.deployment.name", "k8s.workload.name") : undefined;

  let score = 20;
  const evidence: string[] = [];
  if (serviceFailures.length) { score += 20; evidence.push(`${serviceFailures.length} failed trace${serviceFailures.length === 1 ? "" : "s"} observed for ${primary.name}.`); }
  if (primary.errorRate >= 2) { score += 10; evidence.push(`${primary.name} error rate is ${primary.errorRate.toFixed(1)}%.`); }
  if (primary.p95 >= 750) { score += 10; evidence.push(`${primary.name} P95 latency is ${Math.round(primary.p95)} ms.`); }
  if (dependency) { score += 20; evidence.push(`Failed traces correlate with dependency ${dependency}.`); }
  if (unhealthyKube.length) { score += 20; evidence.push(`${unhealthyKube.length} unhealthy Kubernetes evidence record${unhealthyKube.length === 1 ? "" : "s"} correlate with the affected path.`); }
  else if (relatedKube.length) evidence.push(`Kubernetes state for the affected path is available, with no unhealthy state currently observed.`);
  score = Math.min(100, score);
  const confidence = score >= 75 ? "High" : score >= 50 ? "Medium" : "Low";

  const summary = dependency && unhealthyKube.length
    ? `${primary.name} failures correlate with ${dependency}, with Kubernetes evidence on ${pod ?? workload ?? "the affected workload"}.`
    : dependency
      ? `${primary.name} failures correlate most strongly with dependency ${dependency}.`
      : unhealthyKube.length
        ? `${primary.name} degradation overlaps Kubernetes instability on ${pod ?? workload ?? "the affected workload"}.`
        : `${primary.name} is degraded, but the current sample does not yet prove a downstream or Kubernetes root cause.`;

  return { score, confidence, affectedService: primary.name, dependency, pod, workload, summary, evidence };
}
