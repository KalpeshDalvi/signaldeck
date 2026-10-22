import { GoogleAuth } from "google-auth-library";

export type KubernetesAuditChange = {
  id: string;
  timestamp: string;
  method: string;
  principal: string;
  resource: string;
  requestedReplicas: number | null;
};
export type KubernetesAuditLookup =
  | { status: "available"; changes: KubernetesAuditChange[]; project: string }
  | { status: "permission_denied" | "unavailable" | "not_configured"; changes: []; project?: string };

type LogEntry = {
  insertId?: string;
  timestamp?: string;
  protoPayload?: {
    serviceName?: string;
    methodName?: string;
    resourceName?: string;
    authenticationInfo?: { principalEmail?: string };
    request?: unknown;
  };
};

function requestedReplicaCount(request: unknown): number | null {
  if (!request || typeof request !== "object") return null;
  const obj = request as Record<string, unknown>;
  const spec = obj.spec && typeof obj.spec === "object" ? obj.spec as Record<string, unknown> : undefined;
  // Audit bodies vary by method. Never infer a requested count from the method name.
  const raw = spec?.replicas ?? obj.replicas;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (!/^\d+$/.test(String(raw))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Read-only GKE API-server audit retrieval using the Cloud Run service identity.
 * Every query is bounded to a single namespace, Deployment and failure window.
 * No Kubernetes credentials or Cloud Logging API keys are stored in the app.
 */
export async function findGkeDeploymentChanges(input: {
  namespace: string;
  deployment: string;
  failureAt: string;
}): Promise<KubernetesAuditLookup> {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(input.namespace)
    || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(input.deployment)) {
    return { status: "not_configured", changes: [] };
  }
  const time = Date.parse(input.failureAt);
  if (!Number.isFinite(time) || time > Date.now() + 60_000 || time < Date.now() - 8 * 24 * 60 * 60_000) {
    return { status: "not_configured", changes: [] };
  }
  const start = new Date(time - 5 * 60_000).toISOString();
  const end = new Date(time + 5 * 60_000).toISOString();
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/logging.read"] });
  let project: string | undefined;
  try {
    project = process.env.SIGNALDECK_GCP_PROJECT_ID || await auth.getProjectId();
    if (!project || !/^[a-z0-9][a-z0-9-]{4,61}$/.test(project)) {
      return { status: "not_configured", changes: [] };
    }
    const cluster = process.env.SIGNALDECK_GKE_CLUSTER;
    const resourceName = `deployments/${input.deployment}`;
    const filter = [
      'resource.type="k8s_cluster"',
      'protoPayload.serviceName="k8s.io"',
      `protoPayload.resourceName:"${resourceName}"`,
      `protoPayload.resourceName:"namespaces/${input.namespace}/"`,
      'protoPayload.methodName:"deployments."',
      `timestamp>="${start}"`,
      `timestamp<="${end}"`,
      ...(cluster && /^[a-z0-9-]+$/.test(cluster) ? [`resource.labels.cluster_name="${cluster}"`] : []),
    ].join(" AND ");
    const token = await auth.getAccessToken();
    if (!token) return { status: "unavailable", changes: [], project };
    const response = await fetch("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceNames: [`projects/${project}`],
        filter,
        pageSize: 50,
        orderBy: "timestamp desc",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 403) return { status: "permission_denied", changes: [], project };
    if (!response.ok) {
      console.error("SignalDeck audit query failed", response.status);
      return { status: "unavailable", changes: [], project };
    }
    const body = await response.json() as { entries?: LogEntry[] };
    const changes = (body.entries ?? []).flatMap(entry => {
      const event = entry.protoPayload;
      if (!event || !entry.timestamp || !event.methodName || !event.resourceName) return [];
      // Defense-in-depth: do not trust a substring filter as the sole scope check.
      if (!event.resourceName.includes(`/namespaces/${input.namespace}/deployments/${input.deployment}`)) return [];
      return [{
        id: entry.insertId ?? `${entry.timestamp}:${event.methodName}`,
        timestamp: entry.timestamp,
        method: event.methodName,
        principal: event.authenticationInfo?.principalEmail ?? "Not recorded",
        resource: event.resourceName,
        requestedReplicas: requestedReplicaCount(event.request),
      }];
    }).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return { status: "available", changes, project };
  } catch (error) {
    console.error("SignalDeck audit lookup unavailable", error instanceof Error ? error.name : "unknown");
    return { status: "unavailable", changes: [], project };
  }
}
