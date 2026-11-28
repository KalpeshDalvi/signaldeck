import { addIncidentNote, getIncident, IncidentNotFoundError, updateIncident, type IncidentPatch, type IncidentSeverity, type IncidentStatus } from "@/lib/incidents";

const statuses: IncidentStatus[] = ["detected", "investigating", "mitigated", "resolved"];
const severities: IncidentSeverity[] = ["SEV-1", "SEV-2", "SEV-3"];

function mutationError(error: unknown, message: string) {
  if (error instanceof IncidentNotFoundError) return Response.json({ error: error.message }, { status: 404 });
  console.error(message, error instanceof Error ? error.name : "");
  return Response.json({ error: message }, { status: 500 });
}

async function readMutation(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Expected application/json" }, { status: 415 });
  }
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid JSON object" }, { status: 400 });
  }
  return body as Record<string, unknown>;
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const incident = await getIncident(id);
  return incident ? Response.json({ incident }) : Response.json({ error: "Incident not found" }, { status: 404 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await readMutation(request);
    if (body instanceof Response) return body;
    const patch: IncidentPatch = {};

    if (body.status !== undefined) {
      if (!statuses.includes(body.status as IncidentStatus)) return Response.json({ error: "Invalid status" }, { status: 400 });
      patch.status = body.status as IncidentStatus;
    }
    if (body.severity !== undefined) {
      if (!severities.includes(body.severity as IncidentSeverity)) return Response.json({ error: "Invalid severity" }, { status: 400 });
      patch.severity = body.severity as IncidentSeverity;
    }
    if (body.owner !== undefined) patch.owner = String(body.owner ?? "").trim() || null;
    if (body.summary !== undefined) patch.summary = String(body.summary).trim();

    const incident = await updateIncident(id, patch);
    return Response.json({ incident });
  } catch (error) {
    return mutationError(error, "Unable to update incident");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await readMutation(request);
    if (body instanceof Response) return body;
    const message = String(body.message ?? "").trim();
    if (!message) return Response.json({ error: "Note message is required" }, { status: 400 });
    const incident = await addIncidentNote(id, String(body.author ?? "Incident commander").trim(), message);
    return Response.json({ incident });
  } catch (error) {
    return mutationError(error, "Unable to add note");
  }
}
