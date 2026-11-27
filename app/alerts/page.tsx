import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/AppShell";
import { readTelemetry } from "@/lib/telemetry";
import { formatCentralDateTime } from "@/lib/time";
import { IncidentAlerts } from "./IncidentAlerts";
import "./alerts.css";

export const dynamic = "force-dynamic";

export default async function Alerts({ searchParams }: { searchParams: Promise<{ ack?: string }> }) {
  const { ack } = await searchParams;
  return <>
    <PageHeader eyebrow="INCIDENT RESPONSE" title="Alerts" description="Review and acknowledge archived failures." />
    <section className="panel incident-alerts" id="incident-alerts" aria-labelledby="incident-alerts-title">
      <div className="panel-title"><div>
        <h2 id="incident-alerts-title">Incident alerts</h2>
        <p>Acknowledgements are shared within this workspace.</p>
      </div><Link href="/investigations">All saved investigations</Link></div>
      <Suspense fallback={<p role="status">Loading incident alerts…</p>}>
        <IncidentAlerts outcome={ack} />
      </Suspense>
    </section>
    <section className="panel" aria-labelledby="recent-errors-title">
      <div className="panel-title"><div>
        <h2 id="recent-errors-title">Recent error signals</h2>
        <p>Last 30 minutes from the latest 500 telemetry records.</p>
      </div></div>
      <Suspense fallback={<p role="status">Loading recent error signals…</p>}>
        <RecentErrors />
      </Suspense>
    </section>
  </>;
}

async function RecentErrors() {
  const records = await readTelemetry(500);
  const cutoff = Date.now() - 30 * 60 * 1000;
  const recent = records.filter((r) => new Date(r.observed_at).getTime() >= cutoff);
  const grouped = new Map<string, {service: string; environment: string; errors: number; traces: number; lastSeen: string; example: string}>();
  for (const r of recent) {
    if (r.signal_type !== "trace" && r.signal_type !== "k8s_event" && r.signal_type !== "log") continue;
    const key = r.service_name + "|" + r.environment;
    const state = grouped.get(key) ?? {service:r.service_name,environment:r.environment,errors:0,traces:0,lastSeen:r.observed_at,example:""};
    const error = (r.status_code ?? 0) >= 500 || r.severity?.toUpperCase() === "ERROR";
    if (r.signal_type === "trace") state.traces++;
    if (error) { state.errors++; state.example = r.message; }
    if (r.observed_at > state.lastSeen) state.lastSeen = r.observed_at;
    grouped.set(key,state);
  }
  const alerts = [...grouped.values()].filter((x) => x.errors > 0).sort((a,b) => b.errors-a.errors);
  return <div className="list">
      {alerts.length ? alerts.map((a) => <div className="alert-card" key={a.service+"|"+a.environment}>
        <span className="pill critical">Error</span>
        <div><strong>{a.service} · {a.errors} error signal{a.errors === 1 ? "" : "s"}</strong>
          <p>{a.environment} · {a.example || "Recent error observed"} · Last seen {formatCentralDateTime(a.lastSeen)}</p>
        </div>
        <Link href={`/services/${encodeURIComponent(a.service)}?environment=${encodeURIComponent(a.environment)}`}>Investigate →</Link>
      </div>) : <div className="empty-state"><h2>No recent errors in the sampled telemetry</h2><p>No matching error signals were found in the current data window.</p></div>}
    </div>;
}
