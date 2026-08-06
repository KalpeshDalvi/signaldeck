import { NextResponse } from "next/server";
import { readTelemetry, saveTelemetry, SignalType, TelemetryRecord, verifyIngestionKey } from "../../../lib/telemetry";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const type = url.searchParams.get("type") as SignalType | null;

  try {
    const records = await readTelemetry(limit, type ?? undefined);
    return NextResponse.json({ records, count: records.length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Query failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!verifyIngestionKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const input = Array.isArray(body.events) ? body.events : [body];
    const now = new Date().toISOString();
    const records: TelemetryRecord[] = input.map((event: Partial<TelemetryRecord>) => ({
      workspace_id: event.workspace_id ?? "default",
      signal_type: event.signal_type ?? "log",
      service_name: event.service_name ?? "unknown-service",
      environment: event.environment ?? "unknown",
      severity: event.severity,
      message: event.message ?? "",
      trace_id: event.trace_id,
      span_id: event.span_id,
      duration_ms: event.duration_ms,
      status_code: event.status_code,
      attributes: event.attributes ?? {},
      observed_at: event.observed_at ?? now,
    }));

    const result = await saveTelemetry(records);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Ingestion failed" }, { status: 400 });
  }
}
