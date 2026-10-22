import type { TelemetryRecord } from "./telemetry";

export type RootCauseInvestigation = {
  source: "Kubernetes" | "Application logs";
  cause: string;
  mechanism: string;
  recovery: string;
  permanentFix: string;
  prevention: string;
  validation: string;
  evidence: { id: string; time: string; service: string; message: string; traceId?: string }[];
  limitations: string;
};

const patterns = [
  {test:/remaining connection slots are reserved|too many connections|connection pool exhausted|sorry, too many clients/i,
   cause:"Database connection capacity exhausted",
   mechanism:"Database connections are exhausted. Determine whether replica count, connection-pool limits, or leaked connections drove usage beyond capacity.",
   recovery:"Inspect database connections and safely reduce connection pressure; avoid restarting all clients simultaneously.",
   permanentFix:"Set per-replica pool limits against a shared database connection budget; investigate leaked or long-lived connections.",
   prevention:"Alert on connection saturation and validate maximum replica count multiplied by pool size in load tests.",
   validation:"Verify connection count remains below the safe limit during peak traffic and database errors stop."},
  {test:/outofmemoryerror|oomkilled|cannot allocate memory|heap out of memory/i,
   cause:"Process memory exhaustion",
   mechanism:"The process exceeded available memory. A leak, traffic surge, memory limit, or oversized workload may be responsible; memory evidence is needed to distinguish them.",
   recovery:"Check memory usage and termination reason; restore service with a reviewed resource or traffic mitigation.",
   permanentFix:"Profile memory allocations and correct leaks or excessive buffering; right-size requests and limits based on measurements.",
   prevention:"Track working set and OOM restarts; run sustained load and memory regression tests.",
   validation:"Confirm stable memory usage and no OOM restarts under representative sustained load."},
  {test:/no such host|name or service not known|temporary failure in name resolution|nxdomain/i,
   cause:"Dependency DNS resolution failure",
   mechanism:"A dependency hostname cannot be resolved. Validate service name, DNS records, CoreDNS health, and namespace search paths.",
   recovery:"Check DNS resolution from the affected pod and verify the configured service hostname.",
   permanentFix:"Correct invalid hostnames or DNS configuration and resolve any demonstrated DNS service issue.",
   prevention:"Add dependency DNS probes and validate service names in deployment checks.",
   validation:"Verify resolution from affected workloads and recovery of downstream requests."},
  {test:/connection refused|econnrefused/i,
   cause:"Downstream TCP connection refused",
   mechanism:"The target endpoint rejected the connection. Determine whether the listener, Service endpoints, port, or routing configuration is incorrect.",
   recovery:"Inspect destination endpoints, listening ports, and workload readiness before changing traffic routing.",
   permanentFix:"Correct the demonstrated listener, Service selector, port, or readiness configuration.",
   prevention:"Add endpoint availability checks and pre-release connectivity tests.",
   validation:"Confirm healthy endpoints accept connections and the failing request path recovers."},
  {test:/permission denied|403 forbidden|accessdenied|unauthorizedexception/i,
   cause:"Authorization or permissions failure",
   mechanism:"The application was denied access. Identify the exact principal, resource, permission, and recent IAM or credential changes.",
   recovery:"Check the denied operation and principal; apply only an approved least-privilege correction.",
   permanentFix:"Correct the specific IAM binding, role, credential scope, or workload identity configuration.",
   prevention:"Test access with the deployment identity and detect unauthorized IAM drift.",
   validation:"Repeat the previously denied operation with the intended identity and confirm success."},
  {test:/certificate verify failed|x509: certificate|certificate has expired|tls handshake failure/i,
   cause:"TLS certificate or trust validation failure",
   mechanism:"The TLS handshake or certificate validation failed. Determine whether the certificate is expired, has a hostname mismatch, or uses an untrusted issuer.",
   recovery:"Inspect certificate validity, hostname, and chain without disabling TLS verification.",
   permanentFix:"Correct certificate issuance, trust-chain distribution, or hostname configuration.",
   prevention:"Monitor certificate expiration and test TLS handshakes before rollout.",
   validation:"Verify successful authenticated TLS connections with certificate validation enabled."}
];

export function investigateRootCause(records: TelemetryRecord[], serviceNames: string[]): RootCauseInvestigation | null {
  // A deployment snapshot during the failed request is stronger causal evidence
  // than a generic connection-refused error. Do not mistake current healthy
  // replicas after recovery for state at the time of the incident.
  const scope = new Set(serviceNames.filter(Boolean).map(s => s.toLowerCase()));
  const failedTraces = records.filter(r =>
    r.signal_type === "trace" &&
    scope.has(r.service_name.toLowerCase()) &&
    ((r.status_code ?? 0) >= 500 || r.severity?.toUpperCase() === "ERROR")
  );
  // Require a matching failed request close to the unhealthy Kubernetes state;
  // the oldest failure in a window may belong to a different incident.
  const scaledToZero = records
    .filter(r =>
      r.signal_type === "k8s_event" &&
      r.attributes["k8s.kind"] === "Deployment" &&
      Number(r.attributes["k8s.deployment.replicas"]) === 0 &&
      scope.has(String(r.attributes["k8s.deployment.name"] ?? r.service_name).toLowerCase()) &&
      failedTraces.some(f => Math.abs(Date.parse(f.observed_at) - Date.parse(r.observed_at)) <= 5 * 60_000)
    )
    .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
  if (scaledToZero.length > 0) {
    const k = scaledToZero[0];
    const workload = String(k.attributes["k8s.deployment.name"] ?? k.service_name);
    const failedTrace = [...failedTraces].sort((a,b) =>
      Math.abs(Date.parse(a.observed_at)-Date.parse(k.observed_at)) -
      Math.abs(Date.parse(b.observed_at)-Date.parse(k.observed_at))
    )[0];
    const evidence = [k, ...(failedTrace ? [failedTrace] : [])].map(r => ({
      id: r.id ?? r.span_id ?? r.observed_at,
      time: r.observed_at,
      service: r.service_name,
      message: r.signal_type === "trace"
        ? `Failed trace: ${r.message} (HTTP ${r.status_code ?? "unknown"})`
        : `${r.message}; desired replicas=${r.attributes["k8s.deployment.replicas"]}, ready replicas=${r.attributes["k8s.deployment.ready_replicas"] ?? "unknown"}`,
      traceId: r.trace_id
    }));
    return {
      source: "Kubernetes",
      cause: `${workload} Deployment configured for zero replicas`,
      mechanism: `A Kubernetes snapshot near the failed request shows ${workload} with desired replicas set to zero. The application dependency therefore had no pods available to serve requests. This proves the observed workload state, not who or what changed the replica count.`,
      recovery: `Restore ${workload} to the approved replica count, verify Service endpoints, and repeat the failed transaction.`,
      permanentFix: "Trace the scale-down to the owning actor or automation using Kubernetes audit logs, GitOps or deployment history, and autoscaler configuration. Correct the authorized source of the unwanted change.",
      prevention: "Enforce approved minimum availability for critical services through GitOps reviews, admission guardrails, and alerts on desired replicas becoming zero; ensure disaster-recovery workflows are exempted deliberately.",
      validation: "Confirm serving replicas and endpoints recover, failed requests succeed, and scale-down guardrails reject an unapproved zero-replica change.",
      evidence,
      limitations: "Kubernetes state near the failure supports a zero-replica causal mechanism. The initiating user, controller, or deployment action is not yet identified; audit or change evidence is required before claiming the organizational root cause."
    };
  }
  const names = new Set(serviceNames.filter(Boolean).map(s => s.toLowerCase()));
  const failureTraceIds = new Set(failedTraces.map(r => r.trace_id).filter(Boolean));
  const relevant = records.filter(r =>
    r.signal_type === "log" &&
    (names.has(r.service_name.toLowerCase()) || serviceNames.some(s => JSON.stringify(r.attributes).toLowerCase().includes(s.toLowerCase()))) &&
    (Boolean(r.trace_id && failureTraceIds.has(r.trace_id)) ||
      failedTraces.some(f => Math.abs(Date.parse(f.observed_at) - Date.parse(r.observed_at)) <= 5 * 60_000))
  );
  const hits = relevant.flatMap(r => {
    const rule = patterns.find(p => p.test.test(r.message));
    return rule ? [{r,rule}] : [];
  }).sort((a,b) => new Date(b.r.observed_at).getTime()-new Date(a.r.observed_at).getTime());
  if (!hits.length) return null;
  const selected = hits[0].rule;
  const evidence = hits.filter(h => h.rule === selected).slice(0,5).map(({r}) => ({
    id:r.id ?? r.span_id ?? r.observed_at,
    time:r.observed_at,
    service:r.service_name,
    message:r.message.slice(0,600),
    traceId:r.trace_id
  }));
  return {
    source:"Application logs",
    cause:selected.cause, mechanism:selected.mechanism, recovery:selected.recovery,
    permanentFix:selected.permanentFix, prevention:selected.prevention, validation:selected.validation,
    evidence, limitations:"Log evidence temporally or trace-correlated with failed requests supports this failure mechanism, but does not establish the originating configuration or code defect. Verify with metrics, changes, and targeted diagnostics before confirming root cause."
  };
}
