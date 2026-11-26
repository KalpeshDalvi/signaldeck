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
  hypothesis: "The initiating condition needs verification.",
  failure_mechanism: "The affected service received an HTTP failure on a dependency span.",
  immediate_fix: "Inspect readiness and endpoint membership.",
  permanent_fix: "Confirm the failure mode before choosing a prevention measure.",
  validation_steps: ["Compare one successful request with the failed request."],
  uncertainties: "The trace does not identify a change or actor.",
  evidence_ids: ["E1"],
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

test("accepted model references map back to original archive source IDs", () => {
  const { sourceIds } = evidencePacket(incident, [trace]);
  const result = validateAnalysis({ ...validAnalysis, evidence_ids: ["E1", "E1"], verified: true }, sourceIds);
  assert.deepEqual(result.evidence_ids, [trace.source_event_id]);
  assert.equal("verified" in result, false);
  for (const evidence_ids of [["invented"], [trace.source_event_id], []]) {
    assert.throws(() => validateAnalysis({ ...validAnalysis, evidence_ids }, sourceIds), /unsupported_ai_citation/);
  }
  assert.throws(() => validateAnalysis({ ...validAnalysis, validation_steps: [" "] }, sourceIds), /invalid_ai_validation_steps/);
  assert.throws(() => validateAnalysis({ ...validAnalysis, hypothesis: "" }, sourceIds), /invalid_ai_field_hypothesis/);
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
        parts: [{ text: JSON.stringify({ ...validAnalysis, evidence_ids: ["E1", "E2"] }) }],
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
