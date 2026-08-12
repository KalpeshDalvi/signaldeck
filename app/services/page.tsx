import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { formatDuration, formatRate, summarizeServices } from "@/lib/analytics";
import { readTelemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

type Record = Awaited<ReturnType<typeof readTelemetry>>[number];

function latestKubernetesServices(records: Record[]) {
  const seen = new Map<string, Record>();
  for (const record of [...records].sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime())) {
    if (record.attributes["k8s.kind"] !== "Service") continue;
    const name = String(record.attributes["k8s.service.name"] ?? record.attributes["k8s.object.name"] ?? record.service_name);
    const key = `${record.environment}:${name}`;
    if (!seen.has(key)) seen.set(key, record);
  }
  return seen;
}

export default async function Services() {
  const [traceRecords, kubeRecords] = await Promise.all([
    readTelemetry(500, "trace"),
    readTelemetry(500, "k8s_event"),
  ]);
  const services = summarizeServices(traceRecords);
  const kubeServices = latestKubernetesServices(kubeRecords);
  const clusterNames = [...new Set([...kubeServices.values()].map((record) => String(record.attributes["k8s.cluster.name"] ?? "unknown")))];

  return <>
    <PageHeader eyebrow="APM + KUBERNETES" title="Services" description="Golden signals from real traces, enriched with live Kubernetes Service discovery.">
      <span className="pill healthy">{services.length} discovered{clusterNames.length ? ` · ${clusterNames.join(", ")}` : ""}</span>
    </PageHeader>
    <article className="panel premium-panel">
      {services.length ? <div className="table">
        <div className="row service-catalog-row heading"><span>Service</span><span>Status</span><span>Kubernetes</span><span>Namespace</span><span>Requests</span><span>Error rate</span><span>P95</span></div>
        {services.map((service) => {
          const kube = kubeServices.get(`${service.environment}:${service.name}`);
          const namespace = kube ? String(kube.attributes["k8s.namespace.name"] ?? "—") : "—";
          const cluster = kube ? String(kube.attributes["k8s.cluster.name"] ?? "—") : "Not linked";
          const serviceType = kube ? String(kube.attributes["k8s.service.type"] ?? "Service") : "Trace only";
          return <Link className="row row-link service-catalog-row" href={`/services/${encodeURIComponent(service.name)}?environment=${encodeURIComponent(service.environment)}`} key={`${service.environment}-${service.name}`}>
            <strong>{service.name}</strong>
            <span className={`pill ${service.status.toLowerCase()}`}>{service.status}</span>
            <span><b>{serviceType}</b><small>{cluster}</small></span>
            <span>{namespace}</span>
            <span>{formatRate(service.requestRate)}/min</span>
            <span>{service.errorRate.toFixed(1)}%</span>
            <span>{formatDuration(service.p95)}</span>
          </Link>;
        })}
      </div> : <div className="empty-state"><h2>No services discovered</h2><p>Ingest trace events with a <code>service_name</code> to populate this catalog.</p></div>}
    </article>
  </>;
}
