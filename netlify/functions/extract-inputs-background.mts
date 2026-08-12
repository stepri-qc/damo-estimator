import type { Context } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";

// Background function (15-min execution limit, vs. the standard synchronous
// limit that killed the first two attempts at this feature). A real 23-page
// RFP (~32K chars) needed longer than that ceiling regardless of keep-alive
// bytes - a heartbeat only prevents an IDLE-connection timeout, it can't
// extend a hard duration cap. Background functions return 202 immediately and
// their return value is ignored, so there is no synchronous response channel
// back to the caller at all: every outcome (success or error) is written to a
// Blobs job record instead, and the frontend (extract-status.mts) polls for it.

const SCHEMA_EXAMPLE = {
  docSummary: "2-4 sentence plain-English narrative summary of the RFP/document set - scope, client context, what's being asked for.",
  eng: { term: 3, aiMaturity: "low", volumetrics: "available", aiops: true, estate: "modern", region: "ime" },
  towers: [{
    type: "AMS", mode: "history", inc: 180, sr: 70,
    mix: { P1: 4, P2: 16, P3: 50, P4: 30 },
    sla: { P1r: 15, P1x: 120, P2r: 30, P2x: 480, P3r: 240, P3x: 2880, P4r: 480, P4x: 5760 },
    avail: 99.5, coverage: "16x5", mau: 50000, own: { L1: "us", L2: "us", L3: "us" },
  }],
};

// Several fields are closed enums in the app's own UI (segmented controls with
// exactly these options, e.g. seg("eng.aiMaturity",[["low",...],["moderate",...]])
// at damo-estimator.html:2566) - a value outside this set has no selected button
// to render and can break string-compare logic downstream (scenarioOf(), etc).
// A single example value in the schema isn't enough to keep the model inside that
// set (confirmed live: "AI/automation heavily" produced aiMaturity:"high", which
// the app doesn't recognize) - each constrained field's full allowed set is
// spelled out explicitly below rather than relying on the example to imply it.
const ALLOWED_VALUES =
  "Allowed values - use ONLY these for the listed fields, never a value outside this set (map close-but-different language, e.g. " +
  "\"aggressive automation\" or \"heavy AI use\", onto the nearest allowed value rather than inventing a new one like \"high\"):\n" +
  "- eng.term: 1, 3, or 5 (years) - round to the nearest of these\n" +
  "- eng.aiMaturity: \"low\" or \"moderate\" only\n" +
  "- eng.volumetrics: \"available\" or \"unavailable\"\n" +
  "- eng.estate: \"modern\" or \"legacy\"\n" +
  "- eng.region: \"ime\", \"eu\", \"apac\", or \"na\"\n" +
  "- towers[].type: \"AMS\", \"IMS\", or \"DMS\"\n" +
  "- towers[].mode: \"history\" (real incident/ticket counts given), \"proxy\" (only app counts/sizes given, no ticket volume), or \"mau\" (only active-user counts given)\n" +
  "- towers[].coverage: \"8x5\", \"16x5\", \"24x5\", or \"24x7\"\n";

function buildPrompt(text: string): string {
  return "You are helping fill in a DAMO managed-services sizing tool. Read the RFP/document text below and return ONLY a JSON object " +
    "(no prose, no markdown fences) that matches this shape. Include every field you can support from the text; omit fields you " +
    "can't find evidence for rather than guessing - never invent a plausible-sounding value, and never use a value outside an " +
    "allowed set (below) even if the text suggests something more specific. towers[] entries must be COMPLETE objects (every " +
    "field shown in the example), one per service tower actually described; if no towers are described, omit the towers key " +
    "entirely. docSummary should be a short narrative in your own words, not copied verbatim from the source; omit it if the " +
    "text gives nothing to summarize.\n\n" +
    "Target schema (example values, not the answer):\n" + JSON.stringify(SCHEMA_EXAMPLE, null, 2) + "\n\n" +
    ALLOWED_VALUES + "\n" +
    "Document text:\n" + text;
}

// Defense-in-depth beyond the prompt instructions above: drop any enum field
// that still lands outside the app's actual allowed set (rather than reject the
// whole response) so a single model slip degrades to "field omitted, app default
// kept" instead of a bad value flowing silently into deepMergeState.
const ENUM_FIELDS: Record<string, readonly string[]> = {
  aiMaturity: ["low", "moderate"],
  volumetrics: ["available", "unavailable"],
  estate: ["modern", "legacy"],
  region: ["ime", "eu", "apac", "na"],
  type: ["AMS", "IMS", "DMS"],
  mode: ["history", "proxy", "mau"],
  coverage: ["8x5", "16x5", "24x5", "24x7"],
};
function sanitizeExtraction(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sanitizeExtraction);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "term" && typeof val === "number") {
        out.term = [1, 3, 5].reduce((best, t) => (Math.abs(t - val) < Math.abs(best - val) ? t : best));
        continue;
      }
      if (k in ENUM_FIELDS) {
        if (typeof val === "string" && (ENUM_FIELDS[k] as string[]).includes(val)) out[k] = val;
        continue; // invalid enum value -> field omitted, app default kept
      }
      out[k] = sanitizeExtraction(val);
    }
    return out;
  }
  return v;
}

// Model replies are occasionally wrapped in ```json fences despite the "no
// markdown fences" instruction - strip them before parsing rather than failing.
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function jobStore() {
  return getStore({ name: "damo-extraction-jobs", consistency: "strong" });
}

export default async (req: Request, context: Context) => {
  let body: { jobId?: string; text?: string; passphrase?: string };
  try {
    body = await req.json();
  } catch {
    return; // no jobId to report against; nothing more we can do
  }

  const jobId = body.jobId;
  if (!jobId) return;
  const store = jobStore();

  const configuredPassphrase = Netlify.env.get("INTAKE_PASSPHRASE");
  if (configuredPassphrase && body.passphrase !== configuredPassphrase) {
    await store.setJSON(jobId, { status: "error", error: "Incorrect passphrase" });
    return;
  }

  const text = (body.text || "").trim();
  if (!text) {
    await store.setJSON(jobId, { status: "error", error: "No document text provided" });
    return;
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    await store.setJSON(jobId, { status: "error", error: "Server is not configured with an Anthropic API key" });
    return;
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 6000,
      messages: [{ role: "user", content: buildPrompt(text.slice(0, 200000)) }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      await store.setJSON(jobId, { status: "error", error: "Model returned no text output" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = extractJson(textBlock.text);
    } catch {
      await store.setJSON(jobId, {
        status: "error",
        error: "Model response wasn't valid JSON",
        raw: textBlock.text.slice(0, 500),
      });
      return;
    }

    await store.setJSON(jobId, {
      status: "done",
      json: sanitizeExtraction(parsed),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    });
  } catch (err) {
    await store.setJSON(jobId, { status: "error", error: err instanceof Error ? err.message : "Extraction failed" });
  }
};
