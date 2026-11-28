import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/AppShell";
import { formatDuration } from "@/lib/analytics";
import { correlateDeployments } from "@/lib/change-correlation";
import { ensureIncidents } from "@/lib/incidents";
import { listArchivedInvestigations } from "@/lib/investigation-archive";
import { clusterIncidentCandidates } from "@/lib/multi-incident";
import { readTelemetry } from "@/lib/telemetry";
import { formatCentralDateTime, formatCentralTime } from "@/lib/time";
import { workspaceId } from "@/lib/workspace";
import IncidentControls from "./IncidentControls";
import "./incidents.css";
export const dynamic="force-dynamic";
function isError(r:Awaited<ReturnType<typeof readTelemetry>>[number]){return (r.status_code??0)>=500||r.severity?.toUpperCase()==="ERROR"}

async function SavedInvestigationRows({ request }: { request: ReturnType<typeof listArchivedInvestigations> }) {
  const result = await request;
  if (result.status !== "ok" || !Array.isArray(result.data.investigations)) {
    return <p className="incident-archive-message">Saved investigations are currently unavailable.</p>;
  }
  if (!result.data.investigations.length) {
    return <p className="incident-archive-message">No saved investigations yet.</p>;
  }
  return <ul className="incident-archive-list">
    {result.data.investigations.map(item => <li key={item.id}>
      <Link className="incident-archive-entry" href={`/investigations/${item.id}`} prefetch={false}>
        <div>
          <strong>{item.impacted_service ?? "Unknown workload"}</strong>
          <span className="incident-archive-environment">{item.environment}</span>
          <p>
            {!item.verified_mechanism && item.hypothesis && <span className="incident-archive-label">Hypothesis</span>}
            {item.verified_mechanism ?? item.hypothesis ?? "Evidence captured"}
          </p>
        </div>
        <div className="incident-archive-meta">
          <span className="pill info">{item.status}</span>
          <time dateTime={item.incident_at}>{formatCentralDateTime(item.incident_at)}</time>
        </div>
      </Link>
    </li>)}
  </ul>;
}

export default async function IncidentsPage(){
 const savedInvestigations = listArchivedInvestigations(6);
 const records = await readTelemetry(500);
 const observedCandidates = clusterIncidentCandidates(records);
 const traces=records.filter(r=>r.signal_type==="trace"),errorTraces=traces.filter(isError).sort((a,b)=>new Date(b.observed_at).getTime()-new Date(a.observed_at).getTime()),errorLogs=records.filter(r=>r.signal_type==="log"&&isError(r)).sort((a,b)=>new Date(b.observed_at).getTime()-new Date(a.observed_at).getTime()),k8sEvents=records.filter(r=>r.signal_type==="k8s_event").sort((a,b)=>new Date(b.observed_at).getTime()-new Date(a.observed_at).getTime());
 const incidents = await ensureIncidents(observedCandidates.map(candidate => ({
   workspace_id: workspaceId(),
   title: `${candidate.service.name} ${candidate.service.environment} failure`,
   service_name: candidate.service.name,
   environment: candidate.service.environment,
   severity: candidate.service.status === "Critical" ? "SEV-1" : "SEV-2",
   summary: candidate.finding.summary,
   latest_signal_at: candidate.latestSignalAt,
 })));
 const tracked = observedCandidates.flatMap((candidate, index) =>
   incidents[index].status === "resolved" ? [] : [{ candidate, incident: incidents[index] }],
 );
 const candidates = tracked.map(item => item.candidate);
 const primary = candidates[0]?.service;
 const correlation = candidates[0]?.finding;
 const errorRate = traces.length ? (errorTraces.length / traces.length) * 100 : 0;
 const slowestFailure = errorTraces.reduce<(typeof errorTraces)[number] | undefined>((slowest, trace) => {
   if (!slowest || (trace.duration_ms ?? 0) > (slowest.duration_ms ?? 0)) return trace;
   return slowest;
 }, undefined);
 const incident=tracked[0]?.incident??null,deploymentEvidence=primary?correlateDeployments(records,primary.name,primary.environment):[],evidenceCount=errorTraces.length+errorLogs.length+k8sEvents.length+deploymentEvidence.length;
 const telemetryTimeline=[...errorTraces.slice(0,6).map(r=>({time:r.observed_at,type:"Failed trace",title:r.message,detail:`${r.service_name} · HTTP ${r.status_code??"error"} · ${formatDuration(r.duration_ms??0)}`,tone:"critical"})),...errorLogs.slice(0,4).map(r=>({time:r.observed_at,type:"Error log",title:r.message,detail:`${r.service_name} · ${r.environment}`,tone:"warning"})),...k8sEvents.slice(0,6).map(r=>({time:r.observed_at,type:"Kubernetes",title:r.message,detail:`${r.service_name} · ${String(r.attributes["k8s.pod.name"]??r.attributes["k8s.deployment.name"]??r.environment)}`,tone:"info"}))];
 const notes=(incident?.notes??[]).map(n=>({time:n.created_at,type:"Commander note",title:n.message,detail:`Added by ${n.author}`,tone:"note"})),timeline=[...telemetryTimeline,...notes].sort((a,b)=>new Date(b.time).getTime()-new Date(a.time).getTime()).slice(0,20);
 return <><PageHeader eyebrow="INCIDENT COMMAND" title={candidates.length>1?`${candidates.length} concurrent incidents`:incident?incident.title:"No active incident"} description="Independent failure groups, hypotheses, and operational response records."><Link className="incident-archive-view-all" href="/incidents/history" prefetch={false}>Incident history</Link>{incident?<><span className="pill warning">{candidates.length} active</span><span className="pill critical">{incident.severity}</span></>:<span className="pill info">No open group in sample</span>}</PageHeader>
 {candidates.length>0&&<article className="panel" style={{marginBottom:"18px"}}><div className="panel-title"><div><h2>Active incident groups</h2><p>Each group is isolated by impacted service and its correlated request path</p></div></div><div className="cluster-facts" style={{gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))"}}>{candidates.map((c,i)=><div key={c.key}><span>{i===0?"PRIMARY RESPONSE":"CONCURRENT INCIDENT"}</span><strong style={{display:"block",marginTop:"7px"}}><Link href={`/incidents/${tracked[i].incident.id}`} prefetch={false}>{c.service.name} · {c.service.status}</Link></strong><small style={{display:"block",marginTop:"7px"}}>{c.service.environment} · {c.service.errorRate.toFixed(1)}% errors · P95 {(c.service.p95/1000).toFixed(2)} s</small><small style={{display:"block",marginTop:"7px"}}>{c.finding.requestPath.join(" → ")} · {Math.min(c.finding.score,95)}% confidence</small><small style={{display:"block",marginTop:"7px"}}>{c.finding.failureMode}</small></div>)}</div></article>}
 <section className="incident-hero"><div><span className="incident-kicker">{incident?`Incident ${incident.id.slice(0,8)} · ${incident.status}`:"No active incident in the current sample"}</span><h2>{incident&&primary?`${primary.name} requires coordinated response`:"No immediate response required"}</h2><p>{incident?incident.summary:"Continue ingesting traces, logs and Kubernetes state to detect future incidents."}</p>{incident&&<div className="incident-meta"><span>Started {formatCentralDateTime(incident.started_at)}</span><span>Owner: {incident.owner??"Unassigned"}</span><span>{incident.environment}</span></div>}</div><div className="incident-score"><small>Evidence</small><strong>{evidenceCount}</strong><span>{candidates.length} independent group{candidates.length===1?"":"s"}</span></div></section>
 {incident&&<IncidentControls key={incident.id} incident={incident}/>}<div className="incident-metrics"><article><span>Active incidents</span><strong>{candidates.length}</strong><small>{candidates.map(c=>c.service.name).join(", ")||"None"}</small></article><article><span>Failed traces</span><strong>{errorTraces.length}</strong><small>{errorRate.toFixed(1)}% global sample error rate</small></article><article><span>Slowest failure</span><strong>{slowestFailure?formatDuration(slowestFailure.duration_ms??0):"—"}</strong><small>{slowestFailure?.service_name??"No failed trace"}</small></article><article><span>Primary correlation</span><strong>{correlation?`${Math.min(correlation.score,95)}%`:"—"}</strong><small>{correlation?`${correlation.affectedService} → ${correlation.dependency??"unknown"}`:"No finding"}</small></article></div>
 <section className="panel incident-archive" aria-labelledby="incident-archive-title">
   <div className="panel-title">
     <h2 id="incident-archive-title">Recent saved investigations</h2>
     <Link className="incident-archive-view-all" href="/investigations" prefetch={false} aria-label="View all saved investigations">View all</Link>
   </div>
   <Suspense fallback={<p className="incident-archive-message" role="status">Loading saved investigations…</p>}>
     <SavedInvestigationRows request={savedInvestigations} />
   </Suspense>
 </section>
 <div className="incident-layout"><article className="panel incident-timeline"><div className="panel-title"><div><h2>Investigation timeline</h2><p>Cross-signal evidence · US Central Time</p></div><span className="pill info">Live record</span></div>{timeline.length?timeline.map((x,i)=><div className="timeline-item" key={`${x.time}-${i}`}><div className={`timeline-marker ${x.tone}`}/><time dateTime={x.time}>{formatCentralTime(x.time)}</time><div><small>{x.type}</small><strong>{x.title}</strong><p>{x.detail}</p></div></div>):<div className="empty-state"><h2>No incident evidence yet</h2></div>}</article><aside className="incident-side"><article className="panel finding-card"><div className="panel-title"><div><h2>Primary finding</h2><p>The highest-ranked current incident candidate</p></div></div><strong>{correlation?.summary??"No current hypothesis"}</strong><ul><li>{primary?`${primary.name}: ${primary.errorRate.toFixed(1)}% errors, P95 ${formatDuration(primary.p95)}`:"No impacted service"}</li><li>{correlation?.dependency?`Suspected dependency: ${correlation.dependency}`:"Dependency not isolated"}</li><li>{correlation?.workload?`Workload: ${correlation.workload}`:"Workload not isolated"}</li></ul></article><article className="panel action-card"><div className="panel-title"><div><h2>Next actions</h2><p>Investigate the primary group without mixing concurrent evidence</p></div></div>{primary?<><Link className="response-action" href={`/services/${encodeURIComponent(primary.name)}?environment=${encodeURIComponent(primary.environment)}`}><span>1</span><div><strong>Inspect impacted service</strong><small>Review its isolated evidence</small></div></Link><Link className="response-action" href="/correlation"><span>2</span><div><strong>Compare incident candidates</strong><small>Keep hypotheses separated</small></div></Link><Link className="response-action" href="/kubernetes"><span>3</span><div><strong>Validate infrastructure</strong><small>Check serving state and events</small></div></Link></>:null}</article></aside></div></>;
}
