import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { formatDuration, summarizeOverview, summarizeServices } from "@/lib/analytics";
import { correlateDeployments } from "@/lib/change-correlation";
import { correlateIncident } from "@/lib/incident-correlation";
import { ensureIncident } from "@/lib/incidents";
import { readTelemetry } from "@/lib/telemetry";
import { formatCentralDateTime, formatCentralTime } from "@/lib/time";
import IncidentControls from "./IncidentControls";
import "./incidents.css";

export const dynamic = "force-dynamic";

function isError(record: Awaited<ReturnType<typeof readTelemetry>>[number]) {
  return (record.status_code ?? 0) >= 500 || record.severity?.toUpperCase() === "ERROR";
}

function signed(value: number, suffix: string) {
  if (!value) return `0${suffix}`;
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}${suffix}`;
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
  const correlation = correlateIncident(records, primary);
  const slowestFailure = [...errorTraces].sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))[0];
  const deploymentEvidence = primary ? correlateDeployments(records, primary.name, primary.environment) : [];
  const correlatedDeployment = deploymentEvidence.find((deployment) => deployment.minutesBeforeFailure !== null && deployment.minutesBeforeFailure >= 0 && deployment.minutesBeforeFailure <= 30) ?? deploymentEvidence[0];
  const evidenceCount = errorTraces.length + errorLogs.length + k8sEvents.length + deploymentEvidence.length;
  const hasIncident = overview.activeAlerts > 0 || errorTraces.length > 0 || errorLogs.length > 0;
  const deploymentFinding = correlatedDeployment?.minutesBeforeFailure !== null && correlatedDeployment?.minutesBeforeFailure !== undefined && correlatedDeployment.minutesBeforeFailure >= 0
    ? `Deployment ${correlatedDeployment.version} preceded the first failure by ${correlatedDeployment.minutesBeforeFailure} minute${correlatedDeployment.minutesBeforeFailure === 1 ? "" : "s"}.`
    : null;
  const likelyCause = correlation && correlation.score >= 50
    ? correlation.summary
    : deploymentFinding
      ? `${deploymentFinding} Error rate changed ${signed(correlatedDeployment.errorRateDelta, "%")} and P95 changed ${signed(correlatedDeployment.p95Delta, " ms")} after deployment.`
      : slowestFailure
        ? `${slowestFailure.service_name} has the slowest failed request at ${formatDuration(slowestFailure.duration_ms ?? 0)}.`
        : primary?.status === "Degraded"
          ? `${primary.name} is degraded by latency or error-rate thresholds.`
          : "No probable cause can be inferred from the current evidence sample.";

  const incident = hasIncident && primary ? await ensureIncident({
    workspace_id: process.env.SIGNALDECK_WORKSPACE_ID ?? "billpay",
    title: `${primary.name} ${primary.environment} failure`,
    service_name: primary.name,
    environment: primary.environment,
    severity: primary.status === "Critical" ? "SEV-1" : "SEV-2",
    summary: likelyCause,
  }) : null;

  const telemetryTimeline = [
    ...deploymentEvidence.slice(0, 5).map((deployment) => ({ time: deployment.record.observed_at, type: "Deployment", title: `${deployment.record.service_name} ${deployment.version}`, detail: [deployment.image, deployment.commitSha ? `commit ${deployment.commitSha.slice(0, 8)}` : null, deployment.actor ? `by ${deployment.actor}` : null].filter(Boolean).join(" · ") || deployment.record.message, tone: "deployment" })),
    ...errorTraces.slice(0, 5).map((record) => ({ time: record.observed_at, type: "Failed trace", title: record.message, detail: `${record.service_name} · HTTP ${record.status_code ?? "error"} · ${formatDuration(record.duration_ms ?? 0)}`, tone: "critical" })),
    ...errorLogs.slice(0, 5).map((record) => ({ time: record.observed_at, type: "Error log", title: record.message, detail: `${record.service_name} · ${record.environment}`, tone: "warning" })),
    ...k8sEvents.slice(0, 5).map((record) => ({ time: record.observed_at, type: "Kubernetes event", title: record.message, detail: `${record.service_name} · ${String(record.attributes["k8s.pod.name"] ?? record.environment)}`, tone: "info" })),
  ];
  const noteTimeline = (incident?.notes ?? []).map((note) => ({ time: note.created_at, type: "Commander note", title: note.message, detail: `Added by ${note.author}`, tone: "note" }));
  const timeline = [...telemetryTimeline, ...noteTimeline].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 20);

  return <>
    <PageHeader eyebrow="INCIDENT COMMAND" title={incident ? incident.title : "No active incident"} description="Correlate failures, changes, response activity, and the operational record.">{incident ? <><span className={`pill lifecycle-${incident.status}`}>{incident.status}</span><span className="pill critical">{incident.severity}</span></> : <span className="pill healthy">Healthy</span>}</PageHeader>
    <section className="incident-hero"><div><span className="incident-kicker">{incident ? `Incident ${incident.id.slice(0, 8)} · ${incident.status}` : "Telemetry is within current thresholds"}</span><h2>{incident ? `${primary?.name} requires coordinated response` : "No immediate response required"}</h2><p>{incident ? incident.summary : "Continue ingesting traces, logs, deployment changes, and Kubernetes events to detect future incidents."}</p>{incident ? <div className="incident-meta"><span>Started {formatCentralDateTime(incident.started_at)}</span><span>Owner: {incident.owner ?? "Unassigned"}</span><span>{incident.environment}</span></div> : null}</div><div className="incident-score"><small>Evidence</small><strong>{evidenceCount}</strong><span>{affected.length} affected services</span></div></section>
    {incident ? <IncidentControls incident={incident} /> : null}
    <div className="incident-metrics"><article><span>Affected services</span><strong>{affected.length}</strong><small>{affected.map((service) => service.name).join(", ") || "None"}</small></article><article><span>Failed traces</span><strong>{errorTraces.length}</strong><small>{overview.errorRate.toFixed(1)}% current error rate</small></article><article><span>Slowest failure</span><strong>{slowestFailure ? formatDuration(slowestFailure.duration_ms ?? 0) : "—"}</strong><small>{slowestFailure?.message ?? "No failed trace"}</small></article><article><span>Correlation</span><strong>{correlation ? `${correlation.score}%` : "—"}</strong><small>{correlation ? `${correlation.confidence} confidence` : "No correlation finding"}</small></article></div>
    {correlatedDeployment ? <article className="panel change-evidence"><div className="panel-title"><div><h2>What changed?</h2><p>Deployment evidence correlated with the current failure window</p></div><span className="pill warning">{correlatedDeployment.confidence}% confidence</span></div><div className="change-grid"><div><small>Deployment</small><strong>{correlatedDeployment.version}</strong><span>{correlatedDeployment.previousVersion ? `from ${correlatedDeployment.previousVersion}` : "previous version unavailable"}</span></div><div><small>Timing</small><strong>{correlatedDeployment.minutesBeforeFailure !== null ? `${correlatedDeployment.minutesBeforeFailure} min before failure` : "No failure timing"}</strong><span>{formatCentralDateTime(correlatedDeployment.record.observed_at)}</span></div><div><small>Error-rate change</small><strong className={correlatedDeployment.errorRateDelta > 0 ? "bad-text" : "good-text"}>{signed(correlatedDeployment.errorRateDelta, "%")}</strong><span>{correlatedDeployment.before.errorRate.toFixed(1)}% → {correlatedDeployment.after.errorRate.toFixed(1)}%</span></div><div><small>P95 change</small><strong className={correlatedDeployment.p95Delta > 0 ? "bad-text" : "good-text"}>{signed(correlatedDeployment.p95Delta, " ms")}</strong><span>{formatDuration(correlatedDeployment.before.p95)} → {formatDuration(correlatedDeployment.after.p95)}</span></div></div><div className="change-meta"><span>Image: {correlatedDeployment.image ?? "not supplied"}</span><span>Commit: {correlatedDeployment.commitSha ?? "not supplied"}</span><span>Actor: {correlatedDeployment.actor ?? "not supplied"}</span></div></article> : null}
    <div className="incident-layout"><article className="panel incident-timeline"><div className="panel-title"><div><h2>Investigation timeline</h2><p>Deployment changes, telemetry evidence, and human decisions · US Central Time</p></div><span className="pill info">Live record</span></div>{timeline.length ? timeline.map((item, index) => <div className="timeline-item" key={`${item.time}-${index}`}><div className={`timeline-marker ${item.tone}`} /><time>{formatCentralTime(item.time)}</time><div><small>{item.type}</small><strong>{item.title}</strong><p>{item.detail}</p></div></div>) : <div className="empty-state"><h2>No incident evidence yet</h2><p>Failed traces, logs, deployment changes, and Kubernetes events will appear here automatically.</p></div>}</article><aside className="incident-side"><article className="panel finding-card"><div className="panel-title"><div><h2>Current finding</h2><p>Correlation is a hypothesis until responders confirm it</p></div></div><strong>{likelyCause}</strong><ul><li>{primary ? `${primary.name}: ${primary.errorRate.toFixed(1)}% errors, P95 ${formatDuration(primary.p95)}` : "No affected service summary"}</li><li>{correlation?.dependency ? `Downstream dependency: ${correlation.dependency}.` : "No downstream dependency proven yet."}</li><li>{correlation?.workload ? `Kubernetes workload: ${correlation.workload}.` : k8sEvents.length ? `${k8sEvents.length} Kubernetes evidence records are available.` : "No Kubernetes event evidence has been ingested."}</li></ul></article><article className="panel action-card"><div className="panel-title"><div><h2>Next actions</h2><p>Recommended investigation sequence</p></div></div>{primary ? <><Link className="response-action" href={`/services/${encodeURIComponent(primary.name)}?environment=${encodeURIComponent(primary.environment)}`}><span>1</span><div><strong>Inspect affected service</strong><small>Review traces and correlated logs</small></div></Link><Link className="response-action" href="/traces"><span>2</span><div><strong>Compare failed traces</strong><small>Find the common slow dependency</small></div></Link><Link className="response-action" href="/kubernetes"><span>3</span><div><strong>Validate Kubernetes impact</strong><small>Check workload availability, pods, services, and events</small></div></Link></> : <Link className="response-action" href="/connect"><span>1</span><div><strong>Connect telemetry</strong><small>Deploy the collector to begin detection</small></div></Link>}</article></aside></div>
  </>;
}
