"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IncidentRecord, IncidentStatus } from "@/lib/incidents";

const flow: IncidentStatus[] = ["detected", "investigating", "mitigated", "resolved"];

export default function IncidentControls({ incident }: { incident: IncidentRecord }) {
  const router = useRouter();
  const [owner, setOwner] = useState(incident.owner ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function patch(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const response = await fetch(`/api/incidents/${incident.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setError(data.error ?? "Update failed");
    router.refresh();
  }

  async function addNote() {
    if (!note.trim()) return;
    setBusy(true);
    setError("");
    const response = await fetch(`/api/incidents/${incident.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: owner || "Incident commander", message: note }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setError(data.error ?? "Unable to add note");
    setNote("");
    router.refresh();
  }

  return <article className="panel lifecycle-card">
    <div className="panel-title"><div><h2>Incident lifecycle</h2><p>Coordinate ownership, mitigation and resolution</p></div><span className={`pill lifecycle-${incident.status}`}>{incident.status}</span></div>

    <div className="lifecycle-flow">
      {flow.map((status, index) => {
        const activeIndex = flow.indexOf(incident.status);
        const completed = index <= activeIndex;
        return <button key={status} disabled={busy || status === incident.status} className={completed ? "completed" : ""} onClick={() => patch({ status })}>
          <span>{index + 1}</span><strong>{status}</strong>
        </button>;
      })}
    </div>

    <div className="incident-fields">
      <label><span>Incident owner</span><div><input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Assign incident commander"/><button disabled={busy} onClick={() => patch({ owner })}>Assign</button></div></label>
      <label><span>Severity</span><select value={incident.severity} disabled={busy} onChange={(event) => patch({ severity: event.target.value })}><option>SEV-1</option><option>SEV-2</option><option>SEV-3</option></select></label>
    </div>

    <div className="note-composer">
      <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add an investigation update, decision, or mitigation note..." />
      <button className="primary" disabled={busy || !note.trim()} onClick={addNote}>Add timeline note</button>
    </div>
    {error ? <p className="control-error">{error}</p> : null}
  </article>;
}
