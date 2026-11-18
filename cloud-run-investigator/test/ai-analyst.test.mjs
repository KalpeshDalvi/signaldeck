import test from "node:test";
import assert from "node:assert/strict";
import { evidencePacket,validateAnalysis } from "../ai-analyst.js";

const evidence=[{
  source_event_id:"trace-1",source_type:"trace",
  source_event_at:"2026-11-17T13:00:00Z",resource_name:"checkout",
  summary:"GET /inventory timed out",
  payload:{trace_id:"aabb",status_code:500,peer_service:"inventory",
    http_route:"/inventory",other_untrusted_attribute:"authorization=secret"}
}];
const valid={
  hypothesis:"Inventory dependency failed during checkout.",
  failure_mechanism:"Checkout reported a failed inventory request.",
  immediate_fix:"Check inventory readiness and endpoints.",
  permanent_fix:"Investigate the triggering change and add readiness enforcement.",
  validation_steps:["Repeat checkout after restoring inventory."],
  uncertainties:"No change actor is shown in the trace alone.",
  evidence_ids:["trace-1"]
};
test("packet only includes allowlisted data and source references",()=>{
  const packet=evidencePacket(evidence);
  assert.equal(packet[0].id,"trace-1");
  assert.equal(packet[0].facts.peer_service,"inventory");
  assert.ok(!JSON.stringify(packet).includes("other_untrusted_attribute"));
  assert.ok(!JSON.stringify(packet).includes("authorization=secret"));
});
test("model must cite an actually supplied source",()=>{
  const packet=evidencePacket(evidence);
  assert.deepEqual(validateAnalysis(valid,packet).evidence_ids,["trace-1"]);
  assert.throws(()=>validateAnalysis({...valid,evidence_ids:["made-up"]},packet),
    /unsupported_ai_citation/);
  assert.throws(()=>validateAnalysis({...valid,evidence_ids:[]},packet),
    /unsupported_ai_citation/);
});
test("model must supply actionable checks and limited fields",()=>{
  const packet=evidencePacket(evidence);
  assert.throws(()=>validateAnalysis({...valid,validation_steps:[]},packet),
    /invalid_ai_validation_steps/);
  assert.throws(()=>validateAnalysis({...valid,hypothesis:""},packet),
    /invalid_ai_field_hypothesis/);
  const output=validateAnalysis({...valid,verified:true},packet);
  assert.equal("verified" in output,false,"LLM cannot auto-confirm root cause");
});
