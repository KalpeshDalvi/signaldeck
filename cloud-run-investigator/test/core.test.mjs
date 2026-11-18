import test from "node:test";
import assert from "node:assert/strict";
import {analyzeScaleIncident,replicaCount,summarizeGkeAudit} from "../core.js";

const incident={incident_at:"2026-11-17T13:00:00Z"};
const snapshot={source_type:"k8s_event",payload:{deployment:"inventory",namespace:"signaldeck-lab",desired_replicas:0}};
const audit={id:"abc",timestamp:"2026-11-17T12:59:50Z",
 method:"io.k8s.apps.v1.deployments.scale.patch",principal:"human@example.test",
 resource:"apps/v1/namespaces/signaldeck-lab/deployments/inventory/scale",replicas:0};
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
