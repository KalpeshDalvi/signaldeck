import { TelemetryRecord } from "./telemetry";

export type TraceSpan = TelemetryRecord & {
  depth: number;
  dependencyType: "service" | "database" | "queue" | "cache" | "http" | "internal";
  offsetPct: number;
  widthPct: number;
};

export type TraceSummary = {
  traceId: string;
  spans: TraceSpan[];
  root?: TraceSpan;
  startedAt: string;
  durationMs: number;
  serviceCount: number;
  errorCount: number;
  bottleneck?: TraceSpan;
};

function dependencyType(span: TelemetryRecord): TraceSpan["dependencyType"] {
  const a = span.attributes ?? {};
  if (a["db.system"] || a["db.operation.name"] || a["db.statement"]) return "database";
  if (a["messaging.system"] || a["messaging.destination.name"]) return "queue";
  if (a["cache.system"] || String(a["db.system"] ?? "").toLowerCase().includes("redis")) return "cache";
  if (a["http.request.method"] || a["http.method"] || a["server.address"] || a["url.full"]) return "http";
  if (span.parent_span_id) return "service";
  return "internal";
}

function errorSpan(span: TelemetryRecord) {
  return (span.status_code ?? 0) >= 500 || span.severity?.toUpperCase() === "ERROR";
}

export function buildTraceSummaries(records: TelemetryRecord[]): TraceSummary[] {
  const grouped = new Map<string, TelemetryRecord[]>();
  for (const record of records) {
    if (!record.trace_id) continue;
    const group = grouped.get(record.trace_id) ?? [];
    group.push(record);
    grouped.set(record.trace_id, group);
  }

  return [...grouped.entries()].map(([traceId, rawSpans]) => {
    const ordered = [...rawSpans].sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());
    const startMs = Math.min(...ordered.map((span) => new Date(span.observed_at).getTime()));
    const endMs = Math.max(...ordered.map((span) => new Date(span.observed_at).getTime() + (span.duration_ms ?? 0)));
    const total = Math.max(1, endMs - startMs);
    const byId = new Map(ordered.map((span) => [span.span_id, span]));

    const depthOf = (span: TelemetryRecord) => {
      let depth = 0;
      let parent = span.parent_span_id ? byId.get(span.parent_span_id) : undefined;
      const seen = new Set<string>();
      while (parent && depth < 12) {
        if (parent.span_id && seen.has(parent.span_id)) break;
        if (parent.span_id) seen.add(parent.span_id);
        depth += 1;
        parent = parent.parent_span_id ? byId.get(parent.parent_span_id) : undefined;
      }
      return depth;
    };

    const spans: TraceSpan[] = ordered.map((span) => {
      const spanStart = new Date(span.observed_at).getTime();
      return {
        ...span,
        depth: depthOf(span),
        dependencyType: dependencyType(span),
        offsetPct: Math.max(0, Math.min(100, ((spanStart - startMs) / total) * 100)),
        widthPct: Math.max(1.2, Math.min(100, ((span.duration_ms ?? 0) / total) * 100)),
      };
    });

    const root = spans.find((span) => !span.parent_span_id || !byId.has(span.parent_span_id)) ?? spans[0];
    const bottleneck = [...spans]
      .filter((span) => span !== root)
      .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))[0] ?? root;

    return {
      traceId,
      spans,
      root,
      startedAt: new Date(startMs).toISOString(),
      durationMs: total,
      serviceCount: new Set(spans.map((span) => span.service_name)).size,
      errorCount: spans.filter(errorSpan).length,
      bottleneck,
    };
  }).sort((a, b) => b.durationMs - a.durationMs);
}

export function bottleneckFinding(trace: TraceSummary) {
  if (!trace.bottleneck) return "No bottleneck could be identified from this trace.";
  const span = trace.bottleneck;
  const share = trace.durationMs > 0 ? Math.round(((span.duration_ms ?? 0) / trace.durationMs) * 100) : 0;
  return `${span.service_name} · ${span.message} accounts for about ${share}% of the trace duration (${Math.round(span.duration_ms ?? 0)} ms).`;
}
