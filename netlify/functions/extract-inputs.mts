import type { Context } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";

// Target shape matches buildClaudePrompt()'s schema in damo-estimator.html exactly,
// so a successful response here is already valid input to the app's existing
// deepMergeState(defaults(), json) apply path - no new merge logic needed there.
// Every leaf is nullable: the model is instructed to use null (never a guess) for
// anything it can't find evidence for, and stripNulls() below removes those nulls
// before responding, so deepMergeState leaves unfound fields at their app default
// - the same "omit what's unknown" contract the manual copy-paste flow already has.
// Nullable leaves use anyOf[type, null] rather than a type:[...,"null"] array -
// Anthropic's structured-outputs schema validator rejects an enum whose values
// are checked against an array-form "type" (confirmed live: 400 invalid_request_error,
// "Enum value 'low' does not match declared type ['string','null']"). anyOf is the
// documented-supported combinator and sidesteps that validator path entirely.
const nStr = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const nInt = { anyOf: [{ type: "integer" }, { type: "null" }] } as const;
const nNum = { anyOf: [{ type: "number" }, { type: "null" }] } as const;
const nBool = { anyOf: [{ type: "boolean" }, { type: "null" }] } as const;
const nEnum = (values: string[]) =>
  ({ anyOf: [{ type: "string", enum: values }, { type: "null" }] }) as const;

const mixObj = {
  type: "object",
  properties: { P1: nInt, P2: nInt, P3: nInt, P4: nInt },
  required: ["P1", "P2", "P3", "P4"],
  additionalProperties: false,
} as const;
const mixSchema = { anyOf: [mixObj, { type: "null" }] } as const;
const slaObj = {
  type: "object",
  properties: {
    P1r: nInt, P1x: nInt, P2r: nInt, P2x: nInt,
    P3r: nInt, P3x: nInt, P4r: nInt, P4x: nInt,
  },
  required: ["P1r", "P1x", "P2r", "P2x", "P3r", "P3x", "P4r", "P4x"],
  additionalProperties: false,
} as const;
const slaSchema = { anyOf: [slaObj, { type: "null" }] } as const;
const ownObj = {
  type: "object",
  properties: { L1: nStr, L2: nStr, L3: nStr },
  required: ["L1", "L2", "L3"],
  additionalProperties: false,
} as const;
const ownSchema = { anyOf: [ownObj, { type: "null" }] } as const;
const towerSchema = {
  type: "object",
  properties: {
    type: nEnum(["AMS", "IMS", "DMS"]),
    mode: nEnum(["history", "proxy", "mau"]),
    inc: nInt, sr: nInt,
    mix: mixSchema, sla: slaSchema,
    avail: nNum,
    coverage: nEnum(["8x5", "16x5", "24x5", "24x7"]),
    mau: nInt, own: ownSchema,
  },
  required: ["type", "mode", "inc", "sr", "mix", "sla", "avail", "coverage", "mau", "own"],
  additionalProperties: false,
};
const engObj = {
  type: "object",
  properties: {
    term: nInt,
    aiMaturity: nEnum(["low", "moderate"]),
    volumetrics: nEnum(["available", "unavailable"]),
    aiops: nBool,
    estate: nEnum(["modern", "legacy"]),
    region: nEnum(["ime", "eu", "apac", "na"]),
  },
  required: ["term", "aiMaturity", "volumetrics", "aiops", "estate", "region"],
  additionalProperties: false,
} as const;
const schema = {
  type: "object",
  properties: {
    docSummary: nStr,
    eng: { anyOf: [engObj, { type: "null" }] },
    towers: { type: "array", items: towerSchema },
  },
  required: ["docSummary", "eng", "towers"],
  additionalProperties: false,
};

// Recursively drop null leaves and empty/all-null containers, so the response
// only ever carries fields the model actually found evidence for.
function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) {
    const out = v.map(stripNulls).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const s = stripNulls(val);
      if (s !== undefined) out[k] = s;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v === null ? undefined : v;
}

const PROMPT_INSTRUCTIONS =
  "You are helping fill in a DAMO managed-services sizing tool. Read the RFP/document text below and " +
  "extract only what it actually supports. Use null for any field you can't find evidence for - never guess " +
  "or invent a plausible-sounding value. towers: one entry per service tower actually described " +
  "(type is one of AMS/IMS/DMS); if no towers are described, return an empty array. docSummary should be a " +
  "2-4 sentence narrative in your own words (scope, client context, what's being asked for), not copied " +
  "verbatim from the source - null if the text gives nothing to summarize.\n\nDocument text:\n";

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
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: PROMPT_INSTRUCTIONS + text.slice(0, 200000) }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return new Response(JSON.stringify({ error: "Model returned no text output" }), { status: 502 });
    }

    const parsed = JSON.parse(textBlock.text);
    const cleaned = stripNulls(parsed) ?? {};

    return new Response(
      JSON.stringify({
        json: cleaned,
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
