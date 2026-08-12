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

function buildPrompt(text: string): string {
  return "You are helping fill in a DAMO managed-services sizing tool. Read the RFP/document text below and return ONLY a JSON object " +
    "(no prose, no markdown fences) that matches this shape. Include every field you can support from the text; omit fields you " +
    "can't find evidence for rather than guessing - never invent a plausible-sounding value. towers[] entries must be COMPLETE " +
    "objects (every field shown in the example), one per service tower actually described (type is one of AMS/IMS/DMS); if no " +
    "towers are described, omit the towers key entirely. docSummary should be a short narrative in your own words, not copied " +
    "verbatim from the source; omit it if the text gives nothing to summarize.\n\n" +
    "Target schema (example values, not the answer):\n" + JSON.stringify(SCHEMA_EXAMPLE, null, 2) + "\n\n" +
    "Document text:\n" + text;
}

// Model replies are occasionally wrapped in ```json fences despite the "no
// markdown fences" instruction - strip them before parsing rather than failing.
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

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

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      messages: [{ role: "user", content: buildPrompt(text.slice(0, 200000)) }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return new Response(JSON.stringify({ error: "Model returned no text output" }), { status: 502 });
    }

    let parsed: unknown;
    try {
      parsed = extractJson(textBlock.text);
    } catch {
      return new Response(
        JSON.stringify({ error: "Model response wasn't valid JSON", raw: textBlock.text.slice(0, 500) }),
        { status: 502 },
      );
    }

    return new Response(
      JSON.stringify({
        json: parsed,
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed";
    return new Response(JSON.stringify({ error: message }), { status: 502 });
  }
};
