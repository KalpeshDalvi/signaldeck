import { PageHeader } from "@/components/AppShell";
import { readTelemetry } from "@/lib/telemetry";
import { formatCentralTime } from "@/lib/time";

export const dynamic = "force-dynamic";

type KubeRecord = Awaited<ReturnType<typeof readTelemetry>>[number];

function latestBy(records: KubeRecord[], key: (record: KubeRecord) => string) {
  const seen = new Map<string, KubeRecord>();
  for (const record of [...records].sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime())) {
    const id = key(record);
    if (!seen.has(id)) seen.set(id, record);
  }
  return [...seen.values()];
}

function num(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function portsLabel(value: unknown) {
  if (!Array.isArray(value)) return "—";
  return value.map((port) => {
    if (!port || typeof port !== "object") return String(port);
    const item = port as Record<string, unknown>;
    return `${String(item.port ?? "?")}/${String(item.protocol ?? "TCP")}`;
  }).join(", ") || "—";
}

function podHealthy(pod: KubeRecord) {
  const phase = String(pod.attributes["k8s.pod.phase"] ?? "Unknown");
  const reason = String(pod.attributes["k8s.pod.reason"] ?? "");
  return phase === "Running" && !["CrashLoopBackOff", "OOMKilled", "Error"].includes(reason);
}

export default async function Kubernetes() {
  const records = await readTelemetry(500, "k8s_event");
  const pods = latestBy(records.filter((record) => record.attributes["k8s.kind"] === "Pod"), (record) => `${record.attributes["k8s.namespace.name"]}/${record.attributes["k8s.pod.name"] ?? record.attributes["k8s.object.name"]}`);
  const deployments = latestBy(records.filter((record) => record.attributes["k8s.kind"] === "Deployment"), (record) => `${record.attributes["k8s.namespace.name"]}/${record.attributes["k8s.deployment.name"]}`);
  const services = latestBy(records.filter((record) => record.attributes["k8s.kind"] === "Service"), (record) => `${record.attributes["k8s.namespace.name"]}/${record.attributes["k8s.service.name"] ?? record.attributes["k8s.object.name"]}`);
  const events = records.filter((record) => record.attributes["k8s.kind"] === "Event").slice(0, 30);
  const warningEvents = events.filter((record) => record.severity === "ERROR");
  const restartCount = pods.reduce((sum, record) => sum + num(record.attributes["k8s.pod.restart_count"]), 0);
  const unstablePods = pods.filter((record) => !podHealthy(record));
  const clusterName = String(records[0]?.attributes["k8s.cluster.name"] ?? "No cluster connected");
  const provider = String(records[0]?.attributes["cloud.provider"] ?? "unknown").toUpperCase();
  const environment = String(records[0]?.environment ?? "unknown");
  const namespaces = [...new Set([...pods, ...deployments, ...services].map((record) => String(record.attributes["k8s.namespace.name"] ?? "unknown")))].sort();

  const podState = new Map(pods.map((pod) => [String(pod.attributes["k8s.pod.name"] ?? pod.attributes["k8s.object.name"] ?? ""), pod]));
  const deploymentState = new Map(deployments.map((deployment) => [String(deployment.attributes["k8s.deployment.name"] ?? deployment.service_name), deployment]));

  function eventIsCurrentlyActive(event: KubeRecord) {
    if (event.severity !== "ERROR") return false;
    const kind = String(event.attributes["k8s.object.kind"] ?? "");
    const name = String(event.attributes["k8s.object.name"] ?? event.service_name ?? "");
    if (kind === "Pod") {
      const pod = podState.get(name);
      return pod ? !podHealthy(pod) : false;
    }
    if (kind === "Deployment") {
      const deployment = deploymentState.get(name);
      if (!deployment) return false;
      return num(deployment.attributes["k8s.deployment.ready_replicas"]) < num(deployment.attributes["k8s.deployment.replicas"]);
    }
    return false;
  }

  return <>
    <PageHeader eyebrow="GKE EVIDENCE" title="Kubernetes" description="Live cluster topology, current workload state, Services, and Kubernetes event history."><span className={`pill ${records.length ? "healthy" : "warning"}`}>{clusterName}</span></PageHeader>
    <article className="panel cluster-overview"><div className="panel-title"><div><h2>Connected cluster</h2><p>Cluster identity derived from the live OpenTelemetry resource context</p></div></div><div className="cluster-facts"><div><span>Cluster</span><strong>{clusterName}</strong></div><div><span>Provider</span><strong>{provider}</strong></div><div><span>Environment</span><strong>{environment}</strong></div><div><span>Namespaces</span><strong>{namespaces.length ? namespaces.join(", ") : "—"}</strong></div></div></article>
    <div className="metrics"><article><span>Pods observed</span><strong>{pods.length}</strong><small>{unstablePods.length ? `${unstablePods.length} currently unstable` : "all observed pods currently stable"}</small></article><article><span>Deployments</span><strong>{deployments.length}</strong><small>current observed state</small></article><article><span>Services</span><strong>{services.length}</strong><small>live Kubernetes Service objects</small></article><article><span>Restarts</span><strong>{restartCount}</strong><small className={restartCount ? "bad" : ""}>across current pods</small></article><article><span>Event history</span><strong>{events.length}</strong><small>{warningEvents.length} warning/error records retained</small></article></div>
    {records.length ? <>
      <article className="panel"><div className="panel-title"><div><h2>Current pod state</h2><p>Latest state received for each pod · historical events do not change this status</p></div><span className={`pill ${unstablePods.length ? "critical" : "healthy"}`}>{unstablePods.length ? `${unstablePods.length} unstable` : "Healthy now"}</span></div><div className="table"><div className="row kube-row heading"><span>Pod</span><span>Namespace</span><span>Status</span><span>Restarts</span><span>Reason</span></div>{pods.map((pod) => { const name = String(pod.attributes["k8s.pod.name"] ?? pod.attributes["k8s.object.name"] ?? "unknown"); const namespace = String(pod.attributes["k8s.namespace.name"] ?? "unknown"); const phase = String(pod.attributes["k8s.pod.phase"] ?? "Unknown"); const reason = String(pod.attributes["k8s.pod.reason"] ?? "—"); const healthy = podHealthy(pod); return <a className="row kube-row row-link" href={`/kubernetes/pods/${encodeURIComponent(name)}?namespace=${encodeURIComponent(namespace)}`} key={`${namespace}/${name}`}><strong>{name}</strong><span>{namespace}</span><span className={healthy ? "good-text" : "bad-text"}>{phase}</span><span>{num(pod.attributes["k8s.pod.restart_count"])}</span><span>{reason}</span></a>; })}</div></article>
      <article className="panel"><div className="panel-title"><div><h2>Kubernetes Services</h2><p>Actual Service objects discovered from {clusterName}</p></div></div>{services.length ? <div className="table"><div className="row kube-service-row heading"><span>Service</span><span>Namespace</span><span>Type</span><span>Cluster IP</span><span>Ports</span></div>{services.map((service) => { const name = String(service.attributes["k8s.service.name"] ?? service.attributes["k8s.object.name"] ?? service.service_name); const namespace = String(service.attributes["k8s.namespace.name"] ?? "unknown"); return <div className="row kube-service-row" key={`${namespace}/${name}`}><strong>{name}</strong><span>{namespace}</span><span>{String(service.attributes["k8s.service.type"] ?? "ClusterIP")}</span><code>{String(service.attributes["k8s.service.cluster_ip"] ?? "—")}</code><span>{portsLabel(service.attributes["k8s.service.ports"])}</span></div>; })}</div> : <div className="empty-state"><p>No Kubernetes Service objects received yet.</p></div>}</article>
      <div className="split"><article className="panel"><div className="panel-title"><div><h2>Current deployment state</h2><p>Latest desired versus ready replicas — this is the source of truth for current health</p></div></div><div className="list">{deployments.map((deployment) => { const desired = num(deployment.attributes["k8s.deployment.replicas"]); const ready = num(deployment.attributes["k8s.deployment.ready_replicas"]); const healthy = ready >= desired; return <div className="list-item" key={String(deployment.attributes["k8s.deployment.name"])}><div><strong>{String(deployment.attributes["k8s.deployment.name"] ?? deployment.service_name)}</strong><p>{String(deployment.attributes["k8s.namespace.name"] ?? deployment.environment)}</p></div><div><b className={healthy ? "good-text" : "bad-text"}>{ready}/{desired}</b><span className={healthy ? "good-text" : "bad-text"}>{healthy ? "Healthy" : "Degraded"}</span></div></div>; })}</div></article><article className="panel"><div className="panel-title"><div><h2>Recent event history</h2><p>Historical Kubernetes evidence · US Central Time · red only when the related object is currently unhealthy</p></div></div><div className="list">{events.length ? events.map((event, index) => { const active = eventIsCurrentlyActive(event); const wasWarning = event.severity === "ERROR"; return <div className="list-item" key={event.id ?? `${event.observed_at}-${index}`}><div><strong className={active ? "bad-text" : wasWarning ? "warn-text" : ""}>{event.message}</strong><p>{String(event.attributes["k8s.namespace.name"] ?? "cluster")} · {String(event.attributes["k8s.object.kind"] ?? "object")}/{String(event.attributes["k8s.object.name"] ?? event.service_name)} · {active ? "CURRENT WARNING" : wasWarning ? "HISTORICAL WARNING" : "HISTORY"}</p></div><div><span>{formatCentralTime(event.observed_at)}</span></div></div>; }) : <div className="empty-state"><p>No Kubernetes Event objects received yet.</p></div>}</div></article></div>
    </> : <article className="panel empty-state"><h2>No live Kubernetes evidence yet</h2><p>Deploy the Incident Lab collector to a GKE cluster. Pod, deployment, Service, and event state will appear here automatically.</p></article>}
  </>;
}
