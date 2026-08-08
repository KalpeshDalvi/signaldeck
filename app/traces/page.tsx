import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { formatDuration } from "@/lib/analytics";
import { readTelemetry } from "@/lib/telemetry";
import { bottleneckFinding, buildTraceSummaries } from "@/lib/trace-analysis";
import "./traces.css";

export const dynamic = "force-dynamic";

export default async function Traces({ searchParams }: { searchParams: Promise<{ trace?: string }> }) {
  const params = await searchParams;
  const spans = await readTelemetry(500, "trace");
  const traces = buildTraceSummaries(spans);
  const selected = traces.find((trace) => trace.traceId === params.trace) ?? traces[0];

  return <>
    <PageHeader eyebrow="DISTRIBUTED TRACING" title="Traces" description="Follow parent-child spans across services and identify where failed requests spend their time.">
      <span className="pill healthy">{traces.length} traces · {spans.length} spans</span>
    </PageHeader>

    {selected ? <div className="trace-layout">
      <article className="panel">
        <div className="panel-title"><div><h2>Recent traces</h2><p>Grouped by trace ID, slowest first</p></div></div>
        <div className="trace-list">
          {traces.map((trace) => <Link key={trace.traceId} href={`/traces?trace=${encodeURIComponent(trace.traceId)}`} className={`trace-link ${trace.traceId === selected.traceId ? "selected" : ""}`}>
            <div>
              <strong>{trace.root?.message ?? "Distributed trace"}</strong>
              <p>{trace.root?.service_name ?? "unknown service"} · {trace.serviceCount} services · {trace.spans.length} spans</p>
              <small>{trace.traceId}</small>
            </div>
            <div>
              <strong>{formatDuration(trace.durationMs)}</strong>
              {trace.errorCount ? <span className="bad-text">{trace.errorCount} errors</span> : <span className="good-text">healthy</span>}
            </div>
          </Link>)}
        </div>
      </article>

      <section>
        <article className="panel">
          <div className="panel-title">
            <div><h2>{selected.root?.message ?? "Distributed trace"}</h2><p>{selected.traceId}</p></div>
            <strong>{formatDuration(selected.durationMs)}</strong>
          </div>

          <div className="trace-summary-grid">
            <div><span>Services</span><strong>{selected.serviceCount}</strong></div>
            <div><span>Spans</span><strong>{selected.spans.length}</strong></div>
            <div><span>Errors</span><strong className={selected.errorCount ? "bad-text" : "good-text"}>{selected.errorCount}</strong></div>
            <div><span>Started</span><strong>{new Date(selected.startedAt).toLocaleTimeString()}</strong></div>
          </div>

          <div className="waterfall">
            <div className="waterfall-head"><span>Operation</span><span>Timeline</span><span>Duration</span></div>
            {selected.spans.map((span, index) => {
              const isError = (span.status_code ?? 0) >= 500 || span.severity?.toUpperCase() === "ERROR";
              return <div className="waterfall-row" key={span.id ?? span.span_id ?? `${span.observed_at}-${index}`}>
                <div className="span-label" style={{ paddingLeft: `${Math.min(span.depth, 6) * 14}px` }}>
                  <strong>{span.message}</strong>
                  <small>{span.service_name} · {span.dependencyType}{span.parent_span_id ? ` · child of ${span.parent_span_id.slice(0, 8)}` : " · root"}</small>
                </div>
                <div className="span-track" title={`${span.message}: ${formatDuration(span.duration_ms ?? 0)}`}>
                  <div className={`span-bar ${span.dependencyType} ${isError ? "error" : ""}`} style={{ left: `${span.offsetPct}%`, width: `${span.widthPct}%` }} />
                </div>
                <div className="span-duration">{formatDuration(span.duration_ms ?? 0)}</div>
              </div>;
            })}
          </div>

          <div className="bottleneck-card">
            <span>Evidence-based bottleneck</span>
            <p>{bottleneckFinding(selected)}</p>
          </div>
        </article>

        {selected.bottleneck ? <article className="panel trace-attrs">
          <div className="panel-title"><div><h2>Slowest dependency context</h2><p>{selected.bottleneck.service_name} · {selected.bottleneck.message}</p></div><span className="pill info">{selected.bottleneck.dependencyType}</span></div>
          <div className="cluster-stat"><span>Span ID</span><strong>{selected.bottleneck.span_id ?? "not supplied"}</strong></div>
          <div className="cluster-stat"><span>Parent span</span><strong>{selected.bottleneck.parent_span_id ?? "root span"}</strong></div>
          <div className="cluster-stat"><span>Status</span><strong>{selected.bottleneck.status_code ?? selected.bottleneck.severity ?? "—"}</strong></div>
          <pre className="attributes">{JSON.stringify(selected.bottleneck.attributes, null, 2)}</pre>
        </article> : null}
      </section>
    </div> : <article className="panel empty-state"><h2>No distributed traces received</h2><p>Point an OTLP/HTTP exporter to <code>/api/otel/v1/traces</code>. Once parent-child spans arrive, SignalDeck will build the waterfall and dependency analysis automatically.</p></article>}
  </>;
}
