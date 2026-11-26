import { pathToFileURL } from "node:url";
import { generateEvidenceBoundAnalysis } from "./ai-analyst.js";

const occurredAt = "2026-01-01T12:00:00Z";
const traceId = "a".repeat(32);
const parentId = "b".repeat(16);
const childId = "c".repeat(16);

export function runSyntheticTrial(configuration, transport) {
  return generateEvidenceBoundAnalysis({
    ...configuration,
    incident: { impacted_service: "trial-checkout", incident_at: occurredAt },
    evidence: [{
      source_event_id: "trial-checkout-trace",
      source_type: "trace",
      resource_name: "trial-checkout",
      source_event_at: occurredAt,
      payload: {
        trace_id: traceId, span_id: parentId, span_kind: "2", status_code: 500, duration_ms: 820,
      },
    }, {
      source_event_id: "trial-dependency-trace",
      source_type: "trace",
      resource_name: "trial-checkout",
      source_event_at: "2026-01-01T12:00:00.020Z",
      payload: {
        trace_id: traceId, span_id: childId, parent_span_id: parentId, span_kind: "3",
        status_code: 503, duration_ms: 760, peer_service: "trial-inventory",
      },
    }],
  }, transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error("usage: node ai-trial.js");
    const analysis = await runSyntheticTrial({
      project: process.env.SIGNALDECK_GCP_PROJECT_ID,
      region: process.env.SIGNALDECK_VERTEX_REGION ?? "us",
      model: process.env.SIGNALDECK_VERTEX_MODEL,
    });
    console.log(JSON.stringify({ mode: "synthetic", analysis }));
  } catch (error) {
    console.error("signaldeck_ai_trial_failed", error.message);
    process.exitCode = 1;
  }
}
