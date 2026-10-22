import type { TelemetryRecord } from "./telemetry";
import type { ServiceSummary } from "./analytics";

export type EvidenceStep = { label: string; source: "TRACE" | "METRIC" | "KUBERNETES" | "CORRELATION"; detail: string; meta?: string };
export type AlternativeHypothesis = { label: string; likelihood: "Strong" | "Possible" | "Unlikely"; reasons: string[] };
export type ConfidenceFactor = { label: string; weight: number; direction: "supports" | "weakens"; explanation: string };
export type CausalLink = { from: string; to: string; relation: string; evidence: string };
export type CorrelationFinding = {
  score: number; confidence: "High" | "Medium" | "Low"; affectedService: string; dependency?: string; pod?: string; workload?: string;
  summary: string; evidence: string[]; evidenceSteps: EvidenceStep[]; coverage: { label: string; detail: string; present: boolean }[];
  failureDomain: string; failureMode: string; infrastructureState: string; blastRadius: string; primarySymptom: string; secondarySymptom: string;
  diagnosis: string; requestPath: string[]; alternatives: AlternativeHypothesis[]; confidenceFactors: ConfidenceFactor[]; causalLinks: CausalLink[];
  whyThisCause: string[]; whatWouldDisprove: string[];
};
function text(r: TelemetryRecord) { return `${r.service_name} ${r.message} ${JSON.stringify(r.attributes)}`.toLowerCase(); }
function isFailure(r: TelemetryRecord) { return (r.status_code ?? 0) >= 500 || r.severity?.toUpperCase() === "ERROR"; }
function attr(r: TelemetryRecord, ...keys: string[]) { for (const key of keys) { const v=r.attributes?.[key]; if(v!==undefined&&v!==null&&String(v)) return String(v); } return undefined; }
function downstreamTarget(r: TelemetryRecord) { const explicit=attr(r,"peer.service","server.address","net.peer.name","rpc.service"); if(explicit)return explicit.replace(/^https?:\/\//,"").split("/")[0]; const url=attr(r,"http.url","url.full"); if(url){try{return new URL(url).host}catch{return url.replace(/^https?:\/\//,"").split("/")[0]}} return Number(attr(r,"otel.span.kind")??0)===3?attr(r,"http.host"):undefined; }
function serviceNameFromTarget(target?:string){return target?.replace(/^https?:\/\//,"").split("/")[0].split(":")[0];}

export function correlateIncident(records:TelemetryRecord[],primary?:ServiceSummary):CorrelationFinding|null{
 if(!primary)return null;
 const traces=records.filter(r=>r.signal_type==="trace"),failures=traces.filter(isFailure),serviceFailures=failures.filter(r=>r.service_name===primary.name);
 const ids=new Set(serviceFailures.map(r=>r.trace_id).filter(Boolean)),relatedSpans=traces.filter(r=>r.trace_id&&ids.has(r.trace_id));
 const counts=new Map<string,number>(); for(const span of relatedSpans){if(!isFailure(span))continue;if(span.service_name!==primary.name)counts.set(span.service_name,(counts.get(span.service_name)??0)+1);const target=serviceNameFromTarget(downstreamTarget(span));if(target&&target!==primary.name)counts.set(target,(counts.get(target)??0)+1);}
 const dependency=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0],dependencyHits=dependency?counts.get(dependency)??0:0;
 // Kubernetes observations must overlap the failed requests. Historical state is not
 // proof that the same condition was present when this incident occurred.
 const failureTimes=serviceFailures.map(r=>Date.parse(r.observed_at)).filter(Number.isFinite);
 const overlapsFailure=(r:TelemetryRecord)=>failureTimes.some(t=>Math.abs(Date.parse(r.observed_at)-t)<=3*60_000);
 const kube=records.filter(r=>r.signal_type==="k8s_event"),terms=[primary.name,dependency].filter(Boolean) as string[];
 const relatedKube=kube.filter(r=>overlapsFailure(r)&&terms.some(t=>text(r).includes(t.toLowerCase())));
 // Prefer a zero-replica snapshot observed during failure over a later recovery snapshot.
 const dependencyDeployments=dependency?relatedKube.filter(r=>r.attributes["k8s.kind"]==="Deployment"&&String(r.attributes["k8s.deployment.name"]??r.service_name)===dependency):[];
 const dependencyDeployment=dependencyDeployments.find(r=>r.attributes["k8s.deployment.replicas"]!==undefined&&Number(r.attributes["k8s.deployment.replicas"])===0)??dependencyDeployments[0];
 const dependencyService=dependency?relatedKube.find(r=>r.attributes["k8s.kind"]==="Service"&&String(r.attributes["k8s.service.name"]??r.service_name)===dependency):undefined;
 const replicas=dependencyDeployment?Number(dependencyDeployment.attributes["k8s.deployment.replicas"]??NaN):NaN,ready=dependencyDeployment?Number(dependencyDeployment.attributes["k8s.deployment.ready_replicas"]??0):NaN;
 const deploymentUnavailable=Boolean(dependencyDeployment&&Number.isFinite(replicas)&&replicas===0);
 // Avoid mistaking a pod's historical last termination for its current condition.
 // Collapse repeated snapshots of the same unhealthy object/reason.
 const unhealthyEvents=relatedKube.filter(r=>{
   const kind=String(r.attributes["k8s.kind"]??"");
   const phase=attr(r,"k8s.pod.phase")??"";
   const waiting=attr(r,"k8s.container.waiting.reason")??"";
   const eventReason=attr(r,"k8s.event.reason")??"";
   const ready=r.attributes["k8s.pod.ready"];
   if(kind==="Event") return r.severity?.toUpperCase()==="ERROR";
   if(kind==="Pod") return phase==="Failed"||phase==="Pending"||Boolean(waiting)||((ready===false||ready==="false")&&phase==="Running");
   return false;
 });
 const uniqueUnhealthy=new Map<string,TelemetryRecord>();
 for(const r of unhealthyEvents){
   const key=[r.attributes["k8s.kind"],r.attributes["k8s.uid"]??r.attributes["k8s.object.name"]??r.service_name,r.attributes["k8s.event.reason"]??r.attributes["k8s.container.waiting.reason"]??r.attributes["k8s.pod.phase"]].join("|");
   if(!uniqueUnhealthy.has(key))uniqueUnhealthy.set(key,r);
 }
 const unhealthy=[...uniqueUnhealthy.values()];
 const strongest=dependencyDeployment??unhealthy[0]??relatedKube[0],pod=strongest?attr(strongest,"k8s.pod.name"):undefined,workload=dependencyDeployment?(attr(dependencyDeployment,"k8s.deployment.name")??dependency):(strongest?attr(strongest,"k8s.deployment.name","k8s.workload.name"):undefined);

 let score=20; const evidence:string[]=[],steps:EvidenceStep[]=[],factors:ConfidenceFactor[]=[];
 if(serviceFailures.length){score+=20;evidence.push(`${serviceFailures.length} failed traces observed for ${primary.name}.`);steps.push({label:"User-facing failure detected",source:"TRACE",detail:`${primary.name} is experiencing elevated request failures.`,meta:`${serviceFailures.length} failed traces · ${primary.errorRate.toFixed(1)}% error rate`});factors.push({label:"User impact reproduced",weight:20,direction:"supports",explanation:`${serviceFailures.length} failed ${primary.name} traces are present.`});}
 if(primary.errorRate>=2||primary.p95>=750){if(primary.errorRate>=2){score+=10;factors.push({label:"Error-rate breach",weight:10,direction:"supports",explanation:`${primary.errorRate.toFixed(1)}% of sampled requests fail.`});}if(primary.p95>=750){score+=10;factors.push({label:"Latency breach",weight:10,direction:"supports",explanation:`P95 is ${(primary.p95/1000).toFixed(2)} s.`});}steps.push({label:"Performance impact confirmed",source:"TRACE",detail:`${primary.name} P95 latency is ${(primary.p95/1000).toFixed(2)} s.`,meta:`${primary.errorRate.toFixed(1)}% errors · ${primary.status}`});}
 if(dependency){score+=20;steps.push({label:"Dependency isolated",source:"TRACE",detail:`Failed ${primary.name} requests repeatedly traverse downstream dependency ${dependency}.`,meta:`${primary.name} → ${dependency} · ${dependencyHits} correlated span observations`});factors.push({label:"Common failed dependency",weight:20,direction:"supports",explanation:`Failed traces repeatedly converge on ${dependency}.`});}
 if(deploymentUnavailable){score+=20;steps.push({label:"Workload state correlated",source:"KUBERNETES",detail:`${dependency} Deployment has no available replicas.`,meta:`Namespace: ${attr(dependencyDeployment!,"k8s.namespace.name")??"unknown"} · Desired: ${replicas} · Ready: ${ready}`});factors.push({label:"Independent infrastructure confirmation",weight:20,direction:"supports",explanation:`Kubernetes independently reports ${dependency} at ${replicas} desired / ${ready} ready replicas.`});if(dependencyService)steps.push({label:"Service exists without backends",source:"KUBERNETES",detail:`${dependency} Service still exists while its backing Deployment has no replicas.`,meta:`${attr(dependencyService,"k8s.service.type")??"Service"} · ${attr(dependencyService,"k8s.service.cluster_ip")??"cluster IP unavailable"}`});}
 else if(unhealthy.length){score+=20;factors.push({label:"Kubernetes evidence at failure time",weight:20,direction:"supports",explanation:`${unhealthy.length} distinct unhealthy Kubernetes object or event observations occurred near failed requests.`});}
 score=Math.min(100,score);const confidence=score>=75?"High":score>=50?"Medium":"Low";
 const summary=dependency&&deploymentUnavailable?`${primary.name} is impacted; evidence points downstream to ${dependency}, whose Kubernetes Deployment has no serving replicas.`:dependency?`${primary.name} is impacted; failed request paths point downstream to ${dependency}.`:`${primary.name} is degraded, but the failure domain is not yet isolated.`;
 const diagnosis=dependency&&deploymentUnavailable?`${primary.name} can receive traffic, but its required downstream dependency ${dependency} has no serving replicas. The Service can still resolve while having no workload instances capable of serving the call.`:dependency?`${primary.name} failures repeatedly traverse ${dependency}; the dependency path is isolated, but the exact infrastructure failure is not yet proven.`:`${primary.name} is degraded. More dependency or infrastructure evidence is required.`;
 if(dependency)steps.push({label:"Working diagnosis",source:"CORRELATION",detail:diagnosis,meta:`Heuristic ${Math.min(score,95)}/100 · root cause unverified`});
 const coverage=[{label:"Traces",detail:`${serviceFailures.length} failed traces`,present:serviceFailures.length>0},{label:"Trace statistics",detail:`Trace-derived ${primary.errorRate.toFixed(1)}% errors · P95 ${(primary.p95/1000).toFixed(2)} s`,present:primary.errorRate>=2||primary.p95>=750},{label:"Dependency",detail:dependency?`${primary.name} → ${dependency}`:"Not isolated",present:Boolean(dependency)},{label:"Kubernetes",detail:deploymentUnavailable?`${dependency} desired ${replicas} · ready ${ready}`:unhealthy.length?`${unhealthy.length} distinct incident-time anomalies`:"No proven unhealthy state",present:Boolean(deploymentUnavailable||unhealthy.length)},{label:"Service state",detail:dependencyService?`${dependency} Service observed`:"Not observed",present:Boolean(dependencyService)}];
 const failureDomain=dependency?"Downstream dependency":unhealthy.length?"Kubernetes workload":"Application / unknown",failureMode=deploymentUnavailable?"Dependency unavailable":unhealthy.length?"Workload instability suspected":"Unisolated degradation",infrastructureState=deploymentUnavailable?`${dependency} deployment observed at zero replicas near failure`:unhealthy.length?`${unhealthy.length} distinct unhealthy Kubernetes observations near failed requests`:"No decisive infrastructure failure observed";
 const alternatives:AlternativeHypothesis[]=[{label:`${primary.name} application/pod failure`,likelihood:dependency&&deploymentUnavailable?"Unlikely":"Possible",reasons:dependency&&deploymentUnavailable?[`Failed traces converge downstream on ${dependency}.`,`The dependency has stronger independent Kubernetes evidence.`]:["Local application symptoms exist, but local workload evidence is inconclusive."]},{label:"Network or DNS failure",likelihood:"Possible",reasons:["A dependency call is failing.","No direct DNS resolution, packet-loss, or connection-path evidence currently proves a network cause."]},{label:dependency?`${dependency} unavailability`:"Downstream dependency failure",likelihood:dependency&&deploymentUnavailable?"Strong":"Possible",reasons:dependency?[`Failed traces correlate ${primary.name} → ${dependency}.`,deploymentUnavailable?`${dependency} has ${replicas} desired and ${ready} ready replicas.`:"Kubernetes does not yet prove complete unavailability."]: ["No downstream dependency has been isolated."]}];
 const causalLinks:CausalLink[]=[];if(dependency){causalLinks.push({from:primary.name,to:dependency,relation:"calls",evidence:`${dependencyHits} failed-span observations`});if(deploymentUnavailable)causalLinks.push({from:dependency,to:"no serving replicas",relation:"backed by",evidence:`Deployment desired=${replicas}, ready=${ready}`});}
 const whyThisCause=[...(dependency?[`Failed user requests share the same downstream dependency: ${dependency}.`]:[]),...(deploymentUnavailable?[`Kubernetes independently confirms ${dependency} has no serving replicas.`]:[]),...(dependencyService&&deploymentUnavailable?[`${dependency} Service still exists, explaining why service discovery can succeed while requests cannot be served.`]:[]),`This remains a hypothesis; identifying a failed dependency does not establish the initiating configuration or code change.`];
 const whatWouldDisprove=dependency?[`${dependency} has healthy serving replicas while the same failures continue.`,`Failed traces stop traversing ${dependency} but ${primary.name} remains degraded.`,`A stronger common cause appears across failures, such as DNS, network, database, or ${primary.name} pod instability.`]:["A downstream dependency must first be isolated before this hypothesis can be tested."];
 return {score,confidence,affectedService:primary.name,dependency,pod,workload,summary,evidence,evidenceSteps:steps,coverage,failureDomain,failureMode,infrastructureState,blastRadius:primary.name,primarySymptom:`${primary.errorRate.toFixed(1)}% request errors`,secondarySymptom:`P95 ${(primary.p95/1000).toFixed(2)} s`,diagnosis,requestPath:[primary.name,...(dependency?[dependency]:[])],alternatives,confidenceFactors:factors,causalLinks,whyThisCause,whatWouldDisprove};
}
