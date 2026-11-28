"use server";

import { notFound, redirect } from "next/navigation";
import { getArchivedInvestigation } from "@/lib/investigation-archive";
import { linkIncidentInvestigation } from "@/lib/incident-investigation-links";
import { getIncident, recordIncidentRecovery } from "@/lib/incidents";
import { getInvestigationIncidentId } from "@/lib/incident-investigation-links";
import { verifyRecoveryProbe } from "@/lib/incident-recovery";
import { readTelemetry } from "@/lib/telemetry";

export async function attachInvestigation(incidentId: string, form: FormData) {
  const incident = await getIncident(incidentId);
  if (!incident) notFound();

  const archiveId = form.get("investigationId");
  let outcome = "invalid";
  if (typeof archiveId === "string") {
    const archive = await getArchivedInvestigation(archiveId.trim());
    if (archive.status === "unavailable" || archive.status === "not_configured") outcome = "unavailable";
    if (archive.status === "ok") {
      const { investigation } = archive.data;
      if (investigation.impacted_service === incident.service_name && investigation.environment === incident.environment) {
        try {
          outcome = await linkIncidentInvestigation(incident.id, investigation.id);
        } catch (error) {
          console.error("Unable to link investigation", error instanceof Error ? error.name : "");
          outcome = "unavailable";
        }
      }
    }
  }
  redirect(`/incidents/${incident.id}?link=${outcome}#linked-investigations`);
}

export async function verifyIncidentRecovery(incidentId: string, form: FormData) {
  const incident = await getIncident(incidentId);
  if (!incident) notFound();
  const traceId = form.get("traceId");
  const archiveId = form.get("investigationId");
  let outcome = "no_match";

  if (incident.status === "mitigated" && typeof traceId === "string" && /^[0-9a-f]{32}$/i.test(traceId.trim()) &&
      typeof archiveId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(archiveId)) {
    try {
      if (await getInvestigationIncidentId(archiveId) === incident.id) {
        const archive = await getArchivedInvestigation(archiveId);
        if (archive.status !== "ok") {
          outcome = "unavailable";
        } else {
          const traces = await readTelemetry(500, "trace", undefined, "applications", {
            service: incident.service_name, minutes: 60,
          });
          const validation = verifyRecoveryProbe(incident, archiveId, archive.data.evidence, traces, traceId.trim().toLowerCase());
          if (validation) {
            outcome = await recordIncidentRecovery(incident.id, validation) ? "recorded" : "already_checked";
          }
        }
      }
    } catch (error) {
      console.error("Unable to validate recovery", error instanceof Error ? error.name : "");
      outcome = "unavailable";
    }
  }
  redirect(`/incidents/${incident.id}?recovery=${outcome}#linked-investigations`);
}
