import { NextResponse } from "next/server";
import { normalizeOtlpTraces } from "../../../../../lib/otlp";
import { saveTelemetry, verifyIngestionKey } from "../../../../../lib/telemetry";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!verifyIngestionKey(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const payload = await request.json();
    const records = normalizeOtlpTraces(payload);
    const result = await saveTelemetry(records);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid OTLP traces";
    console.error("SignalDeck OTLP traces ingestion failed", { message, stack: error instanceof Error ? error.stack : undefined });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
