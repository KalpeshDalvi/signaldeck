import { PageHeader } from "@/components/AppShell";
import { readTelemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

export default async function Logs() {
  const logs = await readTelemetry(200, "log");

  return <>
    <PageHeader eyebrow="LOG MANAGEMENT" title="Logs" description="Structured application logs with service, environment, and trace context."><span className="pill healthy">{logs.length} records</span></PageHeader>
    <article className="panel">
      <div className="log-toolbar"><button>All levels</button><button>All services</button><button>Newest first</button></div>
      {logs.length ? <div className="logs">{logs.map((log, index) => {
        const level = (log.severity ?? "INFO").toUpperCase();
        return <div className="log-line" key={log.id ?? `${log.observed_at}-${index}`}><time>{new Date(log.observed_at).toLocaleTimeString()}</time><b className={level === "ERROR" ? "bad-text" : level === "WARN" ? "warn-text" : "good-text"}>{level}</b><strong>{log.service_name}</strong><span>{log.message}</span><code>{log.trace_id ? `trace=${log.trace_id}` : log.environment}</code></div>;
      })}</div> : <div className="empty-state"><h2>No logs received</h2><p>Send custom log events or configure the collector filelog receiver.</p></div>}
    </article>
  </>;
}
