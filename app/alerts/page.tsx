import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { readTelemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

export default async function Alerts() {
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
  return <>
    <PageHeader eyebrow="INCIDENT RESPONSE" title="Alerts" description="Evidence-based recent failures from the latest 30 minutes of available telemetry.">
      <span className={alerts.length ? "pill warning" : "pill healthy"}>{alerts.length} service{alerts.length === 1 ? "" : "s"} with errors</span>
    </PageHeader>
    <article className="panel" style={{marginBottom:16}}>
      <p>These are observed error signals, not configured notification rules. Results are limited to the latest 500 telemetry records and may not represent all failures in the time window.</p>
    </article>
    <div className="list panel">
      {alerts.length ? alerts.map((a) => <div className="alert-card" key={a.service+"|"+a.environment}>
        <span className="pill critical">Error</span>
        <div><strong>{a.service} · {a.errors} error signal{a.errors === 1 ? "" : "s"}</strong>
          <p>{a.environment} · {a.example || "Recent error observed"} · Last seen {new Date(a.lastSeen).toLocaleString()}</p>
        </div>
        <Link href={`/services/${encodeURIComponent(a.service)}?environment=${encodeURIComponent(a.environment)}`}>Investigate →</Link>
      </div>) : <div className="empty-state"><h2>No recent errors in the sampled telemetry</h2><p>No matching error signals were found in the current data window.</p></div>}
    </div>
  </>;
}
