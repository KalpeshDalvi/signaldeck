import Link from "next/link";
import { PageHeader } from "@/components/AppShell";
import { readTelemetry } from "@/lib/telemetry";
import { formatCentralDateTime } from "@/lib/time";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ pod: string }>; searchParams: Promise<{ namespace?: string }> };
type RecordItem = Awaited<ReturnType<typeof readTelemetry>>[number];

function latest(records: RecordItem[]) {
  return [...records].sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime())[0];
}

function num(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default async function PodDetail({ params, searchParams }: Props) {
  const { pod } = await params;
  const { namespace = "signaldeck-lab" } = await searchParams;
  const podName = decodeURIComponent(pod);
  const records = await readTelemetry(1000, "k8s_event");
  const podRecords = records.filter((record) => record.attributes["k8s.kind"] === "Pod" && String(record.attributes["k8s.pod.name"] ?? record.attributes["k8s.object.name"]) === podName && String(record.attributes["k8s.namespace.name"] ?? "") === namespace);
  const current = latest(podRecords);
  const workload = String(current?.attributes["k8s.workload.name"] ?? podName.split("-").slice(0, -2).join("-") ?? "unknown");
  const cluster = String(current?.attributes["k8s.cluster.name"] ?? "unknown");
  const node = String(current?.attributes["k8s.node.name"] ?? "unknown");
  const podIp = String(current?.attributes["k8s.pod.ip"] ?? "—");
  const phase = String(current?.attributes["k8s.pod.phase"] ?? "Unknown");
  const reason = String(current?.attributes["k8s.pod.reason"] ?? "—");
  const restarts = num(current?.attributes["k8s.pod.restart_count"]);
  const deployment = latest(records.filter((record) => record.attributes["k8s.kind"] === "Deployment" && String(record.attributes["k8s.namespace.name"] ?? "") === namespace && String(record.attributes["k8s.deployment.name"] ?? record.service_name) === workload));
  const service = latest(records.filter((record) => record.attributes["k8s.kind"] === "Service" && String(record.attributes["k8s.namespace.name"] ?? "") === namespace && String(record.attributes["k8s.service.name"] ?? record.service_name) === workload));
  const relatedEvents = records.filter((record) => {
    if (record.attributes["k8s.kind"] !== "Event") return false;
    if (String(record.attributes["k8s.namespace.name"] ?? "") !== namespace) return false;
    const objectName = String(record.attributes["k8s.object.name"] ?? record.service_name ?? "");
    return objectName === podName || objectName === workload || record.message.includes(podName) || record.message.includes(workload);
  }).slice(0, 30);
  const healthy = phase === "Running" && !["CrashLoopBackOff", "OOMKilled", "Error"].includes(reason);
  const desired = num(deployment?.attributes["k8s.deployment.replicas"]);
  const ready = num(deployment?.attributes["k8s.deployment.ready_replicas"]);
  const serviceIp = String(service?.attributes["k8s.service.cluster_ip"] ?? "—");

  return <>
    <PageHeader eyebrow="KUBERNETES POD" title={podName} description={`${namespace} · ${cluster}`}><span className={`pill ${healthy ? "healthy" : "critical"}`}>{phase}</span><Link className="button" href="/kubernetes">Back to cluster</Link></PageHeader>
    <div className="metrics"><article><span>Status</span><strong>{phase}</strong><small className={healthy ? "" : "bad"}>{reason === "—" ? "healthy" : reason}</small></article><article><span>Restarts</span><strong>{restarts}</strong><small className={restarts ? "bad" : ""}>container restarts</small></article><article><span>Pod IP</span><strong style={{fontSize: "16px"}}>{podIp}</strong><small>live pod address</small></article><article><span>Deployment</span><strong style={{fontSize: "16px"}}>{workload}</strong><small>{deployment ? `${ready}/${desired} ready` : "not observed"}</small></article><article><span>Service</span><strong style={{fontSize: "16px"}}>{service ? workload : "—"}</strong><small>{service ? serviceIp : "not observed"}</small></article></div>
    <article className="panel"><div className="panel-title"><div><h2>Topology map</h2><p>Relationship inferred from live Kubernetes object evidence</p></div></div><div className="kube-topology"><div className="topology-node"><small>Cluster</small><strong>{cluster}</strong></div><span className="topology-arrow">→</span><div className="topology-node"><small>Namespace</small><strong>{namespace}</strong></div><span className="topology-arrow">→</span><div className="topology-node"><small>Deployment</small><strong>{workload}</strong><em>{deployment ? `${ready}/${desired} ready` : "not observed"}</em></div><span className="topology-arrow">→</span><div className="topology-node"><small>Service</small><strong>{service ? workload : "—"}</strong><em>{service ? serviceIp : "not observed"}</em></div><span className="topology-arrow">→</span><div className={`topology-node ${healthy ? "topology-live" : "topology-bad"}`}><small>Pod</small><strong>{podName}</strong><em>{node}</em></div></div></article>
    <div className="split" style={{marginTop: 14}}><article className="panel"><div className="panel-title"><div><h2>Pod context</h2><p>Latest observed Kubernetes state</p></div></div><div className="attribute-grid"><span>Cluster<strong>{cluster}</strong></span><span>Namespace<strong>{namespace}</strong></span><span>Node<strong>{node}</strong></span><span>Pod IP<strong>{podIp}</strong></span><span>Workload<strong>{workload}</strong></span><span>Watch type<strong>{String(current?.attributes["k8s.watch.type"] ?? "—")}</strong></span></div>{workload && <Link className="text-link" href={`/services/${encodeURIComponent(workload)}?environment=${encodeURIComponent(String(current?.environment ?? "lab"))}`}>Open application service →</Link>}</article><article className="panel"><div className="panel-title"><div><h2>Related Kubernetes events</h2><p>Scheduling, rollout, readiness, image and runtime evidence · US Central Time</p></div></div><div className="list">{relatedEvents.length ? relatedEvents.map((event, index) => <div className="list-item" key={event.id ?? `${event.observed_at}-${index}`}><div><strong className={event.severity === "ERROR" ? "bad-text" : ""}>{event.message}</strong><p>{String(event.attributes["k8s.event.reason"] ?? event.attributes["k8s.watch.type"] ?? "Kubernetes event")}</p></div><div><span>{formatCentralDateTime(event.observed_at)}</span></div></div>) : <div className="empty-state compact"><p>No Kubernetes Event objects correlated to this pod or its workload yet.</p></div>}</div></article></div>
  </>;
}
