import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INGESTION_KEY = process.env.SIGNALDECK_INGESTION_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !INGESTION_KEY) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SIGNALDECK_INGESTION_KEY");
  process.exit(1);
}

function json(res, status, body) {
  res.writeHead(status, {"content-type":"application/json"});
  res.end(JSON.stringify(body));
}

function anyValue(value) {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return value.intValue;
  if ("doubleValue" in value) return value.doubleValue;
  if ("boolValue" in value) return value.boolValue;
  if ("bytesValue" in value) return value.bytesValue;
  if (value.arrayValue?.values) return value.arrayValue.values.map(anyValue);
  if (value.kvlistValue?.values) return Object.fromEntries(value.kvlistValue.values.map((e) => [e.key, anyValue(e.value)]));
}

function attrs(list = []) { return Object.fromEntries(list.map((a) => [a.key, anyValue(a.value)])); }
function val(list, key) { return anyValue(list?.find((a) => a.key === key)?.value); }
function nanosToIso(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? new Date(n / 1_000_000).toISOString() : new Date().toISOString(); }
function ctx(resource) {
  const a = resource?.attributes || [];
  return {service:String(val(a,"service.name") ?? "unknown-service"), environment:String(val(a,"deployment.environment") ?? "unknown"), workspace:String(val(a,"signaldeck.workspace.id") ?? "default"), resourceAttributes:attrs(a)};
}
function httpStatus(a) { const raw = a["http.response.status_code"] ?? a["http.status_code"]; const n = Number(raw); return Number.isFinite(n) ? n : undefined; }

function k8sEvidence(body, context, log, scopeName) {
  if (!body || typeof body !== "object") return null;
  const envelope = body.object && typeof body.object === "object" ? body : undefined;
  const object = envelope?.object ?? body;
  if (!object?.kind || !object?.metadata) return null;
  const kind = String(object.kind), metadata = object.metadata || {}, namespace = String(metadata.namespace ?? "cluster"), name = String(metadata.name ?? "unknown");
  const attributes = {...context.resourceAttributes, ...attrs(log.attributes), scope:scopeName, "k8s.kind":kind, "k8s.object.name":name, "k8s.namespace.name":namespace, "k8s.uid":metadata.uid, "k8s.resource_version":metadata.resourceVersion};
  if (envelope?.type) attributes["k8s.watch.type"] = String(envelope.type);
  let message = `${kind} ${namespace}/${name} changed`, severity = "INFO", serviceName = name;
  if (kind === "Event") {
    const reason = object.reason ?? "Kubernetes event", note = object.note ?? object.message ?? "", regarding = object.regarding ?? object.involvedObject ?? {};
    serviceName = String(regarding.name ?? name); message = `${reason}${note ? `: ${note}` : ""}`; severity = String(object.type ?? "Normal").toLowerCase() === "warning" ? "ERROR" : "INFO";
    attributes["k8s.event.reason"] = reason; attributes["k8s.event.type"] = object.type ?? "Normal"; attributes["k8s.object.kind"] = regarding.kind; attributes["k8s.object.name"] = regarding.name ?? name;
  } else if (kind === "Pod") {
    const statuses = object.status?.containerStatuses ?? []; const restarts = statuses.reduce((s,x)=>s+Number(x.restartCount??0),0); const waiting = statuses.map(x=>x.state?.waiting?.reason).find(Boolean); const terminated = statuses.map(x=>x.lastState?.terminated?.reason ?? x.state?.terminated?.reason).find(Boolean); const reason = waiting ?? terminated ?? object.status?.reason; const phase = object.status?.phase ?? "Unknown";
    message = `Pod ${name} is ${phase}${reason ? ` (${reason})` : ""}`; severity = phase === "Failed" || waiting === "CrashLoopBackOff" || terminated === "OOMKilled" ? "ERROR" : "INFO";
    attributes["k8s.pod.name"] = name; attributes["k8s.pod.phase"] = phase; attributes["k8s.pod.restart_count"] = restarts; attributes["k8s.pod.reason"] = reason; attributes["k8s.node.name"] = object.spec?.nodeName; attributes["k8s.pod.ip"] = object.status?.podIP; attributes["k8s.workload.name"] = metadata.labels?.["app.kubernetes.io/name"] ?? metadata.labels?.app;
  } else if (kind === "Deployment") {
    serviceName = String(metadata.labels?.["app.kubernetes.io/name"] ?? metadata.labels?.app ?? name); const desired = object.spec?.replicas ?? 0, ready = object.status?.readyReplicas ?? 0; message = `Deployment ${name} observed: ${ready}/${desired} ready`; severity = Number(ready) < Number(desired) ? "WARN" : "INFO";
    attributes["k8s.deployment.name"] = name; attributes["k8s.deployment.replicas"] = desired; attributes["k8s.deployment.ready_replicas"] = ready; attributes["k8s.deployment.updated_replicas"] = object.status?.updatedReplicas ?? 0; attributes["k8s.container.images"] = (object.spec?.template?.spec?.containers ?? []).map(c=>c.image).filter(Boolean);
  } else if (kind === "Service") {
    const type = String(object.spec?.type ?? "ClusterIP"), clusterIp = object.spec?.clusterIP ?? object.spec?.clusterIp; serviceName = name; message = `Service ${namespace}/${name} observed: ${type}${clusterIp ? ` ${clusterIp}` : ""}`;
    attributes["k8s.service.name"] = name; attributes["k8s.service.type"] = type; attributes["k8s.service.cluster_ip"] = clusterIp; attributes["k8s.service.selector"] = object.spec?.selector ?? {};
  }
  return {workspace_id:context.workspace, signal_type:"k8s_event", service_name:serviceName, environment:context.environment, severity, message, attributes, observed_at:nanosToIso(log.timeUnixNano ?? log.observedTimeUnixNano)};
}

function normalizeLogs(payload) {
  const out=[]; for (const rl of payload.resourceLogs ?? []) { const c=ctx(rl.resource); for (const sl of rl.scopeLogs ?? []) for (const log of sl.logRecords ?? []) { const body=anyValue(log.body); const k=k8sEvidence(body,c,log,sl.scope?.name); if (k) out.push(k); else out.push({workspace_id:c.workspace,signal_type:"log",service_name:c.service,environment:c.environment,severity:log.severityText??"INFO",message:typeof body==="string"?body:JSON.stringify(body??""),trace_id:log.traceId,span_id:log.spanId,attributes:{...c.resourceAttributes,...attrs(log.attributes),scope:sl.scope?.name},observed_at:nanosToIso(log.timeUnixNano??log.observedTimeUnixNano)}); } } return out;
}
function normalizeTraces(payload) {
  const out=[]; for (const rs of payload.resourceSpans ?? []) { const c=ctx(rs.resource); for (const ss of rs.scopeSpans ?? []) for (const span of ss.spans ?? []) { const a=attrs(span.attributes), status=httpStatus(a), start=Number(span.startTimeUnixNano??0), end=Number(span.endTimeUnixNano??start); out.push({workspace_id:c.workspace,signal_type:"trace",service_name:c.service,environment:c.environment,severity:span.status?.code===2 || status>=500?"ERROR":"INFO",message:span.name??"unnamed span",trace_id:span.traceId,span_id:span.spanId,parent_span_id:span.parentSpanId||undefined,duration_ms:Math.max(0,(end-start)/1_000_000),status_code:status,attributes:{...c.resourceAttributes,...a,scope:ss.scope?.name,"otel.span.kind":span.kind,"otel.status.code":span.status?.code},observed_at:nanosToIso(span.startTimeUnixNano)}); } } return out;
}
function normalizeMetrics(payload) {
  const out=[]; for (const rm of payload.resourceMetrics ?? []) { const c=ctx(rm.resource); for (const sm of rm.scopeMetrics ?? []) for (const metric of sm.metrics ?? []) { const points=metric.gauge?.dataPoints ?? metric.sum?.dataPoints ?? metric.histogram?.dataPoints ?? []; for (const p of points) out.push({workspace_id:c.workspace,signal_type:"metric",service_name:c.service,environment:c.environment,message:metric.name??"unnamed metric",attributes:{...c.resourceAttributes,...attrs(p.attributes),unit:metric.unit,value:p.asDouble??p.asInt??p.sum??p.count},observed_at:nanosToIso(p.timeUnixNano)}); } } return out;
}

async function save(records) {
  if (!records.length) return;
  const normalized = records.map(r=>({...r,severity:r.severity??null,trace_id:r.trace_id??null,span_id:r.span_id??null,parent_span_id:r.parent_span_id??null,duration_ms:r.duration_ms??null,status_code:r.status_code??null,attributes:r.attributes??{}}));
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/telemetry_events`, {method:"POST",headers:{apikey:SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,"content-type":"application/json",Prefer:"return=minimal"},body:JSON.stringify(normalized)});
  if (!resp.ok) throw new Error(`Supabase insert failed: ${resp.status} ${await resp.text()}`);
}

async function readBody(req) { const chunks=[]; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8"); }

const server = http.createServer(async (req,res)=>{
  try {
    if (req.method === "GET" && req.url === "/healthz") return json(res,200,{status:"ok"});
    if (req.method !== "POST") return json(res,405,{error:"method_not_allowed"});
    if (req.headers.authorization !== `Bearer ${INGESTION_KEY}`) return json(res,401,{error:"unauthorized"});
    const bodyText = await readBody(req); const payload = bodyText ? JSON.parse(bodyText) : {};
    let records;
    if (req.url === "/v1/traces" || req.url === "/api/otel/v1/traces") records = normalizeTraces(payload);
    else if (req.url === "/v1/logs" || req.url === "/api/otel/v1/logs") records = normalizeLogs(payload);
    else if (req.url === "/v1/metrics" || req.url === "/api/otel/v1/metrics") records = normalizeMetrics(payload);
    else return json(res,404,{error:"not_found"});
    await save(records);
    return json(res,202,{backend:"supabase",accepted:records.length});
  } catch (err) {
    console.error(err);
    return json(res,400,{error:"ingest_failed",message:String(err?.message ?? err)});
  }
});
server.listen(PORT,()=>console.log(`SignalDeck ingest listening on ${PORT}`));
