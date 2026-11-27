import assert from "node:assert/strict";
import test from "node:test";
import type { ArchivedEvidence, ArchivedInvestigation } from "../investigation-archive";
import { investigationPostmortem } from "../investigation-postmortem";

const observed = "2026-11-27T02:00:00.000Z";
const record: ArchivedInvestigation = {
  id: "5ed98665-3431-4fd8-b0c8-7ed509c46b15",
  incident_key: "app:lab:checkout:1",
  incident_at: observed, created_at: observed, updated_at: observed,
  environment: "lab", impacted_service: "checkout",
  suspected_dependency: "inventory", status: "investigating",
  hypothesis: "Server span observed HTTP 500.",
  verified_mechanism: null, initiating_change: null, initiating_actor: null,
  immediate_recovery: null, recurrence_prevention: null, verification_plan: null,
  limitations: "Cause unverified.",
};
const evidence: ArchivedEvidence = {
  id: "evidence", source_type: "trace", source_event_id: "original-trace",
  source_event_at: observed, captured_at: observed, resource_name: "checkout",
  summary: "Failed checkout span\n## Hidden heading <script>",
  payload: { excerpt: "private raw details" },
};

test("postmortem retains confidence and the original source ID with Central timestamps", () => {
  const draft = investigationPostmortem(record, [evidence]);
  assert.match(draft, /^# Draft postmortem for checkout/);
  assert.match(draft, /Verified mechanism\*\* — Unverified/);
  assert.match(draft, /Initiating change\*\* — Unknown/);
  assert.match(draft, /Source ID original-trace/);
  assert.match(draft, /8:00:00 PM CST/);
  assert.ok(!draft.includes("\n## Hidden heading"));
  assert.ok(!draft.includes("<script>"));
  assert.ok(!draft.includes("private raw details"));
});
