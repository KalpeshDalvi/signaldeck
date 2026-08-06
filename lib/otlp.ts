import { nanosToIso, TelemetryRecord, valueOf } from "./telemetry";

type AnyRecord = Record<string, any>;

function resourceContext(resource: AnyRecord | undefined) {
  const attributes = resource?.attributes;
  return {
    service: String(valueOf(attributes, "service.name") ?? "unknown-service"),
    environment: String(valueOf(attributes, "deployment.environment") ?? "unknown"),
    workspace: String(valueOf(attributes, "signaldeck.workspace.id") ?? "default"),
    resourceAttributes: Object.fromEntries(
      (attributes ?? []).map((attribute: AnyRecord) => [attribute.key, Object.values(attribute.value ?? {})[0]]),
    ),
  };
}

export function normalizeOtlpLogs(payload: AnyRecord): TelemetryRecord[] {
  const output: TelemetryRecord[] = [];
  for (const resourceLogs of payload.resourceLogs ?? []) {
    const context = resourceContext(resourceLogs.resource);
    for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
      for (const log of scopeLogs.logRecords ?? []) {
        const body = log.body ? Object.values(log.body)[0] : "";
        output.push({
          workspace_id: context.workspace,
          signal_type: "log",
          service_name: context.service,
          environment: context.environment,
          severity: log.severityText ?? "INFO",
          message: String(body ?? ""),
          trace_id: log.traceId,
          span_id: log.spanId,
          attributes: { ...context.resourceAttributes, scope: scopeLogs.scope?.name },
          observed_at: nanosToIso(log.timeUnixNano ?? log.observedTimeUnixNano),
        });
      }
    }
  }
  return output;
}

export function normalizeOtlpTraces(payload: AnyRecord): TelemetryRecord[] {
  const output: TelemetryRecord[] = [];
  for (const resourceSpans of payload.resourceSpans ?? []) {
    const context = resourceContext(resourceSpans.resource);
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        const start = Number(span.startTimeUnixNano ?? 0);
        const end = Number(span.endTimeUnixNano ?? start);
        output.push({
          workspace_id: context.workspace,
          signal_type: "trace",
          service_name: context.service,
          environment: context.environment,
          severity: span.status?.code === 2 ? "ERROR" : "INFO",
          message: span.name ?? "unnamed span",
          trace_id: span.traceId,
          span_id: span.spanId,
          duration_ms: Math.max(0, (end - start) / 1_000_000),
          status_code: span.status?.code,
          attributes: { ...context.resourceAttributes, scope: scopeSpans.scope?.name, kind: span.kind },
          observed_at: nanosToIso(span.startTimeUnixNano),
        });
      }
    }
  }
  return output;
}

export function normalizeOtlpMetrics(payload: AnyRecord): TelemetryRecord[] {
  const output: TelemetryRecord[] = [];
  for (const resourceMetrics of payload.resourceMetrics ?? []) {
    const context = resourceContext(resourceMetrics.resource);
    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      for (const metric of scopeMetrics.metrics ?? []) {
        const points = metric.gauge?.dataPoints ?? metric.sum?.dataPoints ?? metric.histogram?.dataPoints ?? [];
        for (const point of points) {
          output.push({
            workspace_id: context.workspace,
            signal_type: "metric",
            service_name: context.service,
            environment: context.environment,
            message: metric.name ?? "unnamed metric",
            attributes: {
              ...context.resourceAttributes,
              unit: metric.unit,
              value: point.asDouble ?? point.asInt ?? point.sum ?? point.count,
            },
            observed_at: nanosToIso(point.timeUnixNano),
          });
        }
      }
    }
  }
  return output;
}
