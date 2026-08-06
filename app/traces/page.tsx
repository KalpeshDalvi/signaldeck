import { PageHeader } from "@/components/AppShell";
import { formatDuration } from "@/lib/analytics";
import { readTelemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

export default async function Traces() {
  const traces = (await readTelemetry(200, "trace")).sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0));
  const selected = traces[0];

  return <>
    <PageHeader eyebrow="DISTRIBUTED TRACING" title="Traces" description="Live requests ordered by duration, with service and response context."><span className="pill healthy">{traces.length} traces</span></PageHeader>
    {traces.length ? <div className="split">
      <article className="panel"><div className="list">{traces.map((trace, index) => <div className={`list-item ${index === 0 ? "selected" : ""}`} key={trace.id ?? `${trace.observed_at}-${index}`}><div><strong>{trace.message}</strong><p>{trace.service_name} · {trace.trace_id ?? "trace id unavailable"}</p></div><div><b>{formatDuration(trace.duration_ms ?? 0)}</b><span className={(trace.status_code ?? 0) >= 500 ? "bad-text" : "good-text"}>{trace.status_code ?? "—"}</span></div></div>)}</div></article>
      <article className="panel"><div className="panel-title"><div><h2>{selected.message}</h2><p>{selected.service_name} · {selected.environment}</p></div><strong>{formatDuration(selected.duration_ms ?? 0)}</strong></div><div className="cluster-stat"><span>Trace ID</span><strong>{selected.trace_id ?? "not supplied"}</strong></div><div className="cluster-stat"><span>Span ID</span><strong>{selected.span_id ?? "not supplied"}</strong></div><div className="cluster-stat"><span>HTTP status</span><strong>{selected.status_code ?? "—"}</strong></div><div className="cluster-stat"><span>Observed</span><strong>{new Date(selected.observed_at).toLocaleString()}</strong></div><pre className="attributes">{JSON.stringify(selected.attributes, null, 2)}</pre></article>
    </div> : <article className="panel empty-state"><h2>No traces received</h2><p>Send a custom trace event or point an OTLP/HTTP exporter to <code>/api/otel/v1/traces</code>.</p></article>}
  </>;
}
