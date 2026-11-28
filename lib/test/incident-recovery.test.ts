import assert from "node:assert/strict";
import test from "node:test";
import type { IncidentRecord } from "../incidents";
import type { ArchivedEvidence } from "../investigation-archive";
import { suggestIncidentRecovery, verifyRecoveryProbe } from "../incident-recovery";
import { investigateRootCause } from "../root-cause-investigation";
import type { TelemetryRecord } from "../telemetry";

const incident = {
  workspace_id: "fixture", service_name: "checkout", environment: "lab",
  status: "mitigated", mitigated_at: "2026-11-27T06:00:00.000Z",
} as IncidentRecord;
const failure: ArchivedEvidence = {
  id: "failure-row", source_type: "trace", source_event_id: "failed-source",
  resource_name: "checkout", source_event_at: "2026-11-27T05:54:00.000Z",
  captured_at: "2026-11-27T05:54:05.000Z", summary: "Failed checkout",
  payload: { span_kind: "2", status_code: 500, http_route: "/checkout", http_method: "POST", trace_id: "failed" },
};
const probe: TelemetryRecord = {
  workspace_id: "fixture", service_name: "checkout", environment: "lab",
  signal_type: "trace", message: "POST /checkout", status_code: 200, id: "probe-source",
  trace_id: "probe", span_id: "probe-span", observed_at: "2026-11-27T06:01:00.000Z",
  attributes: { "otel.span.kind": 2, "http.route": "/checkout", "http.request.method": "POST" },
};

test("records only a matching successful server span after mitigation", () => {
  assert.deepEqual(verifyRecoveryProbe(incident, "archive", [failure], [probe], "probe"), {
    investigation_id: "archive", failed_source_id: "failed-source", telemetry_source_id: "probe-source",
    trace_id: "probe", span_id: "probe-span", observed_at: probe.observed_at,
    mitigated_at: incident.mitigated_at, http_status: 200,
  });
  for (const incorrect of [
    { ...probe, workspace_id: "other" },
    { ...probe, environment: "different" },
    { ...probe, id: undefined },
    { ...probe, observed_at: incident.mitigated_at! },
    { ...probe, status_code: 503 },
    { ...probe, severity: "ERROR" },
    { ...probe, attributes: { ...probe.attributes, "http.route": "/health" } },
    { ...probe, attributes: { ...probe.attributes, "http.request.method": "GET" } },
    { ...probe, attributes: { ...probe.attributes, "otel.span.kind": 3 } },
  ]) assert.equal(verifyRecoveryProbe(incident, "archive", [failure], [incorrect], "probe"), null);
  assert.equal(verifyRecoveryProbe({ ...incident, status: "resolved" }, "archive", [failure], [probe], "probe"), null);
  assert.equal(verifyRecoveryProbe(incident, "archive", [], [probe], "probe"), null);
  assert.equal(verifyRecoveryProbe(incident, "archive",
    [{ ...failure, payload: { ...failure.payload, trace_id: "probe" } }], [probe], "probe"), null);
});

test("correlation rejects null replica counts and same-name observations in another environment", () => {
  const badRequest: TelemetryRecord = { ...probe, status_code: 500 };
  const snapshot: TelemetryRecord = {
    ...probe, id: "kube-source", signal_type: "k8s_event", service_name: "inventory",
    attributes: { "k8s.kind": "Deployment", "k8s.deployment.replicas": 0 },
  };
  const names = ["checkout", "inventory"];
  for (const unrelated of [
    { ...snapshot, workspace_id: "other" },
    { ...snapshot, environment: "other" },
    { ...snapshot, attributes: { ...snapshot.attributes, "k8s.deployment.replicas": null } },
  ]) assert.equal(investigateRootCause([badRequest, unrelated], names), null);
  const finding = investigateRootCause([badRequest, snapshot], names);
  assert.equal(finding?.source, "Kubernetes");
  assert.deepEqual(finding?.evidence.map(item => item.id), ["kube-source", "probe-source"]);
});

test("suggests dependency-specific checks only from a direct failed child", () => {
  const server = { ...failure, payload: { ...failure.payload, span_id: "server" } };
  const child: ArchivedEvidence = {
    ...failure, source_event_id: "client-source",
    payload: { span_kind: "3", trace_id: "failed", parent_span_id: "server", status_code: 503, peer_service: "inventory" },
  };
  const guidance = suggestIncidentRecovery([server, child], "checkout");
  assert.match(guidance?.recovery ?? "", /inventory/);
  assert.match(guidance?.validation ?? "", /POST \/checkout/);
  assert.deepEqual(guidance?.sourceIds, ["failed-source", "client-source"]);
  const unrelated = { ...child, payload: { ...child.payload, parent_span_id: "unrelated" } };
  assert.deepEqual(suggestIncidentRecovery([server, unrelated], "checkout")?.sourceIds, ["failed-source"]);
});
