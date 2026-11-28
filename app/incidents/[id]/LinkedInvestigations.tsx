import Link from "next/link";
import { listIncidentInvestigationIds } from "@/lib/incident-investigation-links";
import type { IncidentRecord } from "@/lib/incidents";
import { attachInvestigation, verifyIncidentRecovery } from "./actions";

const feedback: Record<string, string> = {
  linked: "Investigation linked.",
  invalid: "Enter a saved investigation ID for this service and environment.",
  conflict: "This investigation is already linked to another incident.",
  unavailable: "The investigation link could not be saved.",
};

const recoveryFeedback: Record<string, string> = {
  recorded: "Recovery check saved to responder notes.",
  no_match: "No matching successful server span was found in the recent sample.",
  already_checked: "The check was already saved or the incident status changed.",
  unavailable: "Recovery evidence is unavailable.",
};

export async function LinkedInvestigations({ incident, outcome, recovery }: {
  incident: IncidentRecord;
  outcome?: string;
  recovery?: string;
}) {
  let ids: string[] | null = null;
  try {
    ids = await listIncidentInvestigationIds(incident.id);
  } catch (error) {
    console.error("Unable to retrieve linked investigations", error instanceof Error ? error.name : "");
  }

  return <section className="panel" id="linked-investigations" aria-labelledby="linked-investigations-title">
    <div className="panel-title">
      <h2 id="linked-investigations-title">Linked investigations</h2>
      <Link href="/investigations">Browse saved investigations</Link>
    </div>
    {outcome && Object.hasOwn(feedback, outcome) && <p role="status">{feedback[outcome]}</p>}
    {recovery && Object.hasOwn(recoveryFeedback, recovery) && <p role="status">{recoveryFeedback[recovery]}</p>}
    {!ids ? <p>Investigation linking is unavailable.</p> : <>
      {ids.length === 0 ? <p>No saved investigations are linked to this incident.</p> : <ul>
        {ids.map(id => <li key={id}><Link href={`/investigations/${id}`}>Saved investigation {id}</Link></li>)}
      </ul>}
      <form className="incident-fields" action={attachInvestigation.bind(null, incident.id)}>
        <label><span>Saved investigation ID</span><div>
          <input name="investigationId" required maxLength={36} />
          <button type="submit">Link investigation</button>
        </div></label>
      </form>
      {incident.status === "mitigated" && ids.length > 0 && <form className="incident-fields"
        action={verifyIncidentRecovery.bind(null, incident.id)}>
        <label><span>Investigation to validate</span>
          <select name="investigationId" required>
            {ids.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label><span>Successful trace ID from the last hour</span><div>
          <input name="traceId" required maxLength={32} />
          <button type="submit">Verify recovery</button>
        </div></label>
      </form>}
    </>}
  </section>;
}
