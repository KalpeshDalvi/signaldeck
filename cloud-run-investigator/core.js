import { createHash } from "node:crypto";

const VALID_NAME = /^[a-z0-9][a-z0-9.-]{0,251}$/;
const WINDOW_MS = 5 * 60_000;
export function validKubernetesName(value) {
  return typeof value === "string" && VALID_NAME.test(value);
}
export function replicaCount(request) {
  if (!request || typeof request !== "object") return null;
  const raw = request.spec?.replicas ?? request.replicas;
  const n = Number(raw);
  return (typeof raw === "number" || typeof raw === "string")
    && /^\d+$/.test(String(raw)) && Number.isSafeInteger(n) ? n : null;
}
export function summarizeGkeAudit(entry, deployment, namespace) {
  const p = entry?.protoPayload;
  const resource = `/namespaces/${namespace}/deployments/${deployment}/scale`;
  if (!p?.resourceName?.endsWith(resource) ||
      !String(p.methodName ?? "").includes("deployments.scale.") ||
      !Number.isFinite(Date.parse(entry.timestamp))) return null;
  const count = replicaCount(p.request);
  return {
    id: String(entry.insertId ?? createHash("sha256").update(JSON.stringify({
      at: entry.timestamp, resource: p.resourceName, method: p.methodName
    })).digest("hex")),
    timestamp: entry.timestamp,
    method: String(p.methodName),
    principal: String(p.authenticationInfo?.principalEmail ?? "Unknown"),
    resource: String(p.resourceName),
    replicas: count,
  };
}
export function analyzeScaleIncident({ incident, deployment, namespace, evidence, changes }) {
  const time = Date.parse(incident.incident_at);
  if (!Number.isFinite(time)) throw new Error("invalid_incident_time");
  const zeroSnapshot = evidence.some(e =>
    e.source_type === "k8s_event" && e.payload?.deployment === deployment &&
    e.payload?.namespace === namespace && Number(e.payload?.desired_replicas) === 0
  );
  const near = changes.filter(c =>
    Math.abs(Date.parse(c.timestamp) - time) <= WINDOW_MS
  ).sort((a,b) => Date.parse(a.timestamp)-Date.parse(b.timestamp));
  const zero = near.find(c => c.replicas === 0);
  const recovery = zero && near.find(c => c.replicas !== null &&
    c.replicas > 0 && Date.parse(c.timestamp) > Date.parse(zero.timestamp));
  if (!zero) return {
    level: zeroSnapshot ? "workload_state_observed" : "insufficient_evidence",
    initiating_change: null, initiating_actor: null,
    verified_mechanism: zeroSnapshot ? `${namespace}/${deployment} was observed with zero desired replicas` : null,
    hypothesis: zeroSnapshot ? "The Deployment had no desired serving pods; the initiating change remains unknown."
      : "Insufficient evidence to determine why the workload failed.",
    immediate_recovery: `Verify approved replica count and serving endpoints for ${namespace}/${deployment}.`,
    recurrence_prevention: null,
    verification_plan: "Verify ready pods, healthy Service endpoints, and representative application requests.",
    limitations: "No matching GKE scale-to-zero audit request was retrieved; do not infer an initiating identity."
  };
  return {
    level: zeroSnapshot ? "audit_and_workload_corroborated" : "audit_change_verified",
    // The operation is verified, but it may not establish the application failure cause.
    verified_mechanism: zeroSnapshot
      ? `Deployment ${namespace}/${deployment} observed with zero replicas; GKE audit recorded scale request to zero`
      : null,
    initiating_change: `${zero.method} requested replicas=0 on ${zero.resource} at ${zero.timestamp}`,
    initiating_actor: zero.principal === "Unknown" ? null : zero.principal,
    hypothesis: "The scale-to-zero action removed desired replicas. Application impact must be corroborated with dependency traces and exception logs.",
    immediate_recovery: `Restore ${namespace}/${deployment} to the reviewed replica count; verify pod readiness and Service endpoints.`,
    recurrence_prevention: `Review the origin of this scaling request, restrict critical Deployment scale permissions, and validate guardrails preventing unintended zero replicas. Allow explicit maintenance exceptions.`,
    verification_plan: "Confirm the Deployment meets approved replica minima, the Service has ready endpoints, and end-to-end requests succeed.",
    limitations: (zeroSnapshot
      ? "Kubernetes state and audit operation are corroborated. "
      : "Audit operation observed, but no matching zero-replica snapshot is archived. ") +
      "The actor's intent and application failure mechanism are not established by these sources." +
      (recovery ? ` Restoration was requested at ${recovery.timestamp} for ${recovery.replicas} replicas.` : ""),
  };
}
