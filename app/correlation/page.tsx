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
  const displayScore = finding ? Math.min(finding.score, 95) : 0;

  return <>
    <PageHeader eyebrow="CORRELATION ENGINE" title="Incident correlation" description="Connect application failures, dependencies, and Kubernetes evidence into one investigation path.">
      <span className={`pill ${finding?.confidence === "High" ? "critical" : finding?.confidence === "Medium" ? "warning" : "info"}`}>{finding ? `${finding.confidence} confidence · ${displayScore}%` : "Awaiting evidence"}</span>
    </PageHeader>

    {finding && primary ? <>
      <article className="panel cluster-overview">
        <div className="panel-title"><div><h2>Current hypothesis</h2><p>Evidence-backed correlation, not an asserted root cause</p></div></div>
        <h1 style={{fontSize: "24px"}}>{finding.summary}</h1>
        <div className="cluster-facts">
          <div><span>Impacted service</span><strong>{finding.affectedService}</strong></div>
          <div><span>Suspected root dependency</span><strong>{finding.dependency ?? "Not proven"}</strong></div>
          <div><span>Pod evidence</span><strong>{finding.pod ?? "No unhealthy pod"}</strong></div>
          <div><span>Failing workload</span><strong>{finding.workload ?? "Not identified"}</strong></div>
        </div>
      </article>

      <div className="metrics">
        <article><span>Error rate</span><strong>{primary.errorRate.toFixed(1)}%</strong><small className={primary.errorRate >= 2 ? "bad" : ""}>{primary.errors} failed requests</small></article>
        <article><span>P95 latency</span><strong>{formatDuration(primary.p95)}</strong><small className={primary.p95 >= 750 ? "bad" : ""}>{primary.status}</small></article>
        <article><span>Failed traces</span><strong>{failed.length}</strong><small>current evidence sample</small></article>
        <article><span>K8s evidence</span><strong>{kube.length}</strong><small>objects and events</small></article>
        <article><span>Confidence</span><strong>{displayScore}%</strong><small>{finding.confidence} correlation · unconfirmed</small></article>
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
          <div className="panel-title"><div><h2>Investigation path</h2><p>Move from user impact to the suspected root dependency</p></div></div>
          <div className="list">
            <Link className="list-item row-link" href={`/services/${encodeURIComponent(primary.name)}?environment=${encodeURIComponent(primary.environment)}`}><div><strong>1. Impacted service</strong><p>Inspect traces, logs, latency and errors for {primary.name}</p></div><span>→</span></Link>
            <Link className="list-item row-link" href="/traces"><div><strong>2. Dependency trace path</strong><p>Follow failed requests from {primary.name}{finding.dependency ? ` to ${finding.dependency}` : " into downstream services"}</p></div><span>→</span></Link>
            <Link className="list-item row-link" href="/kubernetes"><div><strong>3. Suspected failing workload</strong><p>Validate {finding.workload ?? finding.dependency ?? "the downstream workload"} against Kubernetes deployments, services, pods and events</p></div><span>→</span></Link>
            <Link className="list-item row-link" href="/incidents"><div><strong>4. Incident command</strong><p>Confirm or reject the suspected root cause against the incident timeline</p></div><span>→</span></Link>
          </div>
        </article>
      </div>
    </> : <article className="panel empty-state"><h2>Not enough telemetry to correlate</h2><p>SignalDeck needs application traces plus supporting Kubernetes or dependency evidence before it can build a useful hypothesis.</p></article>}
  </>;
}
