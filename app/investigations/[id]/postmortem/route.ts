import { getArchivedInvestigation } from "@/lib/investigation-archive";
import { investigationPostmortem } from "@/lib/investigation-postmortem";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getArchivedInvestigation(id);
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (result.status !== "ok") {
    const missing = result.status === "not_found";
    return new Response(missing ? "Investigation not found" : "Investigation archive unavailable", {
      status: missing ? 404 : 503,
      headers,
    });
  }

  const { investigation, evidence } = result.data;
  return new Response(investigationPostmortem(investigation, evidence), {
    headers: {
      ...headers,
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="signaldeck-postmortem-${id}.md"`,
    },
  });
}
