import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { formatDuration, formatRate, summarizeOverview } from "@/lib/analytics";
import { readTelemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${status.toLowerCase()}`}>{status}</span>;
}

export default async function Home() {
  const records = await readTelemetry(500);
  const summary = summarizeOverview(records);
  const recentEvents = records
    .filter((record) => record.severity?.toUpperCase() === "ERROR" || record.signal_type === "k8s_event")
    .slice(0, 4);

  return <>
    <PageHeader eyebrow="LIVE TELEMETRY" title="Overview" description="Golden signals calculated from ingested traces, logs, metrics, and Kubernetes events.">
      <button>Last 30 minutes</button><Link className="button primary" href="/connect">Add environment</Link>
    </PageHeader>

    <div className="metrics">
      <article><span>Services</span><strong>{summary.serviceCount}</strong><small>{summary.healthyCount} healthy</small></article>
      <article><span>Request rate</span><strong>{formatRate(summary.requestRate)}</strong><small>per minute</small></article>
      <article><span>Error rate</span><strong>{summary.errorRate.toFixed(1)}%</strong><small className={summary.errorRate >= 2 ? "bad" : ""}>{summary.errorRate >= 2 ? "Needs attention" : "Within threshold"}</small></article>
      <article><span>P95 latency</span><strong>{formatDuration(summary.p95)}</strong><small className={summary.p95 >= 750 ? "bad" : ""}>{summary.p95 >= 750 ? "Above target" : "Within target"}</small></article>
      <article><span>Active alerts</span><strong>{summary.activeAlerts}</strong><small>{summary.criticalAlerts} critical</small></article>
    </div>

    {!records.length && <article className="panel empty-state"><h2>No telemetry received yet</h2><p>POST a trace to <code>/api/telemetry</code> or connect an OpenTelemetry Collector. The dashboard will populate automatically.</p><Link className="button primary" href="/connect">View connection setup</Link></article>}

    <div className="grid">
      <article className="panel services">
        <div className="panel-title"><div><h2>Service health</h2><p>Calculated from real trace volume, errors, and latency</p></div><Link className="button" href="/services">View all</Link></div>
        <div className="table"><div className="row heading"><span>Service</span><span>Status</span><span>Requests</span><span>Error rate</span><span>P95</span></div>
          {summary.services.slice(0, 5).map((service) => <Link className="row row-link" href={`/services?service=${service.name}`} key={`${service.environment}-${service.name}`}><strong>{service.name}</strong><StatusPill status={service.status}/><span>{formatRate(service.requestRate)}/min</span><span>{service.errorRate.toFixed(1)}%</span><span>{formatDuration(service.p95)}</span></Link>)}
        </div>
      </article>

      <article className="panel cluster">
        <div className="panel-title"><div><h2>GKE collector</h2><p>{records.length ? "Telemetry endpoint receiving data" : "Waiting for collector connection"}</p></div><StatusPill status={records.length ? "Healthy" : "Degraded"} /></div>
        <div className="cluster-stat"><span>Records buffered</span><strong>{records.length}</strong></div>
        <div className="cluster-stat"><span>Trace records</span><strong>{records.filter((record) => record.signal_type === "trace").length}</strong></div>
        <div className="cluster-stat"><span>Log records</span><strong>{records.filter((record) => record.signal_type === "log").length}</strong></div>
        <div className="cluster-stat"><span>Kubernetes events</span><strong>{records.filter((record) => record.signal_type === "k8s_event").length}</strong></div>
        <Link className="text-link" href="/kubernetes">Open Kubernetes explorer →</Link>
      </article>

      <article className="panel activity">
        <div className="panel-title"><div><h2>Incident activity</h2><p>Latest errors and Kubernetes events</p></div></div>
        {recentEvents.length ? recentEvents.map((event) => <div className="event" key={`${event.observed_at}-${event.message}`}><time>{new Date(event.observed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span className={`dot ${event.severity?.toLowerCase() === "error" ? "critical" : "warning"}`} /><div><strong>{event.message}</strong><p>{event.service_name} · {event.environment}</p></div></div>) : <p className="muted">No incident signals have been received.</p>}
        <Link className="text-link" href="/alerts">View alerts →</Link>
      </article>

      <article className="panel trace">
        <div className="panel-title"><div><h2>Slowest trace</h2><p>{summary.slowestTrace?.message ?? "No trace received"}</p></div><strong>{formatDuration(summary.slowestTrace?.duration_ms ?? 0)}</strong></div>
        {summary.slowestTrace ? <>
          <div className="cluster-stat"><span>Service</span><strong>{summary.slowestTrace.service_name}</strong></div>
          <div className="cluster-stat"><span>Status</span><strong>{summary.slowestTrace.status_code ?? "—"}</strong></div>
          <div className="cluster-stat"><span>Trace ID</span><strong>{summary.slowestTrace.trace_id ?? "not supplied"}</strong></div>
        </> : <p className="muted">Send a trace event to see the slowest request here.</p>}
        <Link className="text-link" href="/traces">Inspect traces →</Link>
      </article>
    </div>
  </>;
}
