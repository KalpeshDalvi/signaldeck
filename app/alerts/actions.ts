"use server";

import { redirect } from "next/navigation";
import { incidentPool } from "@/lib/incident-postgres";
import { acknowledgeInvestigation } from "@/lib/investigation-acknowledgements";

export async function acknowledgeAlert(form: FormData) {
  const id = form.get("investigationId");
  let outcome: "acknowledged" | "not_found" | "unavailable" = "unavailable";
  if (typeof id !== "string") {
    outcome = "not_found";
  } else {
    try {
      const db = incidentPool();
      if (db) outcome = await acknowledgeInvestigation(db, id);
    } catch (error) {
      console.error("Unable to acknowledge alert", error instanceof Error ? error.name : "");
    }
  }
  redirect(`/alerts?ack=${outcome}#incident-alerts`);
}
