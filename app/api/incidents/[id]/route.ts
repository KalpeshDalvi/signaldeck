import { addIncidentNote, getIncident, updateIncident, type IncidentRecord, type IncidentSeverity, type IncidentStatus } from "@/lib/incidents";

const statuses: IncidentStatus[] = ["detected", "investigating", "mitigated", "resolved"];
const severities: IncidentSeverity[] = ["SEV-1", "SEV-2", "SEV-3"];
type IncidentPatch = Partial<Pick<IncidentRecord, "status" | "owner" | "severity" | "summary" | "notes">>;

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const incident = await getIncident(id);
  return incident ? Response.json({ incident }) : Response.json({ error: "Incident not found" }, { status: 404 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const patch: IncidentPatch = {};

    if (body.status !== undefined) {
      if (!statuses.includes(body.status)) return Response.json({ error: "Invalid status" }, { status: 400 });
      patch.status = body.status;
    }
    if (body.severity !== undefined) {
      if (!severities.includes(body.severity)) return Response.json({ error: "Invalid severity" }, { status: 400 });
      patch.severity = body.severity;
    }
    if (body.owner !== undefined) patch.owner = String(body.owner).trim() || null;
    if (body.summary !== undefined) patch.summary = String(body.summary).trim();

    const incident = await updateIncident(id, patch);
    return Response.json({ incident });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to update incident" }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const message = String(body.message ?? "").trim();
    if (!message) return Response.json({ error: "Note message is required" }, { status: 400 });
    const incident = await addIncidentNote(id, String(body.author ?? "Incident commander").trim(), message);
    return Response.json({ incident });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to add note" }, { status: 500 });
  }
}
