import test from "node:test";
import assert from "node:assert/strict";
import { evidencePacket, generateEvidenceBoundAnalysis, validateAnalysis } from "../ai-analyst.js";
import { runSyntheticTrial } from "../ai-trial.js";

const incident = {
  impacted_service: "private-service-name",
  environment: "private-environment",
  incident_at: "2026-11-17T13:00:00Z",
};
const trace = {
  source_type: "trace",
  source_event_id: "private-original-source-id",
  source_event_at: "2026-11-17T13:00:00.100Z",
  resource_name: incident.impacted_service,
  summary: "private-summary",
  payload: {
    trace_id: "private-trace-id", span_id: "private-span-id", parent_span_id: "private-parent-id",
    span_kind: "3", status_code: 503, duration_ms: 250, peer_service: "private-peer-name",
    http_route: "private-route", excerpt: "private-excerpt", other_attribute: "private-attribute",
  },
};
const validAnalysis = {
  observations: [{ claim: "dependency_response", evidence_id: "E1" }],
  immediate_fix: "Inspect readiness and endpoint membership.",
  permanent_fix: "Confirm the failure mode before choosing a prevention measure.",
  validation_steps: ["Compare one successful request with the failed request."],
};
const model = { project: "test-project", region: "us-central1", model: "fixture-model" };

test("model input contains bounded facts and trace relationships without original identifiers or text", () => {
  const { input, sourceIds } = evidencePacket(incident, [
    { ...trace, source_type: "operator_note" },
    trace,
    { ...trace, source_event_id: "second-private-id", resource_name: trace.payload.peer_service,
      payload: { trace_id: trace.payload.trace_id, span_id: trace.payload.parent_span_id,
        status_code: { extra: "private-data-in-object" }, duration_ms: "private-duration" } },
  ]);
  assert.ok(!JSON.stringify(input).includes("private-"));
  assert.equal(input.service, "S1");
  assert.deepEqual(input.evidence[0].facts, {
    kind: "CLIENT", status_code: 503, duration_ms: 250, peer_service: "S2",
    parent_span: input.evidence[1].span,
  });
  assert.equal(input.evidence[0].trace, input.evidence[1].trace);
  assert.equal(input.evidence[0].offset_ms, 100);
  assert.equal(input.evidence[1].service, "S2");
  assert.equal(input.evidence[1].facts.status_code, null);
  assert.equal(input.evidence[1].facts.duration_ms, null);
  assert.deepEqual([...sourceIds], [["E1", trace.source_event_id], ["E2", "second-private-id"]]);
});

test("packet limit applies to qualifying rows and excludes malformed evidence IDs", () => {
  const { input } = evidencePacket(incident, [
    { ...trace, source_event_id: " " },
    ...Array.from({ length: 30 }, (_, index) => ({ ...trace, source_event_id: `trace-${index}` })),
  ]);
  assert.equal(input.evidence.length, 16);
  assert.equal(input.evidence.at(-1).id, "E16");
});

test("each saved observation is rendered from its cited source", () => {
  const packet = evidencePacket(incident, [trace]);
  const result = validateAnalysis({
    ...validAnalysis,
    observations: [{ ...validAnalysis.observations[0], statement: "Invented causal claim" }],
    verified: true,
  }, packet);
  assert.deepEqual(result.observations, [{
    claim: "dependency_response",
    statement: "The dependency client span recorded HTTP 503.",
    evidence_ids: [trace.source_event_id],
  }]);
  assert.deepEqual(result.evidence_ids, [trace.source_event_id]);
  assert.equal("verified" in result, false);
  for (const evidence_id of ["invented", trace.source_event_id]) {
    assert.throws(() => validateAnalysis({
      ...validAnalysis, observations: [{ claim: "dependency_response", evidence_id }],
    }, packet), /unsupported_ai_citation/);
  }
  assert.throws(() => validateAnalysis({ ...validAnalysis, observations: [] }, packet), /invalid_ai_observations/);
  assert.throws(() => validateAnalysis({ ...validAnalysis, validation_steps: [" "] }, packet), /invalid_ai_validation_steps/);
  assert.throws(() => validateAnalysis({ ...validAnalysis, immediate_fix: "" }, packet), /invalid_ai_field_immediate_fix/);
  assert.throws(() => validateAnalysis({
    ...validAnalysis, observations: [{ claim: "response_handling", evidence_id: "E1" }],
  }, packet), /unsupported_ai_claim/);
});

test("response handling requires a matching log, parent span and dependency span", () => {
  const server = {
    ...trace, source_event_id: "original-server", source_event_at: incident.incident_at,
    payload: { ...trace.payload, span_kind: "SPAN_KIND_SERVER", span_id: "private-server",
      duration_ms: 820, status_code: 500 },
  };
  const log = {
    ...trace, source_type: "application_log", source_event_id: "original-log",
    source_event_at: "2026-11-17T13:00:00.795Z",
    payload: { trace_id: trace.payload.trace_id, span_id: server.payload.span_id, severity: "ERROR",
      response_handling: { dependency_status_code: 503, response_status_code: 500 },
      excerpt: "private-untrusted-message" },
  };
  const client = {
    ...trace, payload: { ...trace.payload, parent_span_id: server.payload.span_id, duration_ms: 660 },
  };
  const packet = evidencePacket(incident, [server, client, log]);
  assert.equal(packet.input.evidence[2].available_claim, "response_handling");
  assert.ok(!JSON.stringify(packet.input).includes("private-"));
  const response = { ...validAnalysis, observations: [{ claim: "response_handling", evidence_id: "E3" }] };
  const finding = validateAnalysis(response, packet);
  assert.deepEqual(finding.observations[0].evidence_ids, [log.source_event_id, server.source_event_id, client.source_event_id]);
  assert.match(finding.observations[0].statement, /HTTP 503 to HTTP 500/);

  for (const badLog of [
    { ...log, source_event_at: "2026-11-17T13:00:00.200Z" },
    { ...log, payload: { ...log.payload, trace_id: "another-trace" } },
    { ...log, payload: { ...log.payload, response_handling: { dependency_status_code: 502, response_status_code: 500 } } },
  ]) {
    const uncorroborated = evidencePacket(incident, [server, client, badLog]);
    assert.equal(uncorroborated.input.evidence[2].available_claim, "application_error");
    assert.throws(() => validateAnalysis(response, uncorroborated), /unsupported_ai_claim/);
  }
});

test("synthetic trial makes one structured model request and maps both references", async () => {
  let requests = 0;
  const analysis = await runSyntheticTrial({ ...model, region: "us" }, {
    getAccessToken: async () => "fixture-only-token",
    request: async (url, options) => {
      requests++;
      assert.equal(new URL(url).hostname, "aiplatform.us.rep.googleapis.com");
      assert.match(new URL(url).pathname, /\/locations\/us\//);
      assert.equal(options.method, "POST");
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.candidateCount, 1);
      assert.equal(body.generationConfig.maxOutputTokens, 950);
      assert.equal(body.generationConfig.responseSchema.type, "OBJECT");
      const input = JSON.parse(body.contents[0].parts[0].text);
      assert.equal(input.evidence.length, 2);
      assert.equal(input.evidence[0].span, input.evidence[1].facts.parent_span);
      assert.ok(!options.body.includes("trial-checkout") && !options.body.includes("trial-inventory"));
      return Response.json({ candidates: [{ finishReason: "STOP", content: {
        parts: [{ text: JSON.stringify({ ...validAnalysis, observations: [
          { claim: "server_response", evidence_id: "E1" },
          { claim: "dependency_response", evidence_id: "E2" },
        ] }) }],
      } }] });
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(analysis.evidence_ids, ["trial-checkout-trace", "trial-dependency-trace"]);
});

test("no qualifying evidence stops before authentication and request", async () => {
  await assert.rejects(generateEvidenceBoundAnalysis({ ...model, incident, evidence: [{ ...trace, source_type: "operator_note" }] }, {
    getAccessToken: async () => assert.fail("unexpected authentication"),
    request: async () => assert.fail("unexpected model request"),
  }), /no_qualifying_ai_evidence/);
});

test("partial and malformed provider output are rejected with bounded errors", async () => {
  for (const [finishReason, text, expected] of [
    ["MAX_TOKENS", JSON.stringify(validAnalysis), "incomplete_ai_analysis"],
    ["STOP", "{unexpected provider text", "invalid_ai_json"],
  ]) {
    await assert.rejects(generateEvidenceBoundAnalysis({ ...model, region: "global", incident, evidence: [trace] }, {
      getAccessToken: async () => "fixture-only-token",
      request: async url => {
        assert.equal(new URL(url).hostname, "aiplatform.googleapis.com");
        return Response.json({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });
      },
    }), { message: expected });
  }
});
