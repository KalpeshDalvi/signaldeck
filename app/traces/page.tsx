import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { formatDuration } from "@/lib/analytics";
import { readTelemetry } from "@/lib/telemetry";
import { bottleneckFinding, buildTraceSummaries, spanOperation } from "@/lib/trace-analysis";
import "./traces.css";

export const dynamic = "force-dynamic";

export default async function Traces({ searchParams }: { searchParams: Promise<{ trace?: string; service?: string; errors?: string; minutes?: string }> }) {
  const params = await searchParams;
  const allowedRanges = [15, 60, 360, 1440, 10080];
  const minutes = allowedRanges.includes(Number(params.minutes)) ? Number(params.minutes) : 60;
  const spans = await readTelemetry(500, "trace", undefined, "applications", { minutes, service: params.service, errorsOnly: params.errors === "1" });
  // Hide probe-only traces when real application traces are available.
  const allTraces = buildTraceSummaries(spans);
  const isProbe = (value: string) => /\/(?:healthz?|readyz|livez)(?:\b|\/|\?)/i.test(value);
  const applicationTraces = allTraces.filter((trace) => !trace.spans.every((span) =>
    isProbe(span.message) || isProbe(String(span.attributes["http.route"] ?? span.attributes["url.path"] ?? ""))
  ));
  const traces = applicationTraces.length ? applicationTraces : allTraces;
  const services = [...new Set(traces.flatMap((trace) => trace.spans.map((span) => span.service_name)))].sort();
  const filteredTraces = traces.filter((trace) => (!params.service || trace.spans.some((span) => span.service_name === params.service)) && (params.errors !== "1" || trace.errorCount > 0));
  const traceHref = (id: string) => {
    const q = new URLSearchParams({ trace: id });
    if (params.service) q.set("service", params.service);
    q.set("minutes", String(minutes));
    if (params.errors === "1") q.set("errors", "1");
    return "/traces?" + q.toString();
  };
  const rangeHref = (range: number) => {
    const q = new URLSearchParams({ minutes: String(range) });
    if (params.service) q.set("service", params.service);
    if (params.errors === "1") q.set("errors", "1");
    return "/traces?" + q.toString();
  };
  const selected = filteredTraces.find((trace) => trace.traceId === params.trace) ?? filteredTraces[0];

  return <>
    <PageHeader eyebrow="DISTRIBUTED TRACING" title="Traces" description="Follow parent-child spans across services and identify where failed requests spend their time.">
      <span className="pill healthy">{traces.length} traces · {spans.length} spans</span>
    </PageHeader>

    <nav className="trace-timebar" aria-label="Trace time range">
      <span>Time range</span>
      {([ [15, "15 min"], [60, "1 hour"], [360, "6 hours"], [1440, "24 hours"], [10080, "7 days"] ] as const).map(([range, label]) =>
        <Link key={range} href={rangeHref(range)} className={minutes === range ? "active" : ""}>{label}</Link>
      )}
    </nav>
    <div className="trace-layout">
      <article className="panel">
        <div className="panel-title"><div><h2>Recent traces</h2><p>Grouped by trace ID, slowest first · health checks hidden when application traces exist</p></div></div>
        <form className="trace-filters" action="/traces">
          <input type="hidden" name="minutes" value={minutes} />
          <label>Service <select name="service" defaultValue={params.service ?? ""}><option value="">All services</option>{services.map((service) => <option key={service} value={service}>{service}</option>)}</select></label>
          <label className="trace-filter-check"><input type="checkbox" name="errors" value="1" defaultChecked={params.errors === "1"} /> Errors only</label>
          <button type="submit">Apply</button>
          <Link href={rangeHref(minutes)}>Reset</Link>
        </form>
        <div className="trace-list">
          {filteredTraces.map((trace) => <Link key={trace.traceId} href={traceHref(trace.traceId)} className={`trace-link ${trace.traceId === selected.traceId ? "selected" : ""}`}>
            <div>
              <strong>{params.service ? (trace.spans.find((span) => span.service_name === params.service)?.message ?? trace.root?.message ?? "Distributed trace") : (trace.root?.message ?? "Distributed trace")}</strong>
              <p>{params.service ?? trace.root?.service_name ?? "unknown service"} · {trace.serviceCount} services · {trace.spans.length} spans</p>
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
                  <strong>{spanOperation(span)}</strong>
                  <small>{span.service_name} · {span.dependencyType}{span.parent_span_id ? ` · child of ${span.parent_span_id.slice(0, 8)}` : " · root"}</small>
                </div>
                <div className="span-track" title={`${spanOperation(span)}: ${formatDuration(span.duration_ms ?? 0)}`}>
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
          <div className="panel-title"><div><h2>Slowest dependency context</h2><p>{selected.bottleneck.service_name} · {spanOperation(selected.bottleneck)}</p></div><span className="pill info">{selected.bottleneck.dependencyType}</span></div>
          <div className="cluster-stat"><span>Span ID</span><strong>{selected.bottleneck.span_id ?? "not supplied"}</strong></div>
          <div className="cluster-stat"><span>Parent span</span><strong>{selected.bottleneck.parent_span_id ?? "root span"}</strong></div>
          <div className="cluster-stat"><span>Status</span><strong>{selected.bottleneck.status_code ?? selected.bottleneck.severity ?? "—"}</strong></div>
          <pre className="attributes">{JSON.stringify(selected.bottleneck.attributes, null, 2)}</pre>
        </article> : null}
      </section>
    </div>
  </>;
}
