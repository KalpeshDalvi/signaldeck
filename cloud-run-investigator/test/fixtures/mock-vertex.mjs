import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "google-auth-library") {
      return {
        url: "data:text/javascript,export class GoogleAuth { async getAccessToken() { return 'synthetic-token'; } }",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

globalThis.fetch = async (url, options) => {
  assert.equal(url, "https://aiplatform.us.rep.googleapis.com/v1/projects/fixture-project/locations/us/publishers/google/models/fixture-model:generateContent");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Authorization, "Bearer synthetic-token");
  assert.ok(!options.body.includes("private-fixture-message"));
  const request = JSON.parse(options.body);
  const { evidence } = JSON.parse(request.contents[0].parts[0].text);
  const observations = evidence.filter(signal => signal.available_claim).map(signal => ({
    claim: signal.available_claim,
    evidence_id: signal.id,
    statement: "Invented free-form diagnosis",
  }));
  if (process.env.SIGNALDECK_TEST_UNSUPPORTED_CLAIM === "true") {
    observations[0].claim = "response_handling";
  }
  return Response.json({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
      observations,
      immediate_fix: "Check error rates and downstream reachability.",
      permanent_fix: "Review error handling after establishing the cause.",
      validation_steps: ["Compare one known-good request with a failing request."],
      verified_mechanism: "Invented verification",
    }) }] } }],
  });
};
