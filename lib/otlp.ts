import { nanosToIso, TelemetryRecord, valueOf } from "./telemetry";

type AnyRecord = Record<string, any>;

function anyValue(value: AnyRecord | undefined): any {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return value.intValue;
  if ("doubleValue" in value) return value.doubleValue;
  if ("boolValue" in value) return value.boolValue;
  if ("bytesValue" in value) return value.bytesValue;
  if (value.arrayValue?.values) return value.arrayValue.values.map((entry: AnyRecord) => anyValue(entry));
  if (value.kvlistValue?.values) {
    return Object.fromEntries(
      value.kvlistValue.values.map((entry: AnyRecord) => [entry.key, anyValue(entry.value)]),
    );
  }
  return undefined;
}

function attributesToObject(attributes: AnyRecord[] | undefined) {
  return Object.fromEntries(
    (attributes ?? []).map((attribute: AnyRecord) => [attribute.key, anyValue(attribute.value)]),
  );
}

function resourceContext(resource: AnyRecord | undefined) {
  const attributes = resource?.attributes;
  return {
    service: String(valueOf(attributes, "service.name") ?? "unknown-service"),
    environment: String(valueOf(attributes, "deployment.environment") ?? "unknown"),
    workspace: String(valueOf(attributes, "signaldeck.workspace.id") ?? "default"),
    resourceAttributes: attributesToObject(attributes),
  };
}

function otelStatusIsError(code: unknown) {
  return code === 2 || code === "2" || code === "STATUS_CODE_ERROR";
}

function numericHttpStatus(attributes: Record<string, unknown>) {
  const raw = attributes["http.response.status_code"] ?? attributes["http.status_code"];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function kubernetesEvidence(body: any, context: ReturnType<typeof resourceContext>, log: AnyRecord, scopeName?: string): TelemetryRecord | null {
  if (!body || typeof body !== "object" || !body.kind || !body.metadata) return null;

  const kind = String(body.kind);
  const metadata = body.metadata ?? {};
  const namespace = String(metadata.namespace ?? "cluster");
  const name = String(metadata.name ?? "unknown");
  const attributes: Record<string, unknown> = {
    ...context.resourceAttributes,
    ...attributesToObject(log.attributes),
    scope: scopeName,
    "k8s.kind": kind,
    "k8s.object.name": name,
    "k8s.namespace.name": namespace,
    "k8s.uid": metadata.uid,
    "k8s.resource_version": metadata.resourceVersion,
  };

  let message = `${kind} ${namespace}/${name} changed`;
  let severity = "INFO";
  let serviceName = name;

  if (kind === "Event") {
    const reason = body.reason ?? "Kubernetes event";
    const note = body.note ?? body.message ?? "";
    const regarding = body.regarding ?? body.involvedObject ?? {};
    serviceName = String(regarding.name ?? name);
    message = `${reason}${note ? `: ${note}` : ""}`;
    severity = String(body.type ?? "Normal").toLowerCase() === "warning" ? "ERROR" : "INFO";
    attributes["k8s.event.reason"] = reason;
    attributes["k8s.event.type"] = body.type ?? "Normal";
    attributes["k8s.event.action"] = body.action;
    attributes["k8s.object.kind"] = regarding.kind;
    attributes["k8s.object.name"] = regarding.name ?? name;
  } else if (kind === "Pod") {
    const statuses = body.status?.containerStatuses ?? [];
    const restartCount = statuses.reduce((sum: number, status: AnyRecord) => sum + Number(status.restartCount ?? 0), 0);
    const waitingReason = statuses.map((status: AnyRecord) => status.state?.waiting?.reason).find(Boolean);
    const terminatedReason = statuses.map((status: AnyRecord) => status.lastState?.terminated?.reason ?? status.state?.terminated?.reason).find(Boolean);
    const reason = waitingReason ?? terminatedReason ?? body.status?.reason;
    const phase = body.status?.phase ?? "Unknown";
    message = `Pod ${name} is ${phase}${reason ? ` (${reason})` : ""}`;
    severity = phase === "Failed" || waitingReason === "CrashLoopBackOff" || terminatedReason === "OOMKilled" ? "ERROR" : "INFO";
    attributes["k8s.pod.name"] = name;
    attributes["k8s.pod.phase"] = phase;
    attributes["k8s.pod.restart_count"] = restartCount;
    attributes["k8s.pod.reason"] = reason;
    attributes["k8s.node.name"] = body.spec?.nodeName;
    attributes["k8s.pod.ip"] = body.status?.podIP;
    attributes["k8s.workload.name"] = metadata.labels?.["app.kubernetes.io/name"] ?? metadata.labels?.app;
  } else if (kind === "Deployment") {
    const images = (body.spec?.template?.spec?.containers ?? []).map((container: AnyRecord) => container.image).filter(Boolean);
    serviceName = String(metadata.labels?.["app.kubernetes.io/name"] ?? metadata.labels?.app ?? name);
    message = `Deployment ${name} observed: ${body.status?.readyReplicas ?? 0}/${body.spec?.replicas ?? 0} ready`;
    attributes["k8s.deployment.name"] = name;
    attributes["k8s.deployment.replicas"] = body.spec?.replicas ?? 0;
    attributes["k8s.deployment.ready_replicas"] = body.status?.readyReplicas ?? 0;
    attributes["k8s.deployment.updated_replicas"] = body.status?.updatedReplicas ?? 0;
    attributes["k8s.container.images"] = images;
    attributes["k8s.deployment.generation"] = metadata.generation;
    severity = Number(body.status?.readyReplicas ?? 0) < Number(body.spec?.replicas ?? 0) ? "WARN" : "INFO";
  }

  return {
    workspace_id: context.workspace,
    signal_type: "k8s_event",
    service_name: serviceName,
    environment: context.environment,
    severity,
    message,
    attributes,
    observed_at: nanosToIso(log.timeUnixNano ?? log.observedTimeUnixNano),
  };
}

export function normalizeOtlpLogs(payload: AnyRecord): TelemetryRecord[] {
  const output: TelemetryRecord[] = [];
  for (const resourceLogs of payload.resourceLogs ?? []) {
    const context = resourceContext(resourceLogs.resource);
    for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
      for (const log of scopeLogs.logRecords ?? []) {
        const body = anyValue(log.body);
        const k8sRecord = kubernetesEvidence(body, context, log, scopeLogs.scope?.name);
        if (k8sRecord) {
          output.push(k8sRecord);
          continue;
        }
        output.push({
          workspace_id: context.workspace,
          signal_type: "log",
          service_name: context.service,
          environment: context.environment,
          severity: log.severityText ?? "INFO",
          message: typeof body === "string" ? body : JSON.stringify(body ?? ""),
          trace_id: log.traceId,
          span_id: log.spanId,
          attributes: { ...context.resourceAttributes, ...attributesToObject(log.attributes), scope: scopeLogs.scope?.name },
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
        const spanAttributes = attributesToObject(span.attributes);
        const httpStatus = numericHttpStatus(spanAttributes);
        output.push({
          workspace_id: context.workspace,
          signal_type: "trace",
          service_name: context.service,
          environment: context.environment,
          severity: otelStatusIsError(span.status?.code) || (httpStatus !== undefined && httpStatus >= 500) ? "ERROR" : "INFO",
          message: span.name ?? "unnamed span",
          trace_id: span.traceId,
          span_id: span.spanId,
          parent_span_id: span.parentSpanId || undefined,
          duration_ms: Math.max(0, (end - start) / 1_000_000),
          status_code: httpStatus,
          attributes: {
            ...context.resourceAttributes,
            ...spanAttributes,
            scope: scopeSpans.scope?.name,
            "otel.span.kind": span.kind,
            "otel.status.code": span.status?.code,
          },
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
              ...attributesToObject(point.attributes),
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
