import pg from "pg";
import { GoogleAuth } from "google-auth-library";
import { analyzeScaleIncident, auditLogResource, summarizeGkeAudit, validKubernetesName } from "./core.js";
import { generateEvidenceBoundAnalysis } from "./ai-analyst.js";

const required = ["PGHOST","PGDATABASE","PGUSER","PGPASSWORD",
  "SIGNALDECK_WORKSPACE_ID","SIGNALDECK_GCP_PROJECT_ID","SIGNALDECK_GKE_CLUSTER"];
for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`);
const project = process.env.SIGNALDECK_GCP_PROJECT_ID;
const cluster = process.env.SIGNALDECK_GKE_CLUSTER;
const workspace = process.env.SIGNALDECK_WORKSPACE_ID;
const logView = process.env.SIGNALDECK_GCP_LOG_VIEW;
const loggingResource = auditLogResource(project, logView);
const MAX_ITEMS = 25;
const auth = new GoogleAuth({scopes:["https://www.googleapis.com/auth/logging.read"]});
const pool = new pg.Pool({
  host:process.env.PGHOST, database:process.env.PGDATABASE,
  user:process.env.PGUSER,password:process.env.PGPASSWORD,
  max:2,connectionTimeoutMillis:5000,statement_timeout:6000
});
const iso = ms => new Date(ms).toISOString();
async function auditChanges(deployment,namespace,at) {
  if (!validKubernetesName(deployment) || !validKubernetesName(namespace) ||
      !validKubernetesName(cluster)) throw new Error("invalid_scope");
  const base=Date.parse(at);
  const filter=[
    'resource.type="k8s_cluster"', 'protoPayload.serviceName="k8s.io"',
    `resource.labels.cluster_name="${cluster}"`,
    `protoPayload.resourceName:"namespaces/${namespace}/"`,
    `protoPayload.resourceName:"deployments/${deployment}"`,
    'protoPayload.methodName:"deployments.scale."',
    `timestamp>="${iso(base-300000)}"`,`timestamp<="${iso(base+300000)}"`
  ].join(" AND ");
  const token=await auth.getAccessToken();
  if (!token) throw new Error("missing_gcp_access_token");
  const response=await fetch("https://logging.googleapis.com/v2/entries:list",{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:JSON.stringify({resourceNames:[loggingResource],filter,
      pageSize:50,orderBy:"timestamp asc"}),
    signal:AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`gke_audit_http_${response.status}`);
  const data=await response.json();
  return (data.entries??[]).map(e=>summarizeGkeAudit(e,deployment,namespace))
    .filter(Boolean);
}
async function loadPending() {
  const {rows}=await pool.query(`
    SELECT i.id,i.workspace_id,i.incident_at,i.incident_key,i.environment,
           e.payload,e.source_event_at
    FROM public.investigations i
    JOIN LATERAL (
      SELECT payload,source_event_at
      FROM public.investigation_evidence e
      WHERE e.investigation_id=i.id AND e.workspace_id=i.workspace_id
        AND e.source_type='k8s_event' AND e.source_event_at IS NOT NULL
      ORDER BY e.source_event_at ASC LIMIT 1
    ) e ON TRUE
    WHERE i.workspace_id=$1 AND i.incident_key LIKE 'k8s:%'
      AND i.initiating_change IS NULL
      AND i.incident_at>=now()-INTERVAL '24 hours'
    ORDER BY i.incident_at DESC LIMIT $2
  `,[workspace,MAX_ITEMS]);
  return rows.filter(r=>
    validKubernetesName(r.payload?.namespace) &&
    validKubernetesName(r.payload?.deployment) &&
    r.payload?.desired_replicas===0);
}
async function saveFinding(row,changes) {
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const lock=await client.query(`
      SELECT id,incident_at FROM public.investigations
      WHERE id=$1 AND workspace_id=$2 AND initiating_change IS NULL
      FOR UPDATE
    `,[row.id,workspace]);
    if (!lock.rowCount) {await client.query("ROLLBACK");return false;}
    const found=await client.query(`
      SELECT source_type,payload,source_event_at
      FROM public.investigation_evidence
      WHERE investigation_id=$1 AND workspace_id=$2
      ORDER BY source_event_at ASC LIMIT 100
    `,[row.id,workspace]);
    const result=analyzeScaleIncident({
      incident:{incident_at:row.source_event_at},
      deployment:row.payload.deployment,
      namespace:row.payload.namespace,
      evidence:found.rows,changes
    });
    for(const change of changes) {
      // Scoped immutable audit snapshot. Do not archive the raw API payload,
      // which may contain credentials or sensitive resource metadata.
      await client.query(`
        INSERT INTO public.investigation_evidence(
          workspace_id,investigation_id,source_type,source_event_id,
          source_event_at,resource_name,summary,payload
        ) VALUES ($1,$2,'k8s_audit',$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT (investigation_id,source_type,source_event_id) DO NOTHING
      `,[workspace,row.id,change.id,change.timestamp,change.resource,
        `${change.method}: desired replicas ${change.replicas??"unrecorded"}`,
        JSON.stringify({method:change.method,principal:change.principal,
          requested_replicas:change.replicas,request_failed:change.failed,resource:change.resource})]);
    }
    await client.query(`
      UPDATE public.investigations
      SET hypothesis=$3,verified_mechanism=$4,initiating_change=$5,
          initiating_actor=$6,initiating_actor_type=$7,
          immediate_recovery=$8,recurrence_prevention=$9,
          verification_plan=$10,limitations=$11,updated_at=now()
      WHERE id=$1 AND workspace_id=$2
    `,[row.id,workspace,result.hypothesis,result.verified_mechanism,
      result.initiating_change,result.initiating_actor,
      result.initiating_actor?"google_cloud_identity":null,
      result.immediate_recovery,result.recurrence_prevention,
      result.verification_plan,result.limitations]);
    await client.query("COMMIT");
    return true;
  }catch(error){try{await client.query("ROLLBACK")}catch{}throw error}
  finally{client.release()}
}
const AI_ENABLED=process.env.SIGNALDECK_AI_ENABLED==="true";
async function analyzeApplicationIncidents() {
  if(!AI_ENABLED) return 0;
  const model=process.env.SIGNALDECK_VERTEX_MODEL;
  if(!model) throw new Error("SIGNALDECK_VERTEX_MODEL required when AI is enabled");
  const region=process.env.SIGNALDECK_VERTEX_REGION??"us-central1";
  // Strict per-execution quota. Never bill Vertex AI for all archived records.
  const pending=await pool.query(`
    SELECT id,incident_at,impacted_service,environment
    FROM public.investigations
    WHERE workspace_id=$1 AND incident_key LIKE 'app:%'
      AND verified_mechanism IS NULL
      AND hypothesis='Failure signal observed; underlying cause is not yet verified'
      AND incident_at >=now()-INTERVAL '24 hours'
    ORDER BY incident_at DESC LIMIT 2
  `,[workspace]);
  let completed=0;
  for(const incident of pending.rows) {
    const source=await pool.query(`
      SELECT source_type,source_event_id,source_event_at,resource_name,summary,payload
      FROM public.investigation_evidence
      WHERE workspace_id=$1 AND investigation_id=$2
      ORDER BY source_event_at ASC LIMIT 20
    `,[workspace,incident.id]);
    if(!source.rows.length)continue;
    const finding=await generateEvidenceBoundAnalysis({
      incident,evidence:source.rows,project,
      region,model
    });
    const limitation=`AI-assisted hypothesis only; root cause not independently verified. ${finding.uncertainties} Source IDs: ${finding.evidence_ids.join(", ")}`.slice(0,2400);
    await pool.query(`
      UPDATE public.investigations
      SET hypothesis=$3, immediate_recovery=$4,
          recurrence_prevention=$5,verification_plan=$6,
          limitations=$7,updated_at=now()
      WHERE workspace_id=$1 AND id=$2 AND verified_mechanism IS NULL
        AND hypothesis='Failure signal observed; underlying cause is not yet verified'
    `,[workspace,incident.id,`AI-assisted hypothesis: ${finding.hypothesis}. Observed mechanism: ${finding.failure_mechanism}`,
      finding.immediate_fix,finding.permanent_fix,finding.validation_steps.join("; "),limitation]);
    completed++;
  }
  return completed;
}
async function main() {
  let processed=0, enriched=0, withoutMatch=0;
  const items=await loadPending();
  for(const row of items){
    const changes=await auditChanges(row.payload.deployment,row.payload.namespace,row.source_event_at);
    processed++;
    if(changes.length) {
      if(await saveFinding(row,changes)) enriched++;
    } else withoutMatch++;
  }
  const aiFindings=await analyzeApplicationIncidents();
  console.log(JSON.stringify({event:"signaldeck_investigator_completed",
    checked:processed,archived:enriched,without_matching_audit:withoutMatch,ai_findings:aiFindings}));
}
async function checkRuntime([namespace, deployment, observedAt]) {
  if (!logView || !validKubernetesName(namespace) || !validKubernetesName(deployment) ||
      !Number.isFinite(Date.parse(observedAt))) throw new Error("invalid_runtime_check_scope");
  const pending = await loadPending();
  const changes = await auditChanges(deployment, namespace, observedAt);
  const beforeSnapshot = changes.filter(change => Date.parse(change.timestamp) <= Date.parse(observedAt));
  console.log(JSON.stringify({event:"signaldeck_investigator_check_completed",
    pending_workloads:pending.length, matching_audit_records:changes.length,
    successful_scale_to_zero_before_snapshot:beforeSnapshot.some(change => !change.failed && change.replicas === 0)}));
}
try {
  const args = process.argv.slice(2);
  if (args.length === 0) await main();
  else if (args[0] === "--check" && args.length === 4) await checkRuntime(args.slice(1));
  else throw new Error("usage: job.js [--check <namespace> <deployment> <observed-at>]");
}catch(error){
  console.error("signaldeck_investigator_failed",error?.message??"unknown");
  process.exitCode=1;
}finally{await pool.end()}
