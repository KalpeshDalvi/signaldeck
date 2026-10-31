import test from "node:test";
import assert from "node:assert/strict";
import { planArchive } from "../investigation-archive.js";

const NOW = Date.parse("2026-10-31T18:00:00.000Z");
const at = "2026-10-31T17:58:12.000Z";
const base = {
  workspace_id: "default",
  service_name: "checkout",
  environment: "lab",
  observed_at: at,
  attributes: {}
};

test("healthy traces do not generate investigations", () => {
  const planned = planArchive([{ ...base, signal_type: "trace", status_code: 200, severity: "INFO" }], NOW);
  assert.equal(planned.investigations.length, 0);
  assert.equal(planned.evidence.length, 0);
});

test("HTTP 500 captures an unverified application investigation and trace identifiers", () => {
  const planned = planArchive([
    { ...base, signal_type: "trace", status_code: 500, severity: "ERROR",
      trace_id: "t1", span_id: "s1", message: "POST /checkout", duration_ms: 5000 }
  ], NOW);
  assert.equal(planned.investigations.length, 1);
  assert.match(planned.investigations[0].key, /^app:lab:checkout:/);
  assert.equal(planned.evidence[0].payload.status_code, 500);
  assert.equal(planned.evidence[0].payload.trace_id, "t1");
});

test("same event replay produces stable evidence identity", () => {
  const record = { ...base, signal_type: "trace", status_code: 503,
    trace_id: "t2", span_id: "s2", message: "GET /dependency" };
  assert.equal(planArchive([record], NOW).evidence[0].sourceEventId,
    planArchive([record], NOW).evidence[0].sourceEventId);
});

test("severe logs are redacted, but INFO logs are ignored", () => {
  const records = [
    { ...base, signal_type: "log", severity: "INFO", message: "normal" },
    { ...base, signal_type: "log", severity: "ERROR",
      message: "token=abc123 Bearer abc123 password:unsafe" }
  ];
  const planned = planArchive(records, NOW);
  assert.equal(planned.evidence.length, 1);
  assert.doesNotMatch(planned.evidence[0].summary, /abc123|unsafe/);
  assert.doesNotMatch(planned.evidence[0].payload.excerpt, /abc123|unsafe/);
});

test("zero-desired-replica Deployment captures infrastructure state without inventing actor", () => {
  const planned = planArchive([{
    ...base, signal_type: "k8s_event", service_name: "inventory", severity: "INFO",
    attributes: {
      "k8s.kind": "Deployment", "k8s.namespace.name": "signaldeck-lab",
      "k8s.deployment.name": "inventory", "k8s.deployment.replicas": 0,
      "k8s.deployment.ready_replicas": 0,
      "k8s.uid": "uid1", "k8s.resource_version": "123"
    }
  }], NOW);
  assert.equal(planned.investigations.length, 1);
  assert.equal(planned.evidence[0].payload.desired_replicas, 0);
  assert.equal(planned.evidence[0].payload.ready_replicas, 0);
  assert.equal(planned.evidence[0].payload.initiating_actor, undefined);
});

test("stale/future and invalid service events are not auto-archived", () => {
  const records = [
    { ...base, signal_type: "trace", status_code: 500, observed_at: "2026-10-01T00:00:00Z" },
    { ...base, signal_type: "trace", status_code: 500, observed_at: "2026-10-31T19:00:00Z" },
    { ...base, signal_type: "trace", status_code: 500, service_name: "invalid name" }
  ];
  assert.equal(planArchive(records, NOW).evidence.length, 0);
});
