import { NextResponse } from "next/server";
import { normalizeOtlpMetrics } from "../../../../../lib/otlp";
import { saveTelemetry, verifyIngestionKey } from "../../../../../lib/telemetry";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!verifyIngestionKey(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const records = normalizeOtlpMetrics(await request.json());
    const result = await saveTelemetry(records);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid OTLP metrics" }, { status: 400 });
  }
}
