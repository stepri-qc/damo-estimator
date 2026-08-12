import type { Context } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";

// Target shape matches buildClaudePrompt()'s schema in damo-estimator.html exactly,
// so a successful response here is already valid input to the app's existing
// deepMergeState(defaults(), json) apply path - no new merge logic needed there.
//
// This deliberately does NOT use output_config.format (structured outputs).
// Two things were tried and rejected live before landing here:
//   1. type:["string","null"] + enum -> 400 "Enum value does not match declared type"
//   2. anyOf[{type,enum},{type:"null"}] per leaf, to make every field individually
//      omittable -> 400 "too many parameters with union types (33, limit 16) -
//      exponential compilation cost"
// The full schema (eng's 6 fields + towers[]'s ~19 fields across type/mode/mix/
// sla/own) needs more independently-nullable leaves than that budget allows.
// Rather than collapse nullability to coarse object-level only (which would force
// the model to guess values for individual fields it isn't sure about whenever it
// includes an object at all), this uses the same plain-prompt approach the
// existing manual copy-paste flow (buildClaudePrompt()) already relies on: prose
// instructions asking for JSON with per-field omission, parsed server-side. No
// schema union-count limit applies to plain prompting.
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

// Everything before this marker in the streamed body is just keep-alive filler
// (the frontend discards it); everything after is the one JSON result payload.
const RESULT_MARKER = "\n__DAMO_RESULT__";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  let body: { text?: string; passphrase?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const configuredPassphrase = Netlify.env.get("INTAKE_PASSPHRASE");
  if (configuredPassphrase && body.passphrase !== configuredPassphrase) {
    return new Response(JSON.stringify({ error: "Incorrect passphrase" }), { status: 401 });
  }

  const text = (body.text || "").trim();
  if (!text) {
    return new Response(JSON.stringify({ error: "No document text provided" }), { status: 400 });
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Server is not configured with an Anthropic API key" }),
      { status: 500 },
    );
  }

  // A real multi-page RFP (confirmed live: 23 pages / ~32K chars) can push
  // Claude's response time past Netlify's proxy inactivity timeout - a 504
  // "Inactivity Timeout... too much time has passed without sending any data"
  // after ~30s, even though the function itself was still working. That's an
  // IDLE-connection timeout, not a hard duration cap, so the fix is to keep
  // bytes flowing to the client throughout the generation rather than
  // buffering the whole response before sending anything. The stream body is
  // plain keep-alive filler up to RESULT_MARKER, then one JSON payload.
  const encoder = new TextEncoder();
  const client = new Anthropic({ apiKey });

  const responseStream = new ReadableStream({
    async start(controller) {
      const finish = (payload: object) => {
        controller.enqueue(encoder.encode(RESULT_MARKER + JSON.stringify(payload)));
        controller.close();
      };
      try {
        const anthropicStream = client.messages.stream({
          model: "claude-sonnet-5",
          max_tokens: 6000,
          messages: [{ role: "user", content: buildPrompt(text.slice(0, 200000)) }],
        });
        for await (const event of anthropicStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            controller.enqueue(encoder.encode(".")); // keep-alive only, not parsed by the client
          }
        }
        const finalMessage = await anthropicStream.finalMessage();

        const textBlock = finalMessage.content.find((b) => b.type === "text");
        if (!textBlock || textBlock.type !== "text") {
          finish({ error: "Model returned no text output" });
          return;
        }

        let parsed: unknown;
        try {
          parsed = extractJson(textBlock.text);
        } catch {
          finish({ error: "Model response wasn't valid JSON", raw: textBlock.text.slice(0, 500) });
          return;
        }

        finish({
          json: sanitizeExtraction(parsed),
          usage: {
            input_tokens: finalMessage.usage.input_tokens,
            output_tokens: finalMessage.usage.output_tokens,
          },
        });
      } catch (err) {
        finish({ error: err instanceof Error ? err.message : "Extraction failed" });
      }
    },
  });

  return new Response(responseStream, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
