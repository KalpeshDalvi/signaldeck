import test from "node:test";
import assert from "node:assert/strict";
import {analyzeScaleIncident,auditLogResource,replicaCount,summarizeGkeAudit} from "../core.js";

const incident={incident_at:"2026-11-17T13:00:00Z"};
const snapshot={source_type:"k8s_event",payload:{deployment:"inventory",namespace:"signaldeck-lab",desired_replicas:0}};
const audit={id:"abc",timestamp:"2026-11-17T12:59:50Z",
 method:"io.k8s.apps.v1.deployments.scale.patch",principal:"human@example.test",
 resource:"apps/v1/namespaces/signaldeck-lab/deployments/inventory/scale",replicas:0};
test("scope audit reads to a configured log view in the job's project", () => {
  const suffix = "/locations/global/buckets/_Required/views/investigator-gke";
  const view = "projects/lab-project" + suffix;
  assert.equal(auditLogResource("lab-project", view), view);
  assert.equal(auditLogResource("lab-project"), "projects/lab-project");
  assert.throws(() => auditLogResource("lab-project", "projects/other-project" + suffix), /invalid_gcp_log_view/);
  assert.throws(() => auditLogResource("lab-project", "projects/lab-project"), /invalid_gcp_log_view/);
});
test("parse requested replicas without guessing",()=>{
 assert.equal(replicaCount({spec:{replicas:0}}),0);
 assert.equal(replicaCount({spec:{replicas:1}}),1);
 assert.equal(replicaCount({spec:{}}),null);
 assert.equal(replicaCount({spec:{replicas:-1}}),null);
 assert.equal(replicaCount({spec:{replicas:"not known"}}),null);
});
test("ignore unrelated resources and retain only workload scope",()=>{
 const entry={timestamp:audit.timestamp,insertId:"id",protoPayload:{methodName:audit.method,
  resourceName:audit.resource,request:{spec:{replicas:0}},
  authenticationInfo:{principalEmail:audit.principal}}};
 assert.equal(summarizeGkeAudit(entry,"checkout","signaldeck-lab"),null);
 assert.equal(summarizeGkeAudit(entry,"inventory","signaldeck-lab").replicas,0);
});
test("verify scale-down operation without inventing application causality",()=>{
 const r=analyzeScaleIncident({incident,deployment:"inventory",namespace:"signaldeck-lab",
   evidence:[snapshot],changes:[audit]});
 assert.equal(r.level,"audit_and_workload_corroborated");
 assert.match(r.initiating_change,/replicas=0/);
 assert.equal(r.initiating_actor,"human@example.test");
 assert.match(r.hypothesis,/Application impact must be corroborated/);
});
test("no audit: do not invent an actor or initiating change",()=>{
 const r=analyzeScaleIncident({incident,deployment:"inventory",namespace:"signaldeck-lab",
   evidence:[snapshot],changes:[]});
 assert.equal(r.initiating_actor,null);
 assert.equal(r.initiating_change,null);
 assert.match(r.limitations,/No matching GKE/);
});
test("unrelated audit times do not count as incident evidence",()=>{
 const old={...audit,timestamp:"2026-11-17T11:00:00Z"};
 const r=analyzeScaleIncident({incident,deployment:"inventory",namespace:"signaldeck-lab",
   evidence:[snapshot],changes:[old]});
 assert.equal(r.initiating_change,null);
});
test("document recovery separately",()=>{
 const rec={...audit,timestamp:"2026-11-17T13:01:00Z",replicas:1,id:"abc2"};
 const r=analyzeScaleIncident({incident,deployment:"inventory",namespace:"signaldeck-lab",
   evidence:[snapshot],changes:[audit,rec]});
 assert.match(r.limitations,/Restoration was requested/);
});

test("a denied request or a scale request after the snapshot cannot identify the initiator", () => {
  const denied = summarizeGkeAudit({
    timestamp: audit.timestamp, protoPayload: {
      methodName: audit.method, resourceName: audit.resource,
      request: {spec:{replicas:0}}, status: {code:7}
    }
  }, "inventory", "signaldeck-lab");
  const later = {...audit, timestamp:"2026-11-17T13:01:00Z"};
  const finding = analyzeScaleIncident({incident, deployment:"inventory",
    namespace:"signaldeck-lab", evidence:[snapshot], changes:[denied, later]});
  assert.equal(finding.initiating_change, null);
  assert.equal(finding.initiating_actor, null);
});

test("a restore before the snapshot supersedes the earlier scale-down", () => {
  const restore = {...audit, timestamp:"2026-11-17T12:59:55Z", replicas:1};
  const finding = analyzeScaleIncident({incident, deployment:"inventory",
    namespace:"signaldeck-lab", evidence:[snapshot], changes:[audit, restore]});
  assert.equal(finding.initiating_change, null);
});
