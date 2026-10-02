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
  "docSummary": "2-4 sentence plain-English narrative summary of the document set - scope, client context, what is being asked for, and any assumptions you made.",
  "eng": {
    "term": 3,
    "aiMaturity": "low",
    "volumetrics": "available",
    "aiops": true,
    "estate": "modern",
    "engagementType": "brownfield",
    "complexity": "medium",
    "region": "apac",
    "locMix": {
      "apac": {
        "china": 0,
        "australia": 0,
        "singapore": 100
      }
    },
    "pass12": 70,
    "pass23": 20,
    "incumbentFTE": 40
  },
  "towers": [
    {
      "label": "short name of what this tower covers, e.g. eServices (21 services)",
      "type": "AMS",
      "mode": "history",
      "inc": 180,
      "sr": 70,
      "cr": 20,
      "mix": {
        "P1": 4,
        "P2": 16,
        "P3": 50,
        "P4": 30
      },
      "srMix": {
        "low": 60,
        "medium": 30,
        "high": 10
      },
      "crMix": {
        "low": 50,
        "medium": 35,
        "high": 15
      },
      "sla": {
        "P1r": 15,
        "P1x": 120,
        "P2r": 30,
        "P2x": 480,
        "P3r": 240,
        "P3x": 2880,
        "P4r": 480,
        "P4x": 5760
      },
      "avail": 99.5,
      "coverage": "16x5",
      "mau": 50000,
      "own": {
        "L1": "us",
        "L2": "us",
        "L3": "us"
      }
    }
  ],
  "opportunities": [
    {
      "name": "short name of a separate automation/improvement effort",
      "note": "one line: current effort, volume, pain point"
    }
  ],
  "evidence": [
    {
      "path": "towers.0.inc",
      "value": 60,
      "quote": "exact words copied from the document",
      "basis": "stated"
    }
  ],
  "warnings": [
    "anything the user should check: conflicts, suspect figures, assumptions, things you could not determine"
  ]
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
  "Allowed values - use ONLY these for the listed fields, never a value outside this set (map close-but-different language onto the nearest allowed value rather than inventing a new one like \"high\" for aiMaturity):\n" +
  "- eng.term: 1, 2, 3, 4, or 5 (years) - round to the nearest of these\n" +
  "- eng.aiMaturity: \"low\" or \"moderate\" only\n" +
  "- eng.volumetrics: \"available\" or \"unavailable\"\n" +
  "- eng.estate: \"modern\" or \"legacy\"\n" +
  "- eng.engagementType: \"greenfield\" or \"brownfield\"\n" +
  "- eng.complexity: \"low\", \"medium\" or \"high\"\n" +
  "- eng.region: \"ime\", \"eu\", \"apac\", or \"na\"\n" +
  "- towers[].type: \"AMS\", \"IMS\", or \"DMS\"\n" +
  "- towers[].mode: \"history\" (real incident/ticket counts given), \"proxy\" (only app counts/sizes given, no ticket volume), or \"mau\" (only active-user counts given)\n" +
  "- towers[].coverage: \"8x5\", \"16x5\", \"24x5\", \"8x7\", \"16x7\", or \"24x7\" (the x7 variants extend the same daily hours across weekends too)\n" +
  "- towers[].own.L1 / L2 / L3: \"us\", \"customer\", \"vendor\" or \"product\"\n" +
  "- evidence[].basis: \"stated\", \"inferred\" or \"assumed\"\n";

// What to include and how (tower-type inference, scope, conflicts, tables) - kept identical to the in-page
// buildClaudePrompt() by construction; change both together.
const EXTRACTION_RULES =
  "What to include and how:\n" +
  "- Include every field you can support from the text; omit fields you cannot support rather than guessing - omitted fields keep the app's default. Keep volume figures to one or two decimal places (do not round 53.17 to 53). Be concise: docSummary at most 6 sentences, at most 15 warnings (the most important first), no repetition between docSummary and warnings. Never invent a plausible-sounding value. towers[] entries need at least type and mode; nested objects (mix, srMix, crMix, own, sla) may be partial.\n" +
  "- Tower type is decided by WHAT IS BEING SUPPORTED, not by keywords. AMS = application management: incidents, service requests and change requests against applications/services/portals, application releases, batch jobs, tech debt. IMS = infrastructure management: servers, cloud/hosting, network, databases operations, observability and platform operations the bidder itself runs. DMS = data management: data platforms, pipelines, warehouses, data products, data quality. Words like \"infrastructure\", \"data\", \"AWS\" or \"database\" appearing in a description of an application estate do NOT make an IMS or DMS tower. Create a tower only for work the bidder is being asked to support. If the infrastructure or platform is run by another party (a hosting vendor, an enterprise IT team) it is not a tower; say so in warnings.\n" +
  "- When a document lists many services, packages or applications with their own counts, combine them into ONE tower per tower type (sum the counts) unless the document itself defines separate towers or separately-owned groups to be sized independently; describe the combination in the tower label and in warnings.\n" +
  "- towers[].own says who provides each support tier for that tower: \"us\" (the bidder), \"customer\", \"vendor\" (another supplier) or \"product\" (the client's product/dev team). A tier the document says is out of the bidder's scope or run by the agency/client is \"customer\" (or \"vendor\" if a named supplier runs it). Intermediate or special teams (for example an L1.5 team) are context for warnings, not a tier.\n" +
  "- Always give all three tiers (L1, L2, L3) whenever you give own.\n" +
  "- Incidents are tickets raised as incidents. Batch/job/interface failures, alerts, problem reports and similar operational counters are NOT incidents unless the document says they are logged as incidents: never add them to inc or mix; mention them in warnings with their count.\n" +
  "- towers[].srMix and crMix describe how complex service requests / change requests are: low (simple, routine), medium, high (complex, urgent, multi-team). Use counts or percentages. Map the document's own words (\"majority simple\", \"10-20% urgent or complex\") onto low/medium/high; if only two classes are described, medium may be 0. Only include them when the document says something about request complexity.\n" +
  "- eng.engagementType: \"brownfield\" if an incumbent team or existing build is being taken over, \"greenfield\" if built from scratch by the bidder. eng.complexity is YOUR judgement of how hard the estate is to run (low / medium / high) from technology mix, integrations, legacy, migrations, regulation; always basis \"inferred\" and quote the strongest evidence. eng.estate is \"legacy\" for complex legacy or mid-migration estates, \"modern\" for modern/SaaS.\n" +
  "- eng.region and eng.locMix: only when the document states where the bidder's delivery team sits or is to be located. The hosting/cloud region, the client's own location or where an incumbent works is NOT the delivery location - if that is all the document gives, omit region (or give it basis \"assumed\" and say why in warnings). locMix keys depend on the region: eu {onshore, nearshore, offshore}, apac {china, australia, singapore}, na {nearshore, offshore}; percentages summing to 100; omit locMix if the split is unknown.\n" +
  "- eng.pass12 / eng.pass23 (percent, 0-100): only when the document states an OBSERVED escalation or resolution rate. pass12 = share of tickets reaching L1 that go on to L2 (100 minus the L1 resolution rate); pass23 = share of tickets handled at L2 that escalate to L3. Do not derive them from guesses. Set pass12 only when L1 is in the bidder's scope; the rates of an intermediate team (for example an L1.5 team run by the client) belong in warnings, not pass12. If the document gives only a share handled at L3, derive pass23 from it and say how.\n" +
  "- eng.incumbentFTE: the size of the existing/incumbent team the client quoted for the in-scope work, if any (a single number; use the midpoint of a range, and say so in warnings).\n" +
  "- Work that is a SEPARATE effort from running the in-scope service (an automation tool to build, a manual review process, monitoring or reporting improvements) is not a tower: list it in opportunities[] with its current effort or volume where stated.\n" +
  "- Several dated sessions or versions of the same fact may disagree (a count that changes, a figure later flagged as wrong). Use the most recent, explicitly-corrected value, and put the conflict in warnings. Content that is clearly analysis, a model, a proposal or an AI-generated estimate written about the data (for example an FTE or pod breakdown) is NOT client-stated fact: never take values from it.\n" +
  "- Figures that look wrong (one item holding most of a platform-wide total, a ratio that cannot be right, a total that does not equal its rows) are still extracted as stated, but must be flagged in warnings with what you checked.\n" +
  "- Tables arrive as lines with cells separated by \" | \"; use the header row to identify columns, and check any total row against the rows. A table that continues after a [page N] marker is the same table.\n";

const EVIDENCE_RULES =
  "Evidence: for every volume, mix, ownership, coverage, region, complexity, pass-through, incumbent and tower-type value you output (one entry per field; skip trivial ones), add an entry to evidence[]: path (dot path into YOUR JSON, e.g. \"towers.0.sr\" or \"eng.complexity\"), value (what you wrote), quote (a SHORT passage, at most 150 characters, copied EXACTLY and CONTIGUOUSLY from the document text - same words and numbers, never paraphrased, and never joined with \"...\" (if a value draws on several places, quote the single most informative contiguous passage)), and basis: \"stated\" (the document says it, including simple arithmetic such as dividing a stated total by a stated number of months), \"inferred\" (your judgement from what the document says) or \"assumed\" (no direct support; used a default or guessed - prefer to omit the field instead). For a computed value quote the source numbers. The quotes are checked against the document, so a quote that is not in the text is reported to the user as unverified.\n";

// Reported bug: a document stating a period total (e.g. "719 incidents" from an
// annual or six-month table) got written straight into inc/sr, which the app
// treats as a MONTHLY rate (rawVolume() sums them directly, no period logic of
// its own) - inflating demand, and therefore FTE, by however many months the
// source total actually spanned. The model has no way to know these fields are
// monthly unless told explicitly, since the schema example's bare numbers (180,
// 70) carry no visible unit.
// Reported bug 2: towers[].cr (change requests) didn't exist as a field at
// all, so a document with a distinct CRs column (separate from incidents and
// service requests) had nowhere for that number to go and was silently
// dropped. Extract it whenever the source reports it, same as inc/sr.
//
// Reported bug 3: severity/priority counts (e.g. "Sev A 155, Sev B 557, Sev C
// 7") were being converted to rounded whole-number percentages before being
// written into mix ("155/719 -> 22"), losing precision for no reason - the
// app's own tierCascade() normalises whatever it's given, so raw counts work
// identically and more precisely. Write counts straight through instead.
const UNIT_NOTES =
  "Unit notes:\n" +
  "- towers[].inc (incidents), towers[].sr (service requests) and towers[].cr (change requests) are each MONTHLY figures - " +
  "count per month, never a running or period total. First check whether the source states or implies ANY reporting period for " +
  "these totals (a date range, \"full year\", \"six months of data\", a quarter, etc). If it does, divide by the number of " +
  "months that period actually covers before writing the field - do not write the period total directly into inc, sr or cr - " +
  "and state the period you found and the conversion you applied in docSummary (e.g. \"719 incidents over 12 months ≈ " +
  "60/month\"), so it can be checked against the source. If NO reporting period is stated or implied ANYWHERE in the text for " +
  "these figures - no dates, no \"per year\"/\"per month\"/\"over N months\" language, nothing - do not silently treat the raw " +
  "number as already monthly and describe it as a plain fact; that is exactly how a real annual total got miscounted as a " +
  "monthly one previously. Instead: write the raw number into the field as given (it is still the best available number), but " +
  "you MUST flag the assumption explicitly and unmissably in docSummary, in words close to \"No reporting period was stated " +
  "for these figures - treating them as already monthly by assumption; verify this against the source before relying on it\" - " +
  "never phrase an assumed-monthly figure as if it were a confirmed one.\n" +
  "- towers[].mix (P1-P4) must always be genuine percentages of TOTAL INCIDENT volume, summing to 100 (+/-1 for rounding) - " +
  "never raw counts. Different documents report this in different shapes - a table of counts per severity, an already-stated " +
  "percentage split, or a label set other than P1-P4 entirely (Sev A/B/C/D, Critical/High/Medium/Low, Priority 1-4, etc). " +
  "Whatever shape is found: (1) identify each severity/priority category's raw count or share, (2) map it onto P1-P4 in " +
  "descending severity order (P1 = most severe/highest priority, regardless of what the source itself calls it), (3) compute " +
  "each category's percentage of the total incident count. Keep one or two decimal places rather than rounding to a whole " +
  "number - on a lopsided split (e.g. 7 of 719) whole-number rounding can distort the smallest category by half or more. " +
  "State the raw counts found, the P1-P4 mapping applied, and the resulting percentages in docSummary so they can be checked " +
  "against the source. mix always represents incident severity/priority only - never blend service-request or change-request " +
  "volume into it, since those are extracted separately into sr/cr and costed on their own ARE, not this mix.\n";

// When the caller (the intake screen's "Reporting period" field) already
// knows the span these volumetrics cover, that takes precedence over asking
// the model to infer or flag it - removes the whole class of guessing error
// UNIT_NOTES otherwise has to hedge around.
function periodOverride(periodMonths?: number): string {
  if (!periodMonths || periodMonths <= 0) return "";
  const n = Math.round(periodMonths);
  return "IMPORTANT - the user has explicitly stated the reporting period: all volumetrics (incidents, service requests, " +
    "change requests) in the document text below cover exactly " + n + " month(s). Use inc = total incidents / " + n +
    ", sr = total SRs / " + n + ", cr = total CRs / " + n + ". This takes precedence over any period language you find in " +
    "the text, or the lack of it - do not infer a different period, and do not add an assumption caveat about the period in " +
    "docSummary, since this number was explicitly provided by the user rather than guessed. You may still state it as fact " +
    "in docSummary (e.g. \"volumetrics cover " + n + " months as specified\").\n\n";
}

function buildPrompt(text: string, periodMonths?: number): string {
  return "You are helping fill in a DAMO managed-services sizing tool. Read the document text below (an RFP, meeting notes or other client material) and return ONLY a JSON object " +
    "(no prose, no markdown fences) that matches this shape. docSummary should be a short narrative in your own words, not copied verbatim from the source; " +
    "omit it if the text gives nothing to summarize.\n\n" +
    "Target schema (example values, not the answer):\n" + JSON.stringify(SCHEMA_EXAMPLE, null, 2) + "\n\n" +
    ALLOWED_VALUES + "\n" +
    EXTRACTION_RULES + "\n" +
    EVIDENCE_RULES + "\n" +
    UNIT_NOTES + "\n" +
    periodOverride(periodMonths) +
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
  engagementType: ["greenfield", "brownfield"],
  complexity: ["low", "medium", "high"],
  basis: ["stated", "inferred", "assumed"],
  region: ["ime", "eu", "apac", "na"],
  type: ["AMS", "IMS", "DMS"],
  mode: ["history", "proxy", "mau"],
  coverage: ["8x5", "16x5", "24x5", "8x7", "16x7", "24x7"],
};
function sanitizeExtraction(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sanitizeExtraction);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "term" && typeof val === "number") {
        out.term = [1, 2, 3, 4, 5].reduce((best, t) => (Math.abs(t - val) < Math.abs(best - val) ? t : best));
        continue;
      }
      if ((k === "pass12" || k === "pass23") && typeof val === "number") {
        out[k] = Math.min(100, Math.max(0, val));
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
  let body: { jobId?: string; text?: string; passphrase?: string; periodMonths?: number };
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
    // Streamed (finalMessage) rather than a single blocking create(): a large document with
    // evidence quotes can run well past the non-streaming output ceiling, and a reply cut off at
    // max_tokens is invalid JSON - so the ceiling is generous and a cut-off is reported as such.
    const stream = client.messages.stream({
      model: "claude-sonnet-5",
      max_tokens: 32000,
      messages: [{ role: "user", content: buildPrompt(text.slice(0, 200000), body.periodMonths) }],
    });
    const response = await stream.finalMessage();
    if (response.stop_reason === "max_tokens") {
      await store.setJSON(jobId, {
        status: "error",
        error: "The extraction was cut off at the output limit - try fewer or shorter documents, or split the document and extract in parts.",
      });
      return;
    }

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
