import type { TelemetryRecord } from "./telemetry";

export type DeploymentEvidence = {
  record: TelemetryRecord;
  version: string;
  previousVersion: string | null;
  image: string | null;
  commitSha: string | null;
  actor: string | null;
  minutesBeforeFailure: number | null;
  before: { requests: number; errors: number; errorRate: number; p95: number };
  after: { requests: number; errors: number; errorRate: number; p95: number };
  errorRateDelta: number;
  p95Delta: number;
  confidence: number;
};

function isError(record: TelemetryRecord) {
  return (record.status_code ?? 0) >= 500 || record.severity?.toUpperCase() === "ERROR";
}

function percentile(values: number[], percentileValue: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(records: TelemetryRecord[]) {
  const traces = records.filter((record) => record.signal_type === "trace");
  const errors = traces.filter(isError).length;
  return {
    requests: traces.length,
    errors,
    errorRate: traces.length ? (errors / traces.length) * 100 : 0,
    p95: percentile(traces.map((record) => record.duration_ms ?? 0).filter((value) => value > 0), 95),
  };
}

function attribute(record: TelemetryRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record.attributes[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return null;
}

export function correlateDeployments(records: TelemetryRecord[], serviceName: string, environment: string) {
  const serviceRecords = records.filter((record) => record.service_name === serviceName && record.environment === environment);
  const deployments = serviceRecords.filter((record) => record.signal_type === "deployment");
  const failures = serviceRecords.filter((record) => record.signal_type === "trace" && isError(record));
  const firstFailure = [...failures].sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime())[0];

  return deployments
    .map((deployment): DeploymentEvidence => {
      const deployedAt = new Date(deployment.observed_at).getTime();
      const windowMs = 30 * 60 * 1000;
      const beforeRecords = serviceRecords.filter((record) => {
        const time = new Date(record.observed_at).getTime();
        return time >= deployedAt - windowMs && time < deployedAt;
      });
      const afterRecords = serviceRecords.filter((record) => {
        const time = new Date(record.observed_at).getTime();
        return time >= deployedAt && time <= deployedAt + windowMs;
      });
      const before = summarize(beforeRecords);
      const after = summarize(afterRecords);
      const errorRateDelta = after.errorRate - before.errorRate;
      const p95Delta = after.p95 - before.p95;
      const minutesBeforeFailure = firstFailure
        ? Math.round((new Date(firstFailure.observed_at).getTime() - deployedAt) / 60000)
        : null;
      const precededFailure = minutesBeforeFailure !== null && minutesBeforeFailure >= 0 && minutesBeforeFailure <= 30;
      const confidence = Math.min(95, Math.max(10,
        (precededFailure ? 45 : 0) +
        (errorRateDelta > 0 ? 25 : 0) +
        (p95Delta > 0 ? 20 : 0) +
        (after.requests >= 3 ? 10 : 0),
      ));

      return {
        record: deployment,
        version: attribute(deployment, "deployment.version", "service.version", "k8s.deployment.revision") ?? deployment.message,
        previousVersion: attribute(deployment, "deployment.previous_version", "service.previous_version"),
        image: attribute(deployment, "container.image.name", "container.image", "deployment.image"),
        commitSha: attribute(deployment, "vcs.ref.head.revision", "git.commit.sha", "deployment.commit_sha"),
        actor: attribute(deployment, "deployment.actor", "enduser.id", "ci.actor"),
        minutesBeforeFailure,
        before,
        after,
        errorRateDelta,
        p95Delta,
        confidence,
      };
    })
    .sort((a, b) => new Date(b.record.observed_at).getTime() - new Date(a.record.observed_at).getTime());
}
