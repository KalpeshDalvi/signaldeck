import type { TelemetryRecord } from "./telemetry";
import type { ServiceSummary } from "./analytics";

export type EvidenceStep = {
  label: string;
  source: "TRACE" | "METRIC" | "KUBERNETES" | "CORRELATION";
  detail: string;
  meta?: string;
};

export type CorrelationFinding = {
  score: number;
  confidence: "High" | "Medium" | "Low";
  affectedService: string;
  dependency?: string;
  pod?: string;
  workload?: string;
  summary: string;
  evidence: string[];
  evidenceSteps: EvidenceStep[];
  coverage: { label: string; detail: string; present: boolean }[];
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

function downstreamTarget(record: TelemetryRecord) {
  const explicit = attr(record, "peer.service", "server.address", "net.peer.name", "rpc.service");
  if (explicit) return explicit.replace(/^https?:\/\//, "").split("/")[0];
  const url = attr(record, "http.url", "url.full");
  if (url) {
    try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").split("/")[0]; }
  }
  const spanKind = Number(attr(record, "otel.span.kind") ?? 0);
  return spanKind === 3 ? attr(record, "http.host") : undefined;
}

function serviceNameFromTarget(target?: string) {
  if (!target) return undefined;
  return target.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
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
    if (!isFailure(span)) continue;
    if (span.service_name !== primary.name) dependencyCounts.set(span.service_name, (dependencyCounts.get(span.service_name) ?? 0) + 1);
    const targetService = serviceNameFromTarget(downstreamTarget(span));
    if (targetService && targetService !== primary.name) dependencyCounts.set(targetService, (dependencyCounts.get(targetService) ?? 0) + 1);
  }
  const dependency = [...dependencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const dependencyHits = dependency ? dependencyCounts.get(dependency) ?? 0 : 0;

  const kube = records.filter((r) => r.signal_type === "k8s_event");
  const serviceTerms = [primary.name, dependency].filter(Boolean) as string[];
  const relatedKube = kube.filter((r) => serviceTerms.some((term) => text(r).includes(term.toLowerCase())));
  const dependencyDeployment = dependency ? relatedKube.find((r) =>
    r.attributes["k8s.kind"] === "Deployment" && String(r.attributes["k8s.deployment.name"] ?? r.service_name) === dependency
  ) : undefined;
  const dependencyService = dependency ? relatedKube.find((r) =>
    r.attributes["k8s.kind"] === "Service" && String(r.attributes["k8s.service.name"] ?? r.service_name) === dependency
  ) : undefined;
  const deploymentReplicas = dependencyDeployment ? Number(dependencyDeployment.attributes["k8s.deployment.replicas"] ?? NaN) : NaN;
  const readyReplicas = dependencyDeployment ? Number(dependencyDeployment.attributes["k8s.deployment.ready_replicas"] ?? 0) : NaN;
  const deploymentUnavailable = Boolean(dependencyDeployment && Number.isFinite(deploymentReplicas) && deploymentReplicas === 0);

  const unhealthyKube = relatedKube.filter((r) => {
    const phase = attr(r, "k8s.pod.phase") ?? "";
    const reason = attr(r, "k8s.pod.reason", "k8s.event.reason") ?? "";
    return r.severity === "ERROR" || phase === "Failed" || phase === "Pending" || /crash|oom|failed|unhealthy|backoff|error/i.test(`${reason} ${r.message}`);
  });
  const strongestKube = dependencyDeployment ?? unhealthyKube[0] ?? relatedKube[0];
  const pod = strongestKube ? attr(strongestKube, "k8s.pod.name") : undefined;
  const workload = dependencyDeployment ? attr(dependencyDeployment, "k8s.deployment.name") ?? dependency : strongestKube ? attr(strongestKube, "k8s.deployment.name", "k8s.workload.name") : undefined;

  let score = 20;
  const evidence: string[] = [];
  const evidenceSteps: EvidenceStep[] = [];
  if (serviceFailures.length) {
    score += 20;
    evidence.push(`${serviceFailures.length} failed traces observed for ${primary.name}.`);
    evidenceSteps.push({ label: "User-facing failure detected", source: "TRACE", detail: `${primary.name} is experiencing elevated request failures.`, meta: `${serviceFailures.length} failed traces · ${primary.errorRate.toFixed(1)}% error rate` });
  }
  if (primary.errorRate >= 2 || primary.p95 >= 750) {
    if (primary.errorRate >= 2) score += 10;
    if (primary.p95 >= 750) score += 10;
    evidence.push(`${primary.name} error rate is ${primary.errorRate.toFixed(1)}%; P95 latency is ${Math.round(primary.p95)} ms.`);
    evidenceSteps.push({ label: "Performance impact confirmed", source: "METRIC", detail: `${primary.name} P95 latency is ${(primary.p95 / 1000).toFixed(2)} s.`, meta: `${primary.errorRate.toFixed(1)}% errors · ${primary.status}` });
  }
  if (dependency) {
    score += 20;
    evidence.push(`Failed traces correlate with downstream dependency ${dependency}.`);
    evidenceSteps.push({ label: "Dependency isolated", source: "TRACE", detail: `Failed ${primary.name} requests repeatedly traverse the downstream dependency ${dependency}.`, meta: `${primary.name} → ${dependency}${dependencyHits ? ` · ${dependencyHits} correlated span observations` : ""}` });
  }
  if (deploymentUnavailable) {
    score += 20;
    evidence.push(`Kubernetes Deployment ${dependency} is currently configured with 0 replicas.`);
    evidenceSteps.push({ label: "Workload state correlated", source: "KUBERNETES", detail: `${dependency} Deployment has no available replicas.`, meta: `Namespace: ${attr(dependencyDeployment!, "k8s.namespace.name") ?? "unknown"} · Desired: ${deploymentReplicas} · Ready: ${readyReplicas}` });
    if (dependencyService) evidenceSteps.push({ label: "Service impact confirmed", source: "KUBERNETES", detail: `${dependency} Service still exists while its backing Deployment has no replicas.`, meta: `${attr(dependencyService, "k8s.service.type") ?? "Service"} · ${attr(dependencyService, "k8s.service.cluster_ip") ?? "cluster IP unavailable"}` });
  } else if (unhealthyKube.length) {
    score += 20;
    evidence.push(`${unhealthyKube.length} unhealthy Kubernetes evidence records correlate with the affected path.`);
    evidenceSteps.push({ label: "Kubernetes instability correlated", source: "KUBERNETES", detail: `${unhealthyKube.length} unhealthy Kubernetes evidence records overlap the affected path.`, meta: pod ?? workload ?? "Affected workload" });
  } else if (relatedKube.length) {
    evidence.push(`Kubernetes state for the affected path is available, with no unhealthy state currently observed.`);
  }
  score = Math.min(100, score);
  const confidence = score >= 75 ? "High" : score >= 50 ? "Medium" : "Low";

  if (dependency) evidenceSteps.push({ label: "Working hypothesis", source: "CORRELATION", detail: deploymentUnavailable ? `${primary.name} degradation strongly correlates with ${dependency} workload unavailability.` : `${primary.name} failures correlate most strongly with downstream dependency ${dependency}.`, meta: `${confidence} confidence · ${score}%` });

  const summary = dependency && deploymentUnavailable
    ? `${primary.name} failures correlate with downstream dependency ${dependency}; Kubernetes shows deployment ${dependency} at 0 replicas.`
    : dependency && unhealthyKube.length
      ? `${primary.name} failures correlate with downstream dependency ${dependency}, with Kubernetes evidence on ${pod ?? workload ?? "the affected workload"}.`
      : dependency
        ? `${primary.name} failures correlate most strongly with downstream dependency ${dependency}.`
        : unhealthyKube.length
          ? `${primary.name} degradation overlaps Kubernetes instability on ${pod ?? workload ?? "the affected workload"}.`
          : `${primary.name} is degraded, but the current sample does not yet prove a downstream or Kubernetes root cause.`;

  const coverage = [
    { label: "Traces", detail: `${serviceFailures.length} failed traces`, present: serviceFailures.length > 0 },
    { label: "Metrics", detail: `${primary.errorRate.toFixed(1)}% errors · P95 ${(primary.p95 / 1000).toFixed(2)} s`, present: primary.errorRate >= 2 || primary.p95 >= 750 },
    { label: "Dependency", detail: dependency ? `${primary.name} → ${dependency}` : "Not isolated", present: Boolean(dependency) },
    { label: "Kubernetes", detail: deploymentUnavailable ? `${dependency} 0/${deploymentReplicas} available` : relatedKube.length ? `${relatedKube.length} related records` : "No current state", present: Boolean(dependencyDeployment || unhealthyKube.length) },
    { label: "Service state", detail: dependencyService ? `${dependency} Service observed` : "Not observed", present: Boolean(dependencyService) },
  ];

  return { score, confidence, affectedService: primary.name, dependency, pod, workload, summary, evidence, evidenceSteps, coverage };
}
