import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { formatDuration } from "@/lib/analytics";
import { readTelemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ service: string }>; searchParams: Promise<{ environment?: string }> };

function percentile(values: number[], value: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(value * sorted.length) - 1)];
}

export default async function ServiceDetail({ params, searchParams }: Props) {
  const { service } = await params;
  const { environment = "dev" } = await searchParams;
  const serviceName = decodeURIComponent(service);
  const records = await readTelemetry(500);
  const serviceRecords = records.filter((record) => record.service_name === serviceName && record.environment === environment);
  const traces = serviceRecords.filter((record) => record.signal_type === "trace");
  const logs = serviceRecords.filter((record) => record.signal_type === "log");
  const failures = traces.filter((record) => (record.status_code ?? 0) >= 500);
  const durations = traces.map((record) => record.duration_ms ?? 0).filter(Boolean);
  const errorRate = traces.length ? (failures.length / traces.length) * 100 : 0;
  const p95 = percentile(durations, 0.95);
  const status = errorRate >= 5 ? "Critical" : errorRate >= 1 || p95 >= 750 ? "Degraded" : "Healthy";

  return <>
    <PageHeader eyebrow="SERVICE" title={serviceName} description={`${environment} · live application telemetry`}>
      <span className={`pill ${status.toLowerCase()}`}>{status}</span>
      <Link className="button" href={`/traces?service=${encodeURIComponent(serviceName)}`}>View traces</Link>
    </PageHeader>

    <nav className="subnav"><a className="active" href="#overview">Overview</a><a href="#traces">Traces</a><a href="#logs">Logs</a><a href="#dependencies">Dependencies</a><a href="#kubernetes">Kubernetes</a></nav>

    <div className="metrics service-metrics" id="overview">
      <article><span>Requests</span><strong>{traces.length}</strong><small>in current sample</small></article>
      <article><span>Error rate</span><strong>{errorRate.toFixed(1)}%</strong><small>{failures.length} failed traces</small></article>
      <article><span>P95 latency</span><strong>{formatDuration(p95)}</strong><small>{durations.length} measured</small></article>
      <article><span>Logs</span><strong>{logs.length}</strong><small>{logs.filter((log) => log.severity === "ERROR").length} errors</small></article>
    </div>

    <div className="detail-grid">
      <article className="panel premium-panel" id="traces">
        <div className="panel-title"><div><h2>Recent traces</h2><p>Slow and failed requests for this service</p></div></div>
        {traces.length ? <div className="list">{traces.slice(0, 8).map((trace, index) => <div className="list-item" key={`${trace.trace_id}-${index}`}><div><strong>{trace.message}</strong><p>{trace.trace_id ?? "trace id unavailable"}</p></div><div><b>{formatDuration(trace.duration_ms ?? 0)}</b><span className={(trace.status_code ?? 0) >= 500 ? "bad-text" : "good-text"}>{trace.status_code ?? "—"}</span></div></div>)}</div> : <div className="empty-state compact"><p>No traces received for this service.</p></div>}
      </article>

      <article className="panel premium-panel" id="logs">
        <div className="panel-title"><div><h2>Related logs</h2><p>Logs correlated by service and environment</p></div></div>
        {logs.length ? <div className="logs compact-logs">{logs.slice(0, 8).map((log, index) => <div className="log-line" key={`${log.observed_at}-${index}`}><time>{new Date(log.observed_at).toLocaleTimeString()}</time><b className={log.severity === "ERROR" ? "bad-text" : "good-text"}>{log.severity ?? "INFO"}</b><span>{log.message}</span></div>)}</div> : <div className="empty-state compact"><p>No logs received for this service.</p></div>}
      </article>

      <article className="panel premium-panel" id="dependencies"><div className="panel-title"><div><h2>Dependencies</h2><p>Will be inferred automatically from parent/child spans</p></div></div><div className="dependency-empty"><span className="service-node">{serviceName}</span><span className="dependency-arrow">→</span><span className="ghost-node">Awaiting span relationships</span></div></article>
      <article className="panel premium-panel" id="kubernetes"><div className="panel-title"><div><h2>Kubernetes context</h2><p>Pod, namespace, deployment and cluster metadata</p></div></div><div className="attribute-grid"><span>Environment<strong>{environment}</strong></span><span>Namespace<strong>{String(serviceRecords[0]?.attributes?.["k8s.namespace.name"] ?? "not supplied")}</strong></span><span>Pod<strong>{String(serviceRecords[0]?.attributes?.["k8s.pod.name"] ?? "not supplied")}</strong></span><span>Cluster<strong>{String(serviceRecords[0]?.attributes?.["k8s.cluster.name"] ?? "not supplied")}</strong></span></div></article>
    </div>
  </>;
}
