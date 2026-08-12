import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Polled by the frontend after kicking off extract-inputs-background - see that
// file for why this is a background+poll pair rather than one synchronous call.
export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) {
    return new Response(JSON.stringify({ error: "Missing jobId" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const store = getStore({ name: "damo-extraction-jobs", consistency: "strong" });
  const result = await store.get(jobId, { type: "json" });

  return new Response(JSON.stringify(result || { status: "pending" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
