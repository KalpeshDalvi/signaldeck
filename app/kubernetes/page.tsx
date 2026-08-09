import { PageHeader } from "@/components/AppShell";
import { readTelemetry } from "@/lib/telemetry";

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

export default async function Kubernetes() {
  const records = await readTelemetry(500, "k8s_event");
  const pods = latestBy(
    records.filter((record) => record.attributes["k8s.kind"] === "Pod"),
    (record) => `${record.attributes["k8s.namespace.name"]}/${record.attributes["k8s.pod.name"] ?? record.attributes["k8s.object.name"]}`,
  );
  const deployments = latestBy(
    records.filter((record) => record.attributes["k8s.kind"] === "Deployment"),
    (record) => `${record.attributes["k8s.namespace.name"]}/${record.attributes["k8s.deployment.name"]}`,
  );
  const events = records.filter((record) => record.attributes["k8s.kind"] === "Event").slice(0, 30);
  const warningEvents = events.filter((record) => record.severity === "ERROR");
  const restartCount = pods.reduce((sum, record) => sum + num(record.attributes["k8s.pod.restart_count"]), 0);
  const unstablePods = pods.filter((record) => {
    const phase = String(record.attributes["k8s.pod.phase"] ?? "Unknown");
    const reason = String(record.attributes["k8s.pod.reason"] ?? "");
    return phase !== "Running" || ["CrashLoopBackOff", "OOMKilled", "Error"].includes(reason);
  });
  const clusterName = String(records[0]?.attributes["k8s.cluster.name"] ?? "No cluster connected");

  return <>
    <PageHeader eyebrow="GKE EVIDENCE" title="Kubernetes" description="Live workload state and Kubernetes events collected as incident evidence.">
      <span className={`pill ${records.length ? "healthy" : "warning"}`}>{clusterName}</span>
    </PageHeader>

    <div className="metrics">
      <article><span>Pods observed</span><strong>{pods.length}</strong><small>{unstablePods.length ? `${unstablePods.length} unstable` : "all observed pods stable"}</small></article>
      <article><span>Deployments</span><strong>{deployments.length}</strong><small>latest observed state</small></article>
      <article><span>Restarts</span><strong>{restartCount}</strong><small className={restartCount ? "bad" : ""}>across observed pods</small></article>
      <article><span>Warning events</span><strong>{warningEvents.length}</strong><small className={warningEvents.length ? "bad" : ""}>recent evidence</small></article>
      <article><span>Evidence records</span><strong>{records.length}</strong><small>latest 500</small></article>
    </div>

    {records.length ? <>
      <article className="panel">
        <div className="panel-title"><div><h2>Workload state</h2><p>Latest pod state received from the cluster</p></div></div>
        <div className="table">
          <div className="row kube-row heading"><span>Pod</span><span>Namespace</span><span>Status</span><span>Restarts</span><span>Reason</span></div>
          {pods.map((pod) => {
            const name = String(pod.attributes["k8s.pod.name"] ?? pod.attributes["k8s.object.name"] ?? "unknown");
            const namespace = String(pod.attributes["k8s.namespace.name"] ?? "unknown");
            const phase = String(pod.attributes["k8s.pod.phase"] ?? "Unknown");
            const reason = String(pod.attributes["k8s.pod.reason"] ?? "—");
            const unhealthy = phase !== "Running" || ["CrashLoopBackOff", "OOMKilled", "Error"].includes(reason);
            return <div className="row kube-row" key={`${namespace}/${name}`}><strong>{name}</strong><span>{namespace}</span><span className={unhealthy ? "bad-text" : "good-text"}>{phase}</span><span>{num(pod.attributes["k8s.pod.restart_count"])}</span><span>{reason}</span></div>;
          })}
        </div>
      </article>

      <div className="split">
        <article className="panel">
          <div className="panel-title"><div><h2>Deployments</h2><p>Observed desired versus ready replicas</p></div></div>
          <div className="list">
            {deployments.map((deployment) => {
              const desired = num(deployment.attributes["k8s.deployment.replicas"]);
              const ready = num(deployment.attributes["k8s.deployment.ready_replicas"]);
              return <div className="list-item" key={String(deployment.attributes["k8s.deployment.name"])}><div><strong>{String(deployment.attributes["k8s.deployment.name"] ?? deployment.service_name)}</strong><p>{String(deployment.attributes["k8s.namespace.name"] ?? deployment.environment)}</p></div><div><b className={ready < desired ? "bad-text" : "good-text"}>{ready}/{desired}</b><span>ready</span></div></div>;
            })}
          </div>
        </article>

        <article className="panel">
          <div className="panel-title"><div><h2>Recent Kubernetes events</h2><p>Warnings, scheduling, readiness, image and rollout evidence</p></div></div>
          <div className="list">
            {events.length ? events.map((event, index) => <div className="list-item" key={event.id ?? `${event.observed_at}-${index}`}><div><strong className={event.severity === "ERROR" ? "bad-text" : ""}>{event.message}</strong><p>{String(event.attributes["k8s.namespace.name"] ?? "cluster")} · {String(event.attributes["k8s.object.kind"] ?? "object")}/{String(event.attributes["k8s.object.name"] ?? event.service_name)}</p></div><div><span>{new Date(event.observed_at).toLocaleTimeString()}</span></div></div>) : <div className="empty-state"><p>No Kubernetes Event objects received yet.</p></div>}
          </div>
        </article>
      </div>
    </> : <article className="panel empty-state"><h2>No live Kubernetes evidence yet</h2><p>Deploy the Incident Lab collector to a GKE cluster. Pod, deployment, and event state will appear here automatically.</p></article>}
  </>;
}
