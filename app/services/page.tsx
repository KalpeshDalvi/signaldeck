import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { formatDuration, formatRate, summarizeServices } from "@/lib/analytics";
import { readTelemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

export default async function Services() {
  const records = await readTelemetry(500);
  const services = summarizeServices(records);

  return <>
    <PageHeader eyebrow="APM" title="Services" description="Golden signals calculated from ingested distributed traces."><span className="pill healthy">{services.length} discovered</span></PageHeader>
    <article className="panel premium-panel">
      {services.length ? <div className="table">
        <div className="row heading"><span>Service</span><span>Status</span><span>Requests</span><span>Error rate</span><span>P95</span></div>
        {services.map((service) => <Link className="row row-link" href={`/services/${encodeURIComponent(service.name)}?environment=${encodeURIComponent(service.environment)}`} key={`${service.environment}-${service.name}`}><strong>{service.name}</strong><span className={`pill ${service.status.toLowerCase()}`}>{service.status}</span><span>{formatRate(service.requestRate)}/min</span><span>{service.errorRate.toFixed(1)}%</span><span>{formatDuration(service.p95)}</span></Link>)}
      </div> : <div className="empty-state"><h2>No services discovered</h2><p>Ingest trace events with a <code>service_name</code> to populate this catalog.</p></div>}
    </article>
  </>;
}
