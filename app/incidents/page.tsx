import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { formatDuration, summarizeOverview, summarizeServices } from "@/lib/analytics";
import { readTelemetry } from "@/lib/telemetry";
import "./incidents.css";

export const dynamic = "force-dynamic";

function isError(record: Awaited<ReturnType<typeof readTelemetry>>[number]) {
  return (record.status_code ?? 0) >= 500 || record.severity?.toUpperCase() === "ERROR";
}

export default async function IncidentsPage() {
  const records = await readTelemetry(500);
  const overview = summarizeOverview(records);
  const services = summarizeServices(records);
  const traces = records.filter((record) => record.signal_type === "trace");
  const errorTraces = traces.filter(isError).sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime());
  const errorLogs = records.filter((record) => record.signal_type === "log" && isError(record)).sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime());
  const k8sEvents = records.filter((record) => record.signal_type === "k8s_event").sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime());
  const affected = services.filter((service) => service.status !== "Healthy");
  const primary = affected[0] ?? services[0];
  const slowestFailure = [...errorTraces].sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))[0];
  const evidenceCount = errorTraces.length + errorLogs.length + k8sEvents.length;
  const hasIncident = overview.activeAlerts > 0 || errorTraces.length > 0 || errorLogs.length > 0;
  const likelyCause = slowestFailure
    ? `${slowestFailure.service_name} has the slowest failed request at ${formatDuration(slowestFailure.duration_ms ?? 0)}.`
    : primary?.status === "Degraded"
      ? `${primary.name} is degraded by latency or error-rate thresholds.`
      : "No probable cause can be inferred from the current evidence sample.";

  const timeline = [
    ...errorTraces.slice(0, 5).map((record) => ({
      time: record.observed_at,
      type: "Failed trace",
      title: record.message,
      detail: `${record.service_name} · HTTP ${record.status_code ?? "error"} · ${formatDuration(record.duration_ms ?? 0)}`,
      tone: "critical",
    })),
    ...errorLogs.slice(0, 5).map((record) => ({
      time: record.observed_at,
      type: "Error log",
      title: record.message,
      detail: `${record.service_name} · ${record.environment}`,
      tone: "warning",
    })),
    ...k8sEvents.slice(0, 5).map((record) => ({
      time: record.observed_at,
      type: "Kubernetes event",
      title: record.message,
      detail: `${record.service_name} · ${String(record.attributes["k8s.pod.name"] ?? record.environment)}`,
      tone: "info",
    })),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 10);

  return <>
    <PageHeader eyebrow="INCIDENT COMMAND" title={hasIncident ? "Active investigation" : "No active incident"} description="Correlate failures, logs and Kubernetes evidence into one response workflow.">
      <span className={`pill ${hasIncident ? "critical" : "healthy"}`}>{hasIncident ? "SEV investigation" : "Healthy"}</span>
    </PageHeader>

    <section className="incident-hero">
      <div>
        <span className="incident-kicker">{hasIncident ? "SignalDeck detected material failure evidence" : "Telemetry is within current thresholds"}</span>
        <h2>{hasIncident ? `${primary?.name ?? "Application"} requires investigation` : "No immediate response required"}</h2>
        <p>{hasIncident ? likelyCause : "Continue ingesting traces, logs and Kubernetes events to detect and investigate future incidents."}</p>
      </div>
      <div className="incident-score">
        <small>Evidence</small><strong>{evidenceCount}</strong><span>{affected.length} affected services</span>
      </div>
    </section>

    <div className="incident-metrics">
      <article><span>Affected services</span><strong>{affected.length}</strong><small>{affected.map((service) => service.name).join(", ") || "None"}</small></article>
      <article><span>Failed traces</span><strong>{errorTraces.length}</strong><small>{overview.errorRate.toFixed(1)}% current error rate</small></article>
      <article><span>Slowest failure</span><strong>{slowestFailure ? formatDuration(slowestFailure.duration_ms ?? 0) : "—"}</strong><small>{slowestFailure?.message ?? "No failed trace"}</small></article>
      <article><span>Error logs</span><strong>{errorLogs.length}</strong><small>{k8sEvents.length} Kubernetes events</small></article>
    </div>

    <div className="incident-layout">
      <article className="panel incident-timeline">
        <div className="panel-title"><div><h2>Investigation timeline</h2><p>Newest correlated evidence first</p></div><span className="pill info">Live evidence</span></div>
        {timeline.length ? timeline.map((item, index) => <div className="timeline-item" key={`${item.time}-${index}`}>
          <div className={`timeline-marker ${item.tone}`} />
          <time>{new Date(item.time).toLocaleTimeString()}</time>
          <div><small>{item.type}</small><strong>{item.title}</strong><p>{item.detail}</p></div>
        </div>) : <div className="empty-state"><h2>No incident evidence yet</h2><p>Failed traces, error logs and Kubernetes events will appear here automatically.</p></div>}
      </article>

      <aside className="incident-side">
        <article className="panel finding-card">
          <div className="panel-title"><div><h2>Current finding</h2><p>Evidence-based, not an automated remediation</p></div></div>
          <strong>{likelyCause}</strong>
          <ul>
            <li>{primary ? `${primary.name}: ${primary.errorRate.toFixed(1)}% errors, P95 ${formatDuration(primary.p95)}` : "No affected service summary"}</li>
            <li>{errorLogs.length} related error logs are available for correlation.</li>
            <li>{k8sEvents.length ? `${k8sEvents.length} Kubernetes events may explain infrastructure impact.` : "No Kubernetes event evidence has been ingested."}</li>
          </ul>
        </article>

        <article className="panel action-card">
          <div className="panel-title"><div><h2>Next actions</h2><p>Recommended investigation sequence</p></div></div>
          {primary ? <>
            <Link className="response-action" href={`/services/${encodeURIComponent(primary.name)}?environment=${encodeURIComponent(primary.environment)}`}><span>1</span><div><strong>Inspect affected service</strong><small>Review its traces and correlated logs</small></div></Link>
            <Link className="response-action" href="/traces"><span>2</span><div><strong>Compare failed traces</strong><small>Find the common slow dependency</small></div></Link>
            <Link className="response-action" href="/kubernetes"><span>3</span><div><strong>Check workload health</strong><small>Review restarts, events and pod context</small></div></Link>
          </> : <Link className="response-action" href="/connect"><span>1</span><div><strong>Connect telemetry</strong><small>Deploy the collector to begin detection</small></div></Link>}
        </article>
      </aside>
    </div>
  </>;
}
