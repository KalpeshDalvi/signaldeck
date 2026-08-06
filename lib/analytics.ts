import type { TelemetryRecord } from "./telemetry";

export type ServiceSummary = {
  name: string;
  environment: string;
  requests: number;
  requestRate: number;
  errors: number;
  errorRate: number;
  p95: number;
  status: "Healthy" | "Degraded" | "Critical";
};

function percentile(values: number[], percentileValue: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function windowMinutes(records: TelemetryRecord[]) {
  if (records.length < 2) return 1;
  const times = records.map((record) => new Date(record.observed_at).getTime()).filter(Number.isFinite);
  if (times.length < 2) return 1;
  return Math.max(1, (Math.max(...times) - Math.min(...times)) / 60_000);
}

export function summarizeServices(records: TelemetryRecord[]): ServiceSummary[] {
  const requestRecords = records.filter((record) => record.signal_type === "trace");
  const minutes = windowMinutes(requestRecords);
  const grouped = new Map<string, TelemetryRecord[]>();

  for (const record of requestRecords) {
    const key = `${record.environment}:${record.service_name}`;
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }

  return [...grouped.values()]
    .map((items) => {
      const first = items[0];
      const errors = items.filter((item) => (item.status_code ?? 0) >= 500 || item.severity?.toUpperCase() === "ERROR").length;
      const errorRate = items.length ? (errors / items.length) * 100 : 0;
      const p95 = percentile(items.map((item) => item.duration_ms ?? 0).filter((value) => value > 0), 95);
      const status = errorRate >= 5 || p95 >= 1500 ? "Critical" : errorRate >= 2 || p95 >= 750 ? "Degraded" : "Healthy";
      return {
        name: first.service_name,
        environment: first.environment,
        requests: items.length,
        requestRate: items.length / minutes,
        errors,
        errorRate,
        p95,
        status,
      } satisfies ServiceSummary;
    })
    .sort((a, b) => b.errorRate - a.errorRate || b.p95 - a.p95);
}

export function summarizeOverview(records: TelemetryRecord[]) {
  const services = summarizeServices(records);
  const traces = records.filter((record) => record.signal_type === "trace");
  const errors = traces.filter((record) => (record.status_code ?? 0) >= 500 || record.severity?.toUpperCase() === "ERROR").length;
  const durations = traces.map((record) => record.duration_ms ?? 0).filter((value) => value > 0);
  const minutes = windowMinutes(traces);
  const critical = services.filter((service) => service.status === "Critical").length;
  const degraded = services.filter((service) => service.status === "Degraded").length;

  return {
    services,
    serviceCount: services.length,
    healthyCount: services.filter((service) => service.status === "Healthy").length,
    requestRate: traces.length / minutes,
    errorRate: traces.length ? (errors / traces.length) * 100 : 0,
    p95: percentile(durations, 95),
    activeAlerts: critical + degraded,
    criticalAlerts: critical,
    slowestTrace: [...traces].sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))[0],
  };
}

export function formatRate(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(value < 10 ? 1 : 0);
}

export function formatDuration(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}
