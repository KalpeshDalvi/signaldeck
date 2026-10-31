import { createHash } from "node:crypto";

// Automatic capture is deliberately conservative: record observed failures,
// never infer a confirmed root cause or ingest arbitrary log attributes.
const MAX_INCIDENTS_PER_BATCH = 500;
const MAX_EVIDENCE_PER_BATCH = 500;
const BUCKET_MS = 5 * 60 * 1000;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_LABEL = /^[a-zA-Z0-9_.:-]{1,128}$/;

function safeText(value, max = 400) {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, max);
}
function bucket(time) {
  return Math.floor(time / BUCKET_MS);
}
function stableId(parts) {
  return createHash("sha256").update(parts.map(p => String(p ?? "")).join("|")).digest("hex");
}
function incidentDescriptor(record, now) {
  const observed = Date.parse(record.observed_at);
  if (!Number.isFinite(observed) || observed < now - MAX_EVENT_AGE_MS || observed > now + 60_000) return null;
  const service = String(record.service_name ?? "");
  const environment = String(record.environment ?? "unknown");
  if (!SAFE_LABEL.test(service) || !SAFE_LABEL.test(environment)) return null;
  const attrs = record.attributes ?? {};
  const signal = record.signal_type;
  let key, kind, summary, sourceType, payload;
  if (signal === "trace" && (
    Number(record.status_code) >= 500 || String(record.severity).toUpperCase() === "ERROR"
  )) {
    kind = "application_failure";
    key = `app:${environment}:${service}:${bucket(observed)}`;
    summary = `Failed trace: ${safeText(record.message)} (${record.status_code ?? "OTel error"})`;
    sourceType = "trace";
    payload = {
      trace_id: safeText(record.trace_id, 100), span_id: safeText(record.span_id, 100),
      parent_span_id: safeText(record.parent_span_id, 100),
      status_code: record.status_code ?? null, duration_ms: record.duration_ms ?? null,
      observed_at: record.observed_at
    };
  } else if (signal === "log" && ["ERROR","FATAL","CRITICAL"].includes(String(record.severity).toUpperCase())) {
    kind = "application_failure";
    key = `app:${environment}:${service}:${bucket(observed)}`;
    summary = `Error log: ${safeText(record.message)}`;
    sourceType = "application_log";
    payload = { trace_id: safeText(record.trace_id, 100), span_id: safeText(record.span_id, 100),
      severity: record.severity ?? "ERROR", excerpt: safeText(record.message, 600) };
  } else if (signal === "k8s_event" && attrs["k8s.kind"] === "Deployment" &&
    Number(attrs["k8s.deployment.replicas"]) === 0) {
    const deployment = String(attrs["k8s.deployment.name"] ?? service);
    const namespace = String(attrs["k8s.namespace.name"] ?? "unknown");
    if (!SAFE_LABEL.test(deployment) || !SAFE_LABEL.test(namespace)) return null;
    kind = "kubernetes_unavailable";
    key = `k8s:${environment}:${namespace}:${deployment}:${bucket(observed)}`;
    summary = `Deployment ${namespace}/${deployment} observed with 0 desired replicas`;
    sourceType = "k8s_event";
    payload = {
      namespace, deployment, desired_replicas: 0,
      ready_replicas: Number(attrs["k8s.deployment.ready_replicas"] ?? 0),
      resource_version: safeText(attrs["k8s.resource_version"], 100),
      uid: safeText(attrs["k8s.uid"], 100)
    };
  } else if (signal === "k8s_event" && attrs["k8s.kind"] === "Event" &&
    String(record.severity).toUpperCase() === "ERROR") {
    const namespace = String(attrs["k8s.namespace.name"] ?? "unknown");
    if (!SAFE_LABEL.test(namespace)) return null;
    kind = "kubernetes_warning";
    key = `event:${environment}:${namespace}:${service}:${bucket(observed)}`;
    summary = `Kubernetes warning: ${safeText(record.message)}`;
    sourceType = "k8s_event";
    payload = { namespace, reason: safeText(attrs["k8s.event.reason"], 120),
      uid: safeText(attrs["k8s.uid"], 100), resource_version: safeText(attrs["k8s.resource_version"], 100) };
  } else {
    return null;
  }
  // Same event on retry must produce the same source identifier.
  const sourceEventId = stableId([sourceType, service, record.trace_id,
    record.span_id, attrs["k8s.uid"], attrs["k8s.resource_version"], record.observed_at, summary]);
  return {
    key, kind, service, environment, observedAt: record.observed_at,
    sourceType, sourceEventId, summary: safeText(summary, 500),
    payload, resourceName: safeText(attrs["k8s.object.name"] ?? service, 128)
  };
}

export function planArchive(records, now = Date.now()) {
  const investigations = new Map();
  const evidence = [];
  let omitted = 0;
  for (const record of records) {
    const item = incidentDescriptor(record, now);
    if (!item) continue;
    if (!investigations.has(item.key)) {
      if (investigations.size >= MAX_INCIDENTS_PER_BATCH) { omitted++; continue; }
      investigations.set(item.key, item);
    }
    if (evidence.length >= MAX_EVIDENCE_PER_BATCH) { omitted++; continue; }
    evidence.push(item);
  }
  return { investigations: [...investigations.values()], evidence, omitted };
}

export async function archiveBatch(client, records, workspaceId) {
  const plan = planArchive(records);
  if (!plan.investigations.length) return { captured: 0, investigations: 0, omitted: 0 };
  // One batch UPSERT, not one query per incident. Keep the hot OTLP path
  // bounded even if all 500 records are distinct failures.
  const incidentParams = [];
  const incidentPlaceholders = [];
  let incidentParamIndex = 1;
  for (const item of plan.investigations) {
    incidentParams.push(
      workspaceId, item.key, item.observedAt, item.environment, item.service,
      item.kind === "kubernetes_unavailable"
        ? "Deployment observed with zero desired replicas; initiator unknown"
        : "Failure signal observed; underlying cause is not yet verified",
      "Automatic capture preserves observed evidence only. The originating cause is not independently established."
    );
    incidentPlaceholders.push("(" + Array.from({length:7}, () => "$" + incidentParamIndex++).join(",") + ")");
  }
  const saved = await client.query(
    `INSERT INTO public.investigations (
      workspace_id,incident_key,incident_at,environment,impacted_service,hypothesis,limitations
    ) VALUES ${incidentPlaceholders.join(",")}
    ON CONFLICT (workspace_id,incident_key)
      DO UPDATE SET updated_at = now()
    RETURNING id,incident_key`,
    incidentParams
  );
  const idByKey = new Map(saved.rows.map(row => [row.incident_key, row.id]));
  const fields = [];
  const placeholders = [];
  let idx = 1;
  for (const item of plan.evidence) {
    const id = idByKey.get(item.key);
    if (!id) continue;
    fields.push(workspaceId, id, item.sourceType, item.sourceEventId,
      item.observedAt, item.resourceName, item.summary, JSON.stringify(item.payload));
    placeholders.push("(" + Array.from({length:8}, () => "$" + idx++).join(",") + ")");
  }
  if (placeholders.length) {
    await client.query(
      `INSERT INTO public.investigation_evidence
       (workspace_id, investigation_id, source_type, source_event_id,
        source_event_at, resource_name, summary, payload)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (investigation_id, source_type, source_event_id) DO NOTHING`,
      fields
    );
  }
  return { captured: placeholders.length, investigations: plan.investigations.length, omitted: plan.omitted };
}
