import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { formatDuration, summarizeServices } from "@/lib/analytics";
import { correlateIncident } from "@/lib/incident-correlation";
import { readTelemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

export default async function CorrelationPage() {
  const records = await readTelemetry(500);
  const services = summarizeServices(records);
  const primary = services.find((service) => service.status !== "Healthy") ?? services[0];
  const finding = correlateIncident(records, primary);
  const failed = records.filter((r) => r.signal_type === "trace" && ((r.status_code ?? 0) >= 500 || r.severity?.toUpperCase() === "ERROR"));
  const kube = records.filter((r) => r.signal_type === "k8s_event");

  return <>
    <PageHeader eyebrow="CORRELATION ENGINE" title="Incident correlation" description="Connect application failures, dependencies, and Kubernetes evidence into one investigation path.">
      <span className={`pill ${finding?.confidence === "High" ? "critical" : finding?.confidence === "Medium" ? "warning" : "info"}`}>{finding ? `${finding.confidence} confidence · ${finding.score}%` : "Awaiting evidence"}</span>
    </PageHeader>

    {finding && primary ? <>
      <article className="panel cluster-overview">
        <div className="panel-title"><div><h2>Current hypothesis</h2><p>Evidence-backed correlation, not an asserted root cause</p></div></div>
        <h1 style={{fontSize: "24px"}}>{finding.summary}</h1>
        <div className="cluster-facts">
          <div><span>Affected service</span><strong>{finding.affectedService}</strong></div>
          <div><span>Dependency</span><strong>{finding.dependency ?? "Not proven"}</strong></div>
          <div><span>Pod</span><strong>{finding.pod ?? "No unhealthy pod"}</strong></div>
          <div><span>Workload</span><strong>{finding.workload ?? "Not identified"}</strong></div>
        </div>
      </article>

      <div className="metrics">
        <article><span>Error rate</span><strong>{primary.errorRate.toFixed(1)}%</strong><small className={primary.errorRate >= 2 ? "bad" : ""}>{primary.errors} failed requests</small></article>
        <article><span>P95 latency</span><strong>{formatDuration(primary.p95)}</strong><small className={primary.p95 >= 750 ? "bad" : ""}>{primary.status}</small></article>
        <article><span>Failed traces</span><strong>{failed.length}</strong><small>current evidence sample</small></article>
        <article><span>K8s evidence</span><strong>{kube.length}</strong><small>objects and events</small></article>
        <article><span>Confidence</span><strong>{finding.score}%</strong><small>{finding.confidence} correlation</small></article>
      </div>

      <div className="split">
        <article className="panel">
          <div className="panel-title"><div><h2>Evidence chain</h2><p>Why SignalDeck produced this hypothesis</p></div></div>
          <div className="list">
            {finding.evidenceSteps.map((step, index) => <div className="list-item" key={`${step.label}-${index}`}>
              <div style={{width: "100%"}}>
                <div style={{display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center"}}>
                  <strong>{index + 1}. {step.label}</strong>
                  <span className="pill info" style={{fontSize: "10px"}}>{step.source}</span>
                </div>
                <p style={{marginTop: "7px"}}>{step.detail}</p>
                {step.meta ? <small style={{display: "block", marginTop: "5px"}}>{step.meta}</small> : null}
              </div>
            </div>)}
          </div>
          <div style={{marginTop: "22px", paddingTop: "18px", borderTop: "1px solid var(--line)"}}>
            <div className="panel-title"><div><h2>Evidence coverage</h2><p>Independent signals supporting the current hypothesis</p></div><strong>{finding.coverage.filter((item) => item.present).length}/{finding.coverage.length}</strong></div>
            <div className="cluster-facts" style={{gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))"}}>
              {finding.coverage.map((item) => <div key={item.label}><span>{item.present ? "✓ " : "○ "}{item.label}</span><strong>{item.detail}</strong></div>)}
            </div>
          </div>
        </article>
        <article className="panel">
          <div className="panel-title"><div><h2>Investigation path</h2><p>Move from symptom to infrastructure evidence</p></div></div>
          <div className="list">
            <Link className="list-item row-link" href={`/services/${encodeURIComponent(primary.name)}?environment=${encodeURIComponent(primary.environment)}`}><div><strong>1. Affected service</strong><p>Inspect traces, logs, latency and errors for {primary.name}</p></div><span>→</span></Link>
            <Link className="list-item row-link" href="/traces"><div><strong>2. Trace path</strong><p>Compare failed requests and downstream spans</p></div><span>→</span></Link>
            <Link className="list-item row-link" href="/kubernetes"><div><strong>3. Kubernetes evidence</strong><p>Inspect pods, deployments, services and events</p></div><span>→</span></Link>
            <Link className="list-item row-link" href="/incidents"><div><strong>4. Incident command</strong><p>Validate the hypothesis against the incident timeline</p></div><span>→</span></Link>
          </div>
        </article>
      </div>
    </> : <article className="panel empty-state"><h2>Not enough telemetry to correlate</h2><p>SignalDeck needs application traces plus supporting Kubernetes or dependency evidence before it can build a useful hypothesis.</p></article>}
  </>;
}
