# DAMO Estimator — README

An interactive RFP sizing tool for the DAMO managed-services line. It takes engagement inputs (service towers, term, AIOps in/out, incident history, SLAs) and produces a defensible **effort and FTE** estimate with a year-on-year productivity curve, a named role-and-grade staffing plan, and an explicit confidence posture.

**It sizes effort and headcount only.** There is no rate card, no margin and no client price anywhere in the tool. That was a deliberate scope decision — pricing stays in the commercial workbook.

- **Live tool:** https://claude.ai/code/artifact/6182d787-5523-4e96-8b2b-ef126a234fc4
- **Interactive user guide:** https://claude.ai/code/artifact/dceb2605-9693-471c-a5c2-0b4481ed07cd  (source: `damo-estimator-guide.html`)
- **FAQ:** https://claude.ai/code/artifact/b7183a26-6cb6-4c98-bdbc-8352bccd4c3e  (source: `damo-estimator-faq.html`)
- **Netlify deployment (with live AI-powered RFP intake, §2a):** https://damo-estimator.netlify.app
- **Source:** `damo-estimator.html` — a single self-contained file, no build step, no network calls

---

## 1. What it is built from

Two source documents, cited throughout the code and the UI:

| Tag | Source |
|---|---|
| `[F]` | DAMO Solution Estimation Framework (PDF, 30 pp) |
| `[P]` | AI_Works DAMO Team Pricing Sheet (xlsx, 7 sheets) |

Anything **not** traceable to those two is marked `proposed` in the interface and listed in the exported register. Those are calibration targets, not facts.

---

## 2. RFP intake screen

On a fresh visit (no saved-estimate hash in the URL), the tool opens on an intake screen instead of the dashboard, with an immediate **Skip — set up manually** escape hatch. It's also reachable at any time via the **Start from RFP** button in the masthead — needed because the landing-gate-on-fresh-load logic only ever fires once per browser tab for a long-lived, bookmarked tool: every dashboard interaction saves state to the URL hash, so a returning user's "fresh load" detection is permanently tripped after their first-ever visit. The button doesn't depend on hash state at all, so it always works.

**Why it works the way it does.** A published Artifact is a static page with no backend and no runtime LLM access — checked directly against the platform's own capability list, which covers only file-download and connector calls, not summarization. So "reads the document and creates a summary" cannot mean a live AI call from inside the page itself on that deployment. The Netlify deployment is different: it's a real web server that can run serverless functions, so it gets a fourth, automatic path (§2a) the Artifact structurally cannot have. There is also hard evidence from this build that scripted downloads/popups/print are unreliable in the real Artifact deployment sandbox (see §9). Given these constraints, the intake screen is built from up to four paths:

1. **Add one or more documents, then Detect inputs.** Each document is either pasted text or a real file upload — **.docx, .pdf, .xlsx, .txt, .md** are all supported natively, no separate conversion step. Document rows are typed (RFP / Incident History / SLA-Contract / Other) purely for the user's own organization; all of them get concatenated (each under an `=== Label ===` marker) into one combined text before extraction, so an RFP and a separate incident-history workbook combine into a single pass rather than needing to be merged by hand. A pure regex/keyword extractor (`extractAll` and its per-field helpers — `extractTerm`, `extractTowers`, `extractIncidentVolume`, `extractSLA`, `extractPriorityMix`, `extractCoverage`, `extractAIOps`, `extractMAU`, `extractOwnership`, plus `extractTabularIncidents` for spreadsheet-shaped data, see below) scans the combined text for contract term, which of AMS/IMS/DMS are mentioned, incident/ticket volume, P1–P4 SLA targets and severity mix, coverage window, AIOps intent, MAU, and L1–L3 ownership hints. This is **pattern-matching, not comprehension** — the UI says so explicitly, and every detected field shows the exact matched excerpt for provenance, so a bad match is visible and correctable rather than hidden behind false confidence. Anything not detected is simply left at the existing framework defaults, editable in the rail exactly as before — no separate gap-filling UI was needed, because the rail already is that UI.
2. **Import Claude-prepared inputs — the real AI summary path.** A published Artifact has no runtime LLM access (checked directly against the platform's `artifact-capabilities` skill: only `downloads` and `mcp` exist, neither of which can generate text), so a genuine narrative summary can only come from an actual Claude conversation, never from anything running live inside the page. **Copy prompt for Claude** (`buildClaudePrompt()`) builds one clipboard-ready block — instructions, the target JSON schema with a complete example, and the document text already entered above (`combinedIntakeText()`) — so one click gives you something to paste directly into a fresh chat. Claude's JSON response goes back into the same "Prepared JSON" box and **Apply prepared inputs**, which merges it via a real recursive `deepMergeState(base, partial)`, not the shallow `Object.assign` the JSON-file **Import** button uses — a partial object like `{"eng":{"term":5}}` through `Object.assign` would silently wipe out every sibling field of `eng` back to `undefined`, which is fine for a full Export→Import round-trip but wrong for a hand-written partial. `deepMergeState` merges nested objects key-by-key instead. A `docSummary` field in the returned JSON populates a **Document Summary** card at the top of the dashboard (with a Clear button), and flows into both the exported register and the printed SA report — it's core RFP context, not optimization/quantum material, so it belongs on the "include" side of the print report's existing SA-only content boundary.
   - **Schema gotcha, now fixed in code rather than relied on in prompt wording alone:** `deepMergeState` replaces `towers[]` wholesale rather than merging per-tower, so an incomplete tower object from Claude leaves fields missing — not NaN, as originally assumed here, but **silently excluded from every calculation**: every engine entry point filters `S.towers.filter(t=>t.enabled)`, and a tower missing `enabled` (falsy when `undefined`) simply never gets counted, no crash, no console error, just a suspiciously low FTE. A live test surfaced exactly this — Claude returned a real, well-reasoned tower object omitting fields it had no evidence for (`enabled`, `own`, `apps`, `mau`, `inc`, `sr`, `mix`) exactly as the general "omit what you can't support" instruction says to, which directly conflicts with the same prompt's separate instruction that `towers[]` objects must be complete. Prompt wording alone wasn't reliable enough to prevent this. **`backfillTowers()`** (called from the shared `btnIntakeJsonApply` handler, so it covers both this path and the Netlify AI-extraction path in §2a) now merges every tower against `mkTower(type)` — `Object.assign({}, mkTower(t.type||"AMS"), t)` — so any field the source JSON provides is kept, and anything missing gets the same default a manually-added tower would have, including `enabled:true`. Confirmed live: a real extracted tower that computed Y1 FTE ≈ 1.4 (just the governance baseline, tower entirely excluded) became FTE ≈ 17.4 once backfilled — and, critically, the tower's inputs (complexity, MAU, coverage, ownership) became genuinely editable again, since editing a field on an excluded tower was silently doing nothing no matter what the UI showed.

Reloading a link that already carries a saved-estimate hash skips the intake screen entirely and opens straight on the dashboard, unchanged from before this feature existed.

**File parsing, format by format:**

- **.docx and .xlsx** are parsed natively, no bundled library. Both formats are a ZIP archive of XML internally, and modern browsers can unzip (`DecompressionStream("deflate-raw")`) and parse XML (`DOMParser`) with built-in APIs alone — `unzipEntry`/`readZipTextEntry` implement a minimal ZIP central-directory reader, `parseDocxText` pulls `word/document.xml` and reads `<w:t>` runs per paragraph, `parseXlsxRows`/`parseXlsxText` pull `xl/sharedStrings.xml` plus each `xl/worksheets/sheetN.xml` and resolve shared-string cell references into an actual table.
- **Incident-history spreadsheets are tabular, not prose** — "P1, 20, 15, 120" in cells doesn't match sentence-shaped regexes like "P1 response within 15 minutes." `extractTabularIncidents` scans the pipe-flattened sheet text for a header row containing a priority/severity column plus incident-count and response/resolution-SLA columns, then reads the data rows directly: it produces an aggregate incident volume (summed across P1–P4), per-priority SLA in minutes, and a derived percentage mix — merged into the same `report` shape the prose extractors produce, with tabular data taking priority when both a spreadsheet and prose text mention the same field (structured data is more precise than a regex guess).
- **.pdf is parsed with a real bundled parser (pdf.js).** PDF's internal structure — compressed content streams, font/glyph encoding — genuinely isn't something to hand-roll safely, unlike the ZIP-based formats above, so `pdf.min.js` and `pdf.worker.min.js` (Mozilla, Apache-2.0) are inlined directly into the HTML file: the main library as an executable `<script>` block (defines the `pdfjsLib` global), the worker as an inert `<script type="text/plain">` data block that's turned into a `Blob` worker only on first use, so nothing is ever fetched over the network. `parsePdfText` reconstructs readable text from pdf.js's positioned glyph runs itself, rather than naively joining every run with a space — pdf.js frequently splits a single word across two runs (a font or kerning change mid-word is enough), and blindly inserting a space between every run corrupts words at exactly those split points, which silently breaks keyword matching downstream. The join logic instead compares each run's actual x/y position to the previous one: a real horizontal gap gets a space, a vertical shift starts a new line, anything else concatenates directly.

Adds roughly 1.5 MB to the artifact (the pdf.js bundle) — well inside the 16 MB Artifact limit, and it's the only way to support real PDF upload; the alternative was leaving PDF as copy-paste-only.

### 2a. Extract with AI now — Netlify-only, one click, no copy-paste

**Netlify-only.** This button does not exist as a real capability on the claude.ai Artifact — a published Artifact cannot call an external serverless function, so the whole mechanism below is specific to `damo-estimator.netlify.app`. The regex extractor (2) and the manual copy-prompt-to-a-fresh-chat path (2, item 2) still work identically everywhere, including the Artifact.

On the Netlify deployment, **Extract with AI now** in the "Import Claude-prepared inputs" section sends `combinedIntakeText()` to a real backend — `netlify/functions/extract-inputs-background.mts` — which calls the Claude API (`claude-sonnet-5`) and writes the result back for the page to pick up. No copy-paste, no second chat window.

- **Reporting period — never assumed.** Volumes in a document are often a total over some period, not a monthly figure. The extractor reads the period the document states (for example "six-month manning data" or "FY25 incidents") and converts to monthly (`total ÷ months`); when the document states no period it must say so in the summary rather than silently treating the numbers as monthly. You can also type the period yourself in **Reporting period (months)** on the intake screen — a stated value always takes precedence over anything inferred, and the same instruction is sent by both the Netlify function and the *Copy prompt* path.
- **Severity mix is always a genuine percentage.** Whatever shape the incident data arrives in (Sev A/B/C counts, a P1–P4 table, per-severity monthly totals), `towers[].mix` is converted to percentages of *total incidents* summing to 100; service requests and change requests are never folded into it, and CRs are extracted as their own monthly figure.
- **Evidence and review (new).** The reply carries, for each volume, mix, ownership, coverage, region, complexity, pass-through and incumbent figure, an `evidence[]` entry: the dot path, the value, a short **verbatim quote** and a basis — *stated*, *inferred* or *assumed* — plus a `warnings[]` list. After extraction (or when you paste a reply) the intake screen shows a **review table**: each proposed input with its basis and source quote, the quote checked against the document text the page holds (found / numbers found, wording differs / **not found**), untick-to-exclude checkboxes (assumed and not-found inputs start unticked), and the warnings. Only ticked inputs are applied; evidence and warnings never enter the estimate. A mix or ownership shows as one row.
- **What is extracted now.** Beyond volumes and SLAs: SR and CR complexity mixes, the tower's label, ownership of each tier, coverage, estate complexity (the model's judgement, always *inferred*), engagement type, client AI maturity, region and location mix (only when the delivery location is stated — hosting is not delivery), **observed pass-through** (L1→L2 only when L1 is ours, L2→L3), the incumbent team size, and **adjacent opportunities** (separate automation efforts — they go to the register, not into the sizing).
- **Tower type is inferred from what is supported, not from keywords.** Incidents/SRs/CRs against applications are AMS; words like "infrastructure", "data" or "AWS" in an application estate do not make IMS or DMS; infrastructure run by another party is not a tower. Many services listed in one table are combined into one tower (the combination is described in the label and warnings). Dated sessions that disagree: the latest explicit value wins and the conflict is a warning; analysis or AI-generated estimates inside the document are never used as client facts; suspect figures are still extracted but flagged; job/batch failures and similar counters are not counted as incidents.
- **Table-aware PDF text.** Table rows keep their cells apart (`a | b | c`) and pages are marked `[page N]`, so a Sev A/B/C or SR/CR column no longer runs together.
- **A reply that is almost JSON still works.** The function parses strictly, then tolerantly (raw line breaks or tabs inside a quoted passage — common when a quote spans a PDF line break — unescaped inner quotation marks, trailing commas, prose or a code fence around the object), then makes one repair call to the model, and only then fails. A failure reports the stop reason, output tokens and the parse error, and puts the raw reply in the JSON box so it can be fixed by hand. The page applies the same tolerant parser to pasted replies; `test/extraction/loose-json.test.mjs` runs the server and page copies against the same samples.
- **Regression harness.** `test/extraction/` has a synthetic fixture (invented client and numbers, never a real document), `expected.json` and `score.mjs`, which posts the fixture to the live function and scores it (tower type, volumes after period conversion, mix, ownership, pass-through, incumbent, warnings, evidence quotes). The output limit is 32,000 tokens (streamed); a reply cut off at the limit is reported as such.
- **Same schema, same apply path, by design.** The prompt the function sends to Claude is a server-side twin of `buildClaudePrompt()` — same target shape (`docSummary`, `eng{term, aiMaturity, volumetrics, aiops, estate, region}`, complete `towers[]` entries), same "omit what you can't support, never guess" instruction. A successful response lands in the same `#intakeJson` textarea and goes through the same **Apply prepared inputs** → `deepMergeState(defaults(), json)` flow the manual path already uses — no second merge implementation to keep in sync.
- **Plain prompting, not structured outputs — a live constraint forced this, not a preference.** The first version used `output_config.format` (JSON Schema-enforced output) with every field individually nullable so the model could omit exactly what it wasn't sure about. Two schema shapes were tried and rejected by Anthropic's API before this: `type:["string","null"]` combined with `enum` (400: "Enum value does not match declared type"), then `anyOf[{type,enum},{type:"null"}]` per leaf (400: "too many parameters with union types (33) ... limit 16 ... exponential compilation cost"). The full schema genuinely needs more independently-omittable fields than that budget allows without either merging fields the framework treats as separate, or forcing the model to guess whenever it includes an object at all. Plain prompting (what the manual copy-paste path already does, and already relies on working well) has no such limit, so that's what ships — the function parses Claude's JSON reply itself (stripping a `` ```json `` fence if present) instead of the API guaranteeing the shape.
- **The API key is never in the browser, and Claude (the assistant) never sets it.** `ANTHROPIC_API_KEY` is a Netlify environment variable read server-side via `Netlify.env.get(...)` inside the function — the frontend never sees it, and it never appears in this repo. It has to be set by whoever owns the Netlify site, directly in the Netlify dashboard or via `netlify env:set ANTHROPIC_API_KEY <value>` in their own terminal.
- **Abuse guard, not real auth.** An optional `INTAKE_PASSPHRASE` env var, if set, gates the function — a request without a matching `passphrase` field gets a 401 before any Anthropic call is made. This exists only to stop a stranger who finds the live URL from spending the site owner's API credits; it is not a login system, and the passphrase itself is stored in the browser's `localStorage` for convenience (not treated as a secret — it's a shared gate value, not a credential).
- **Enum fields are constrained explicitly, then re-checked server-side.** Several fields are closed sets in the app's own UI (e.g. `eng.aiMaturity` only ever renders as "low"/"moderate" — damo-estimator.html:2566) — a live test showed a single example value in the prompt isn't enough to keep the model inside that set ("AI/automation heavily" produced `aiMaturity:"high"`, which the app doesn't recognize). The prompt now spells out every allowed value explicitly, and the function additionally sanitizes the response server-side (`sanitizeExtraction()`): any enum field that still lands outside its allowed set is dropped rather than passed through, so a single model slip degrades to "field omitted, app default kept" instead of a bad value reaching `deepMergeState`. `eng.term` is snapped to the nearest of 1/3/5 the same way.
- **Background Function + poll, not one synchronous call — two prior attempts confirmed live why.** A real 23-page/~32K-character RFP exposed two separate limits on a standard synchronous Netlify Function in turn. First, buffering the whole Claude response before replying tripped the proxy's *inactivity* timeout (504 "too much time has passed without sending any data" at ~30s) — fixed by streaming keep-alive bytes for every response event, which worked for smaller documents. But the same real RFP still cut off with only heartbeat bytes delivered: Sonnet 5's adaptive thinking (on by default) can spend the whole window in a silent thinking phase with `thinking.display` at its "omitted" default, producing *no* visible stream events to forward — and separately, standard Netlify Functions carry a hard execution-duration ceiling that no amount of keep-alive can extend, which this document's total processing time exceeded regardless. Both problems disappear by not waiting on one request at all: `extract-inputs-background.mts` is a **Background Function** (15-minute limit, not the standard function's short one), which Netlify acks with an immediate 202 and whose return value is discarded — so it writes its outcome, success or error, to a **Netlify Blobs** job record (`getStore({name:"damo-extraction-jobs", consistency:"strong"})`) keyed by a client-generated `jobId`. The frontend posts the job, then polls `extract-status.mts` every 2 seconds (capped at ~90 attempts, ~3 minutes) until it sees `status:"done"` or `status:"error"`, showing live elapsed-seconds in the status line throughout.

---

## 3. Quick start

1. Open the tool. On a fresh visit it opens on the RFP intake screen (§2, also reachable any time via **Start from RFP**) — add the RFP, an incident-history sheet, or any other supporting document (paste text or upload .docx/.pdf/.xlsx/.txt/.md) and hit Detect, or click **Skip — set up manually** to land directly on the dashboard with a single AMS tower and a worked default so you see live numbers immediately.
2. Set **Engagement**: term, client AI maturity, whether volumetrics exist, estate profile, AIOps in or out, and Customer Region (IME, EU, APAC or NA). The first four choices select the scenario (1–4) and with it the contingency, team shape, AIOps timing and savings target; region drives the Delivery location mix card, and (for Active-Passive off-hours coverage) which location typically carries on-call.
3. Pick the **Service mix** — AMS, IMS, DMS or any combination. Click a line to add or drop it. Use **+ Add another tower** only when one line needs more than one tower (separate estates, different SLAs).
4. Set **Service responsibility** per tower — who provides L1, L2 and L3. New towers start with **L1 = Customer** (L2/L3 = us); pick *Full stack* when L1 is ours too.
5. Enter demand per tower: incidents (with a severity mix), service requests and change requests, each with its own Low/Medium/High complexity mix.
6. Set **Estate complexity** (Low/Medium/High) — it drives the seniority pyramid, the contingency and a tilt of the severity/SR/CR mixes. Optionally add **Special roles** (L1.5, SRE, QA, Advisory) by hand.
7. Score the nine confidence drivers and nine risk categories.
8. Read the results, then copy the **Assumptions & risk register** into the proposal.
9. Hit **Verify against framework** at the bottom — 229 checks reproducing worked examples from the source documents, validating the role map, and covering the intake extraction logic, the IMS/DMS structural-complexity model, the AIOps efficiency calculator, the transition phase, and the outcome/KPI bands.

The left rail is: Engagement → Estate complexity → Service towers → Seniority mix → Special roles → AIOps & run cost → AIOps efficiency calculator → Outcome model → Confidence & risk → Optimization → Benchmarks & assumptions. Sections stay open (and the rail keeps its scroll position) when you tick a box or press a button.

State is saved to the URL, so you can bookmark or share an estimate. **Export JSON** / **Import** move estimates between people.

---

## 4. The calculation, in order

### 3.1 Scenario selection
`AI maturity × volumetric availability → Scenario 1–4` ([F] Part 2/3). Drives Y1 contingency, team shape, AIOps start year, AIOps FTE ratio, YoY savings target, commercial model and volume-band posture.

### 3.2 Demand
Three interchangeable bases per tower:
- **History** — incidents, service requests and change requests per month, each its own stream (see below)
- **Complexity proxy** — apps by S/M/L/XL/XXL at 3–5 / 8–12 / 15–20 / 25–35 / 40–60 tickets/app/month ([F] Sc.1 Step 1)
- **MAU** — users × incident rate, benchmark 0.5–2% ([F] Sc.2 Step 2)

Existing client automation then deflates volume: 20–30% coverage → −15–20%, 30–50% → −20–30% ([F] Sc.2 Step 2).

**Three streams, three costs (History mode).**

| Stream | Costed as | Done by |
|---|---|---|
| Incidents | Severity cascade (P1–P4 entry matrix → pass-through) at the tier AREs | L1/L2/L3 per the cascade |
| Service requests (SR) | Per-complexity ARE, weighted by the tower's SR mix | Low → L1, Medium → L2, High → L3 (a tier that is not ours passes the work to the next tier we own) |
| Change requests (CR) | Per-complexity ARE, weighted by the tower's CR mix | Their own bucket, gated on L2/L3 ownership |

- **Severity mix** (P1–P4) accepts counts or percentages and is normalised; it applies to incidents only. SRs and CRs never inherit it.
- **SR / CR complexity mix** — each tower carries a Low/Medium/High mix for SRs and one for CRs (counts or %, normalised; defaults SR 60/30/10, CR 50/35/15 `proposed`).
- **AREs by complexity** live in *Benchmarks*: SR 0.25 / 0.5 / 1.5 h and CR 4 / 8 / 16 h (Low / Medium / High, `proposed`). The charged ARE is the mix-weighted average, so a 60/30/10 SR mix costs 0.45 h per SR.
- **Estate complexity tilt** — Medium/High estate complexity moves a share of each lower band one level up in the severity mix *and* in the SR/CR mixes (see 3.8b); the effective mix is shown under each input.
- SRs can be done by L2/L3 as well: where L1 is the customer's (the default), Low SRs fall to L2 rather than disappearing.

### 3.3 Tiering is a cascade, not a partition
This is the part most people get wrong, and the framework's own page-3 illustration settles it:

> 100 tickets arrive at L1. 30 are resolved there (0.25 h each = 7.5 h). 70 pass to L2 — and **all 70** consume 3 h each = 210 h. 20% of those 70 escalate to L3 — 14 tickets × 10 h = 140 h, **on top of** their L2 hours. Raw total 357.5 h ÷ 0.85 utilisation = **421 h**.

So L2 effort covers every pass-through, and L3 escalations are additive. The P1–P4 matrix sets where each priority *enters* the stack; the framework's pass-through rates (70/65/60% L1→L2, 20/20/15% L2→L3) then cascade the L1-entering stream downward and improve by year.

### 3.4 Effort to FTE
```
raw   = Σ_tier (incident tickets_at_tier × ARE_tier × tower_multiplier) × (1 + SLA modifier on L2/L3)
      + SR hours (per-complexity ARE, by tier) + CR hours (own bucket)
A     = raw / utilisation                 # default 85%
B     = A × non-ticketing %               # 20–25% modern, 30–35% legacy
G     = governance & reporting hours
base  = (A + B + G) / hours_per_month     # default 160
```

### 3.5 Coverage, hypercare, AIOps
- **Coverage** — `(shifts_per_week × FTE_per_shift) / 5`. Acts as a **floor**, not an addition: when the roster needs more people than the workload does, headcount is set by the support window. The tool flags this when it happens. Six windows are selectable: `8x5`/`16x5`/`24x5` (weekday) and `8x7`/`16x7`/`24x7` (every day) — the `x7` variants keep the same daily hours as their `x5` sibling but extend across weekends, computed by the same shift-count formula (`SHIFTS`). `Term (years)` runs 1–5 individually, not just 1/3/5 — every value runs the engine for exactly that many year-rows; Y4–Y5, where reached, still extend the Y3+ pass-through/inflow benchmarks.
- **Hypercare** — Y1 carries up to 3× steady-state volume for the first few months with a step-down glide path ([F] G4).
- **AIOps** — deflection applies to delivery FTE; AIOps engineers are added at 1:4 or 1:8 (flexing to 1:6 above 20 FTE), **phased in with the roadmap**: charged only from the year deflection actually starts (Y2 in Scenarios 1 and 3), not from Y1. They are driven by the scenario, not typed in; Special roles do not include them.
- **Contingency** — once an Estate complexity is chosen, a % of the delivery team is added as real FTE (see 3.8b).
- **Why Y1 is not the run-rate** — the Y1→Y2 drop comes from hypercare, the Brownfield Y1 uplift and AIOps deflection timing, all temporary Y1-loaded effects. The register and results explain it with the actual numbers.

### 3.6 Service responsibility

Each tower declares who provides L1, L2 and L3: **DAMO (us)**, **Customer**, **Other vendor** or **Product team**. **New towers default to L1 = Customer, L2/L3 = us** (existing saved estimates keep their own ownership); choose *Full stack* when L1 is in scope. Presets cover the common shapes:

| Preset | L1 | L2 | L3 |
|---|---|---|---|
| Full stack | us | us | us |
| L1 customer | Customer | us | us |
| L1+L2 customer | Customer | Customer | us |
| L1 cust, L2 us, L3 prod | Customer | us | Product team |
| L1 vendor | Other vendor | us | us |

Effects on the estimate:

- Tiers we do not provide are **not sized** — no effort, no headcount, no roles. Volume still cascades through them.
- Team-shape splits **renormalise** over the tiers we do provide, so a "customer keeps L1" deal does not staff phantom L1 people.
- The role plan drops roles belonging to out-of-scope tiers automatically.
- AIOps use cases that deflect a tier we do not provide are **excluded from the O1 portfolio** — the client may benefit, but they buy us no headcount.
- The rostered coverage floor only applies where we hold a front-line tier (L1 or L2). If we are the L3 escalation party only, coverage is on-call rather than a staffed rota.
- Each adjacent tier pair under different ownership adds a **coordination uplift** to our ticketing effort (default 4% per interface, `proposed`).

### 3.7 Role map (fixed per tower)

There is no role catalogue, tick-box or weight any more. Each tower's tier headcount goes to exactly one role:

| Tower | L1 | L2 | L3 |
|---|---|---|---|
| AMS | Product Support Engineer *(only if L1 is ours)* | **Systems Support Engineer** | **SSE** below the evolution threshold, **Developer** at or above it |
| IMS | Product Support Engineer *(only if L1 is ours)* | **Infrastructure Support Engineer** | same role (L2 and L3) |
| DMS | Product Support Engineer *(only if L1 is ours)* | **Data Support Engineer** | same role (L2 and L3) |

Plus **Machine Learning Engineer** for AIOps (count follows the scenario ratio once deflection starts) and **Service Delivery Manager** as the only governance role (1 per 8 delivery FTE, the manual-estimation convention). A tier we do not own has no effort, so no role appears for it.

**Developer** is AMS-only and takes L3 once evolution work reaches a threshold (default 30%, editable); below it, Systems Support Engineer covers AMS L3 as well as L2. A mixed AMS+IMS deal resolves each tower against its own headcount share, not a deal-wide blend. Asserted by self-tests.

Anything else — **L1.5, SRE, QA, Advisory** or a custom role — is not a tower role: add it under **Special roles**. The old 35-role catalogue, role weights, the IMS "SRE is the objective" checkbox, the QA effort share, Information Security Engineer / Data Architect / Data Strategist gating and the Infrastructure Engineer role were removed; old links that carry them load without error and the values are ignored.

### 3.8 Seniority mix

Section *Seniority mix* (rail, right after Service towers). The Lead : Senior : Consultant pyramid for L1–L3 comes from the **Estate complexity**: Low **1:2:4**, Medium **1:2:3**, High **1:2:2** (ratios editable per level; not set = 1:2:4). It changes the grade split, never headcount. **SDMs are graded wholly Lead**; Special roles keep 1:2:4. No Principal grade.

**Seniority uplift as shape inverts** (default 0.25) still applies on top: as the scenario's team shape moves pyramid → diamond → inverted, a fraction of Consultant shifts to Senior and of Senior to Lead — the "leaner but senior-heavy team" narrative in the Role & grade staffing plan.

### 3.8a Special roles (manual, deal-level)

Section *Special roles* (rail, after Seniority mix): presets for **L1.5 support, SRE, QA, Advisory** and a **Custom** role. They apply to every tower, are entered by hand (one FTE number per role, with an optional per-year override; blank years use the flat number) and are **added on top of Total FTE**, shown as their own *Special* column and staffing-plan group. They are not deflated by AIOps, not scaled by hypercare or Brownfield uplift, carry no contingency, and are not part of the AIOps ratio base. They are graded 1:2:4 and flow into the delivery-location mix, the register, the print report and the Excel export. (AIOps engineers and governance are *not* special roles — they follow the scenario and the SDM rule.)

### 3.8b Estate complexity

Section *Estate complexity* (rail, right after Engagement): **Not set / Low / Medium / High**, one deal-level call on how hard the estate is to run (the per-tower IMS/DMS structural tiers in 3.11 keep driving the B-factor separately). It follows the DAMO Estimation Workflow's Stage 6 table and drives three things:

| Level | Pyramid L:S:C | Y1 contingency | Severity / SR / CR tilt `proposed` |
|---|---|---|---|
| Not set | 1:2:4 | none | none |
| Low | 1:2:4 | 5% | 0 |
| Medium | 1:2:3 | 7.5% | 10% |
| High | 1:2:2 | 10% | 20% |

- **Contingency** is real FTE: `% × delivery team (incl. SDM)`, added to Total FTE and spread across the L1–L3 roles. From Y2 it tapers to the lower of the Y1 value and 6% (cap editable). Y1 and Y2+ can be overridden per deal (blank = take the level's value). Special roles and AIOps engineers carry none. The scenario's Y1 guidance and the confidence-band wording are shown beside it as hints, not drivers. **Not set means no contingency** (as in the Workflow).
- **Severity tilt**: before the ticket cascade, that fraction of each lower severity band moves one level up (P4→P3, P3→P2, P2→P1), computed on the original shares and renormalised to 100. The entered mix is never changed; the effective mix is shown under it.
- **SR/CR tilt**: the same fraction moves SR and CR mixes up (Low→Medium→High).
- All levels (pyramid ratios under *Seniority mix*; contingency % and tilt under *Benchmarks*) are editable. The pyramid and contingency values come from the Workflow; the tilt is this tool's own calibration (`proposed`).

The allocation conserves headcount exactly: every tier FTE (contingency included) lands on one role, every role FTE lands on one grade. Asserted by self-tests, including with Special roles present.

### Observed pass-through, existing team and opportunities (inputs the extractor fills)

- **Observed pass-through** (*Benchmarks*): L1→L2 and L2→L3 %, blank = the framework benchmark. Y1 takes the value; later years keep the benchmark's own year-on-year improvement. L3 hours are additive and large, so a client statement like "under 5% reach L3" moves FTE a lot.
- **Existing team size** (*Engagement*): a sanity check shown in the register next to the Y1 estimate; it never changes the numbers.
- **Tower label** (tower card): free text, shown in the tower tables and register.
- **Adjacent opportunities**: noted in the source documents but not part of the run sizing; listed in the register.

### 3.9 Delivery location mix

A third, independent split layered on top of role and grade — **where** the team sits, not what they're called or how senior they are. Purely informational: it never changes total FTE, role selection or grade mix, since the tool sizes effort and headcount only.

**Region** (Engagement panel): **IME**, **EU**, **APAC** or **NA**. Each region has its own location catalogue (`LOC_CATALOG`) and preset table (`LOC_PRESETS`) — switching regions doesn't lose work, since `locMix` is keyed *by region*: set an EU mix, switch to APAC to compare, switch back, and the EU mix is exactly as left.

- **IME** — the entire team is shown as delivered from **India**. No further configuration; the Delivery location mix card and register section just state this.
- **EU** — three locations: **Onshore (Europe)** / **Nearshore (Romania)** / **Offshore (India)**, with four presets:

  | Preset | Onshore | Nearshore | Offshore |
  |---|---|---|---|
  | Offshore only | 0% | 0% | 100% |
  | Nearshore + Offshore | 0% | 40% | 60% |
  | Onshore + Offshore | 30% | 0% | 70% |
  | Onshore + Nearshore + Offshore | 20% | 30% | 50% |

- **APAC** — three peer locations, **China**, **Australia** and **Singapore**, with no onshore/nearshore/offshore hierarchy (APAC doesn't have one relative to India the way EU/NA do). Four `proposed` presets: China only, Australia only, **Singapore only** (for a complete Singapore-delivered APAC solution), even split (34/33/33). Old links without Singapore load with it at 0%.
- **NA** — two locations, **Nearshore (LATAM/Ecuador)** and **Offshore (India)**. Two `proposed` presets: Offshore only, Nearshore + Offshore.

All non-EU presets are marked `proposed` — there's no framework or client guidance for APAC/NA splits yet, only EU's presets trace to real usage. Type directly into the percentage cells for anything else. A live hint flags when a region's locations don't sum to 100%; the split still **normalises proportionally** rather than silently dropping or inventing headcount, so the underlying numbers stay correct even mid-edit, but a clean 100% is what makes the exported register read well.

The split applies uniformly to every role's Year 1 FTE within the active region — it does not assign specific roles to specific locations (a "Developers from Romania, everyone else from India" pattern is achieved by shaping the overall percentages to match, not by a per-role override). Self-tests assert the split conserves headcount exactly, per role and in total, for every region including when the entered percentages don't sum to 100, plus a dedicated test proving old saved links/exports (`region:"europe"`, a flat `locMix`) migrate through `seedRoles` to the new shape with numerically identical results, and a test proving switching regions never disturbs another region's already-entered mix.

### 3.10 Engagement type — Greenfield / Brownfield

A new engagement-level input, independent of **Estate profile** (modern/legacy is about how modern the tech stack is; this is about **who built and knows the system today**):

- **Greenfield** — built and will be operated by Thoughtworks. High confidence: the team already knows the codebase, engineering practices and maturity level, because they built it.
- **Brownfield** (default — the more conservative starting posture) — built by another vendor or the customer; Thoughtworks is taking over operations of something it didn't build. Real unknowns going in on code quality, documentation and technical debt.

Selecting either value auto-seeds four sliders that already existed in the framework's own Annexure 1/2 model — the first auto-seeding mechanic in the tool (every other input has always left the confidence/risk sliders alone):

| Slider | Greenfield | Brownfield |
|---|---|---|
| Confidence — Transition & incumbent handoff risk | 4 | 2 |
| Risk — Transition & handoff risk | 0.25 | 0.75 |
| Risk — Hidden work content | 0.25 | 0.75 |
| Risk — Complexity & tech debt misread | 0.25 | 0.75 |

Marked `proposed` (this calibration isn't sourced from [F]) both on the Engagement type control itself and on the four affected sliders. Switching the value **always re-seeds** — a manual edit to one of the four sliders is overwritten the next time the toggle is clicked, matching how other engagement inputs already reshape the estimate elsewhere. All four stay freely editable afterward.

**Brownfield also applies a direct FTE uplift, on top of the slider seeding.** The four sliders above only ever fed the Annexure 1/2 confidence score and risk drag, which in turn only ever moved contingency guidance and the Monte Carlo P50/P80/P95 band width — never the deterministic Y1 FTE number itself. Brownfield now additionally multiplies `pre` (post-hypercare, pre-AIOps-deflection base FTE) by `1 + Benchmarks → "Brownfield Y1 uplift"` (default **+20%**), tapering by a hardcoded `[1, 0.5, 0]` table across Y1/Y2/Y3+ so the uplift fades to nothing once the team has had a full year to learn a system it didn't build — the same "unknowns shrink with time" logic already used for hypercare step-down. Greenfield state applies no uplift (multiplier stays at 1). Editable in the Benchmarks panel; shown in the exported register and print report whenever it's non-zero.

Two things worth knowing about how the seeding and the uplift are wired, because they're easy to get wrong:

- **The [F p3] framework regression test (3.3 FTE) and the Annexure 1/2 fidelity test are completely unaffected.** `defaults()` still returns the framework's exact worked-example `conf`/`risk` arrays and no `engagementType` at all in the regression test's hand-built `T1.eng` literal — the uplift check is a strict `engagementType==="brownfield"`, which is `false` for `undefined`, so `engUplift` is `0` there. The four confidence/risk values are only ever applied by a page-bootstrap call (`seedEngagementType(S, S.eng.engagementType)`, run once right after `let S=seedRoles(defaults())`) or by clicking the toggle — never by `defaults()` or `seedRoles()` themselves.
- **Hash-restore and JSON Import never re-seed.** A returning user's own saved `conf`/`risk` values — even ones that happen to differ from what the current seed table would produce — are trusted as-is. Only a missing `engagementType` field gets backfilled (to `"brownfield"`, via the same `seedRoles` migration choke point used for the region/locMix legacy migration); the arrays next to it are left untouched. The FTE uplift, by contrast, is recomputed from whatever `engagementType` the state carries every time `runEngine` runs — there's nothing to migrate for it specifically.
- **`seedRoles` now also backfills missing `bench` fields, not just `eng` ones.** `loadHash()`/JSON Import do `Object.assign(defaults(), parsed)` — a *shallow* merge, so a saved state's top-level `bench` key wholesale-replaces `defaults().bench` rather than merging into it. Any bookmarked link, shared URL, or browser tab still carrying a `#hash` saved before `bench.brownfieldUplift` existed would otherwise silently load with the uplift permanently zeroed — indistinguishable from "brownfield doesn't affect FTE" even after this fix shipped. `seedRoles` now does `st.bench=Object.assign({},defaults().bench,st.bench||{})`, the same shallow-backfill pattern already used for `eng.locMix`, so any bench field missing from an old saved state picks up the current default instead of silently disappearing. **This is the most likely explanation if engagement type or any Benchmarks-panel field ever appears to have "stopped working" after a change that was actually deployed** — it means the browser has an old `#hash` in the address bar. A hard reload of the *same* URL doesn't clear it (the hash travels with the URL); navigating to the bare URL with no `#fragment`, or opening the Reset button, does.

### 3.11 Structural complexity — IMS / DMS

A new per-tower complexity model, **IMS- and DMS-only** (AMS is untouched — its existing incident-history/complexity-proxy demand inputs already cover it fully). It answers a different question than demand basis does: demand basis says *how many tickets* a tower will generate; structural complexity says *how operationally complex the estate itself is to run* — more environments, hosting targets, databases, integrations and dependencies mean more non-ticketing overhead (patching, monitoring, coordination) regardless of ticket volume. Grounded in a supplied Thoughtworks "Data Managed Services — Approach" deck, which frames complexity via technical/operational factors and ties a computed Low/Medium/High tier directly to team shape — not sourced from `[F]`/`[P]`, so every number here is flagged `proposed`.

**New per-tower inputs** (only rendered on the matching tower type):

| Tower | Inputs |
|---|---|
| IMS | Environments supported, hostings supported, databases supported, non-production environments, and a "security-related aspects in scope" checkbox |
| DMS | Data products supported, data platform built on (dropdown: Databricks / Snowflake / Synapse / BigQuery / Redshift / Other), integrations, upstream systems, downstream systems |

**Scoring.** `structCpxTier(t,B)` computes a weighted composite score per tower and bands it against two cut-points into `low`/`medium`/`high`:
- IMS: `wEnv×(environments+non-prod) + wHost×hostings + wDb×databases + (security ? secFlat : 0)`, defaults `wEnv:1, wHost:1.5, wDb:1, secFlat:3`, bands at 8/16.
- DMS: `wDp×data products + wInt×integrations + wUp×upstreams + wDown×downstreams + (platform==="Other" ? flat : 0)`, defaults `wDp:1, wInt:1, wUp:0.75, wDown:0.75, platformOtherFlat:3`, bands at 10/20.

All weights and cut-points are editable in the Benchmarks panel, calibrated so a freshly-added IMS or DMS tower's own proposed field defaults land at **Medium** — a deliberate "typical mid-size deal" anchor rather than an artificial Low or High.

**Two effects, both new, neither touching AMS:**
1. **Effort.** `structCpxBump(t,B)` multiplies the tower's B-factor (non-ticketing effort) by `score × bumpPerPoint`, capped at `bench.structCpx.maxBump` — a **continuous** function of the same composite score that drives the tier label, not a 3-step lookup. `bumpPerPoint` is calibrated so the bump exactly equals the old flat tier values right at the cut-points (score = loMed → +10%, score = medHigh → +20%), then keeps climbing past them. This matters in practice: a tower with 100 environments must keep costing meaningfully more than one with 10, not flatline the moment it crosses into "High" — an earlier flat-per-tier version of this had exactly that defect, reported and fixed. The cap (default 200%, i.e. B-factor can at most triple) exists only as a sanity ceiling against adversarial input, not something a realistic estate reaches. Stacks multiplicatively with the existing legacy/modern B-factor, and is a third, independent lever alongside the SLA-stringency modifier (bumps L2/L3 hours) and the Brownfield uplift (bumps whole-tower pre-deflection FTE) — three levers on three distinct quantities, none double-counting the others.
2. **Roles — removed.** The High-tier gating of Information Security Engineer (IMS) and Data Architect / Data Strategist (DMS) went away with the role catalogue; the tier badge now only drives the B-factor bump and the demand proxy. Anything such a deal needs beyond the fixed role map is added by hand under **Special roles**.

A live badge on each IMS/DMS tower card shows the computed tier, the bump applied, and — at High — a one-line reminder to enable the relevant role(s). The register export and print report both narrate the same information per tower. The badge updates **instantly**, in place, on every keystroke or dropdown change — the same targeted-DOM-patch technique the delivery-location mix sum hint already used, since the rail as a whole is deliberately not re-rendered on every input event (that would drop focus mid-keystroke).

**Input validation.** All eight numeric fields carry HTML `min="0"` and a generous sanity `max` (e.g. 100 environments, 500 databases). More importantly — since HTML attributes are not a real defense against a hand-edited hash, JSON Import, or devtools — `structCpxScore()` itself clamps every count to `[0, 100000]` via a shared `cpxCount()` helper before it ever reaches the weighted formula. A negative or non-numeric value contributes exactly zero to the score (never a negative number, which would otherwise silently *reduce* B-factor below baseline for a nominally "more complex" input) and never leaves another field's valid contribution disturbed. Covered by four dedicated self-tests.

The deck's five DMS AIOps use cases (Automated RCA, Intelligent Alerting, Self-Healing, Predictive Capacity Planning, Anomaly Detection & Security) needed **no catalogue change** — `USECASES` is already tower-agnostic, gated only by which tier a deal owns, and already contains near-1:1 matches (`rc`, `ia`, `sh`, `ps`, `ad`) that apply to DMS exactly as they do to AMS/IMS.

### 3.12 Out-of-office-hours coverage model — Active-Active / Active-Passive

A per-tower choice, shown only when **Coverage window** is anything other than `8x5` (8x5 has no off-hours within the declared window at all). It answers a question the shift-maths floor has always silently assumed: is every declared hour *fully, actively staffed* (**Active-Active**), or is the team actively staffed during business hours and **on-call for P1-critical incidents only** the rest of the time (**Active-Passive**)?

- **Active-Active** reproduces the exact pre-existing floor formula — a hard backward-compatibility requirement, so no legacy saved link silently loses headcount the day this shipped.
- **Active-Passive** keeps the business-hours portion of the week (`SHIFTS["8x5"]`, 5 shifts) fully staffed, and discounts only the *off-hours delta* to an on-call allowance — a new editable Benchmarks constant, `bench.oohOnCallFactor`, proposed default **15%** of a dedicated shift. This is the real staffing lever: on a low-demand 24x7 tower where coverage is the binding constraint, Active-Passive can cut the coverage floor by roughly two-thirds versus Active-Active for the identical declared window — verified live (17.4 → 6.7 total FTE on a deliberately low-demand test case). A shared roster mixing models across towers correctly sizes to the more demanding (Active-Active) tower, since one physical roster can't split.

**Who typically carries the on-call**, for Active-Passive: `oohLocationFor(S)` auto-attributes a delivery location per the deal's **Customer Region** (renamed from "Delivery region" — same field, same mechanism, just framed honestly as "where's the customer, and therefore which delivery split applies"), via a new proposed table, `bench.oohLocationByRegion` — IME is always India (only one location exists); EU and NA default to Offshore (India); APAC defaults to China. **This is a stated convention, not a computed fact** — the tool has no cost/rate data to derive "cheapest location" from (effort/FTE only), so every entry is editable in the Benchmarks panel and clearly flagged `proposed`. Genuine hour-by-hour follow-the-sun timezone modeling already exists separately as the O2 optimization module; this is a lightweight narrative layer on top of the simple coverage-floor mechanic, not an extension of O2.

Surfaced everywhere the tool already narrates coverage: a live badge on the tower card (updates instantly on every keystroke, the same targeted-DOM-patch technique the structural-complexity badge and the delivery-location sum hint both use), a new `## Coverage` section in the exported register, and a new "Coverage" section in the printed SA report.

**A naming collision was fixed as part of this change.** The register's own scope-exclusion bullet used to read *"...active-active operations..."* meaning infrastructure/HA architecture — an unrelated concept that, sitting next to this feature's own "Active-Active" label in the same document, read as self-contradictory to a client. Now reads "active-active infrastructure/HA architecture" — disambiguated, not weakened.

**`mkTower()`'s default demand was lowered from `inc:180, sr:70` to `inc:40, sr:15` as part of shipping this feature.** Reported gap: at the tool's old default demand, a single AMS tower's ticket volume alone (~14 base FTE) always dwarfed even the most demanding possible coverage floor (24×7 Active-Active, 8.4 FTE) — so neither the pre-existing Coverage window control nor this new Active-Active/Passive toggle could ever visibly move the number on an untouched default tower, which is exactly what a fresh user testing either control would hit. Verified the new default (~55 tickets/month) puts base FTE (≈3.3) right below the default 16×5 window's floor (4), so the coverage floor binds out of the box, and escalating the window or switching to Active-Passive now visibly moves Y1 FTE with zero other inputs touched (confirmed live via real UI clicks: 8.4 → 17.4 FTE across the coverage windows, 17.4 → 7.3 FTE switching to Active-Passive at 24×7). Confirmed harmless to the `[F p3]` regression test, which hand-builds its own tower fixture with explicit `inc`/`sr` values rather than relying on this default.

### 3.13 Structural-complexity demand proxy, Availability Class, and Service Tier presets

Three related gaps surfaced from actually mapping a real RFP (50Hertz Transmission GmbH / Elia Group, an infrastructure-and-platform-operation Lot dominated by IMS) onto the tool's inputs.

**1. Complexity-mode demand for IMS/DMS is now derived from structural complexity, not a generic apps table.** Before this change, an IMS/DMS tower's "Complexity" demand basis reused AMS's own apps-by-T-shirt-size proxy (`apps:{S,M,L,XL,XXL}`) — completely disconnected from the structural-complexity fields (environments/hostings/databases/security for IMS; data products/integrations/upstreams/downstreams for DMS) sitting right below it on the same card, and a poor conceptual fit besides (an infrastructure or data-platform team isn't naturally sized by "how many apps"). `rawVolume()` now branches by tower type: AMS keeps the apps table, unchanged; IMS/DMS instead compute `structCpxScore(t,B) × ticketsPerPoint`, a new editable Benchmarks constant per tower type (proposed defaults `4.5` for IMS, `3.4` for DMS, calibrated so the towers' own proposed field defaults land near the same ~55 tickets/month ballpark the AMS default already anchors to). History and MAU demand modes are untouched for every tower type. The rail shows the derived figure live ("score 12.0 × 4.5 tickets/mo per point ≈ 54 tickets/mo") instead of the now-irrelevant apps-count fields, and the register/print report narrate it alongside the existing structural-complexity tier line.

**2. Availability Class (A–E)**, a labelled preset over the existing raw `Availability target %` field — grounded in a real client RFP's own named scheme (95% / 99% / 99.5% / 99.9% / 99.95%), not sourced from `[F]`/`[P]`, so flagged `proposed`. Picking a class writes the same `t.avail` number `slaMod()` has always read (nothing about the SLA-stringency engine changed); picking "Custom" leaves the raw percentage field as the source of truth, exactly as before this existed. A tower's `availClass` is a label only, shown in the rail hint and in the register/print report ("Class D - Very High (99.9%)") instead of a bare, unattributed number.

**3. Service Tier presets (Gold / Silver / Bronze)**, a per-tower button row that bundles Coverage window, off-hours model, Availability Class, and all eight SLA fields into one click — because that is how real MSA/RFP documents (the 50Hertz one included) are actually structured, rather than four fields an SA sets separately and keeps consistent by hand. The three presets are generic, illustrative defaults, not any specific client's actual numbers, and every field stays fully editable afterward — clicking a preset doesn't lock anything, and a subsequent manual edit doesn't reset the tier label (the same non-strict convention the existing delivery-location presets already use).

All three ship as `applyAvailClass(t,v)` and `applyServiceTier(t,prId)` — small, directly self-tested functions shared between the click handlers and the test suite, rather than logic living only inline in a DOM event listener.

### 3.14 Transition phase — KT → Shadow → Reverse shadow

A ramp-up period *before* service start, reported alongside the estimate but never folded into Y1 FTE — it happens before Y1, not during it. Three phases, each a duration (weeks) and a team size (as a fraction of the steady-state Y1 team, hypercare stripped back out since `runEngine` already puts hypercare inside Y1):

| Phase | Meaning | Default weeks | Default team (× steady-state) |
|---|---|---|---|
| KT | Knowledge transfer | 6 | 50% |
| Shadow | Incumbent leads, we observe | 4 | 80% |
| Reverse shadow | We lead, incumbent backs up | 4 | 100% |

A fixed **core FTE** (default 2 — the transition manager and leads) is present throughout all three phases on top of the ratio-based headcount. A **legacy estate stretch** (default +25%) lengthens every phase when `eng.estate==="legacy"` — an unfamiliar, undocumented system genuinely takes longer to transfer. **Engagement type re-seeds KT weeks** the same way it already re-seeds the confidence/risk sliders (§3.10): greenfield 3 weeks (a system we already know), brownfield 6 (the conservative default). `transitionPlan(S,base)` computes the phase-by-phase FTE and person-months; `chartTransition` renders it as a ramp chart against the steady-state Y1 line. `proposed` throughout — the phase lengths, ratios and stretch factor are this estimator's own calibration, not from `[F]`/`[P]`.

### 3.15 AIOps efficiency calculator

The scenario's own YoY savings curve (§3.1) is a top-down commitment — a percentage the framework says a given scenario should hit, not a bottom-up sum of specific automations. The calculator is the bottom-up version: pick the actual AIOps use cases this deal will build from the existing `USECASES` catalogue (§5), and for each one set its deflection % at full adoption, its start year, and an adoption ramp in months. `calcShares(S,y)` combines whichever solutions are switched on **multiplicatively** — `1 − ∏(1 − share)` — so stacking solutions can never exceed 100%, and the combined figure is still clamped to the same per-tower automation ceiling (`towerCeiling`) the scenario curve already respects.

Two modes:
- **What-if (default)** — the calculator computes and displays its own numbers (FTE saved, AIOps-engineer overhead, net saving, payback period per solution) without touching the actual estimate. `deflectionAt()` still reads the scenario curve. Confirmed by self-test to leave every one of the four scenarios byte-identical to a state with no calculator at all.
- **Driving** (`aiopsCalc.drive:true`) — `deflectionAt()` reads `calcShares(S,y).raw` instead of the scenario's compounding YoY formula, so the named, costed solutions *are* the estimate rather than a side calculation next to it.

**Seven core L2 use cases are on by default** (Knowledge retrieval, Ticket auto-classification, Alert triage, Ticket summarization, Intelligent alerting, Anomaly detection, Runbook suggestion) — chosen because their combined effect at full adoption (~24%) clears the 1:4 AIOps break-even (20%, §6 point 2); the four prerequisite-free ones alone (~12%) never would, which would make a first look at the calculator show a net loss before anyone touched a setting. **AIOps engineers are phased in with the roadmap**, the same rule `runEngine` uses — charged only from the year deflection actually starts, so the calculator's net saving matches the estimate year by year and a year with no live solution carries no AIOps headcount.

**Realising the freed capacity** is a three-way split (reduce team / redeploy to backlog / commit as promised productivity) applied to the *net* FTE saved in the final year, normalised to sum to 100%. **Seed from O1 portfolio** copies whichever use cases the O1 optimizer (§5) actually funded, at the years it funded them, straight into the calculator — the two mechanisms describe the same decision (which AIOps solutions, and when) from two different angles (capacity-constrained optimization vs. hand-picked what-if), and this button lets one seed the other rather than requiring the same choices to be made twice.

**A portfolio vs. curve check** (`calcVsCurve`) runs the engine both ways regardless of the current toggle, so the card can warn *before* the calculator is applied, not just after: because the scenario curve compounds every year while a fixed portfolio levels off once every selected solution is fully adopted, a named solution set frequently deflects less than the curve assumes in the later years of a longer term — the tool states this as "the scenario's later-year savings are not yet backed by named AIOps solutions" rather than leaving it implicit.

### 3.16 Outcome / KPI bands

Where the AIOps calculator (§3.15) is about sizing the team, this is about what gets *committed to the client* — service-credit and gain-share bands around the scenario's own contractual savings target, expressed in person-months, never price. The target itself is the same YoY curve `deflectionAt()` already compounds (`1 − (1 − yoy)^k` from the scenario's AIOps start year) — not "productivity vs. Y1," which hypercare and the brownfield uplift inflate and would overstate what's actually being promised.

- **Credit floor** (default 0.8× target) — modelled deflection below this triggers a service-credit discussion, capped at a configurable share of that year's annual effort (default 10%).
- **Gain-share trigger** (default 1.25× target) — modelled deflection above this splits the *excess* value with the client (default 50% our share).
- Everything between the floor and trigger is "meets," reported but with no credit or gain-share event.
- An indicative **MTTR reduction** KPI (`USECASE_MTTR`, a separate small proposed table from deflection %) shows the reliability story alongside the effort one — it never touches FTE, purely informational.

`outcomeModel(S,base,trad)` computes one row per year (target/floor/stretch/status), `chartOutcome` renders each year as a horizontal band with the modelled deflection marked against it. `outcomeReady` flags whether the scenario's own commercial-model recommendation (§3.1) already mentions "outcome" — a hint for whether these bands are contractually relevant to this deal at all, not a hard gate.

### 3.17 Saved Scenarios and Excel export

**Saved Scenarios** — name, save and compare up to three estimate variants, kept in this browser's `localStorage` only (never synced anywhere; Export/Import move them between machines as a JSON file). Every `localStorage` access is guarded — a private window or blocked site data makes the accessor throw, and the save path surfaces that as an alert rather than silently losing the estimate. Comparison metrics (`scenMetrics`) run each saved state through the full engine live, so the comparison always reflects the current code, not whatever was true when the scenario was saved.

**Export Excel** produces an 8-sheet `.xlsx` workbook (Summary, Year by year, Tower breakdown, Staffing plan, Transition, AIOps calculator, Outcome KPIs, Assumptions) with every number also visible on screen — see §9 for how the file itself is built with no library.

### 3.19 Assumptions grouped by category

The assumptions and risk register is still composed section by section from the live inputs, but it is now **shown, downloaded and exported grouped by category**: Source documents, Scenario & commercial, Coverage & locations, Scope & ownership, Complexity & delivery profile, Skills & roles, Transformation & AIOps, Confidence, risk & contingency, Client responsibilities, and Calibration & source notes. A section the tool does not know yet appears under Other and is never dropped. The grouped view is on the register card (with a plain-text version underneath for copying and the `.md` download), in the Download summary and Print report, in the Customer summary (which shows its client-safe sections under the same headings) and in the **Assumptions** sheet of the Excel workbook (category headings in bold). The wording of each section is unchanged. A self-test checks that no section is dropped or left uncategorised.

### 3.21 On-call allowance from P1 volume

An Active-Passive tower discounts its off-hours shifts to an **on-call allowance**. By default this is the flat factor in Benchmarks (15%). Choosing **From P1 volume** (Benchmarks, `proposed`, taken from the Estimation Workflow) replaces it with:

```
allowance = standby % (default 10%) + P1s a month (all hours) x hours per P1 call-out (default 3) / 728 hours a month
```

P1s arrive around the clock, so the busy share does not depend on how many hours are on call. P1s a month comes from each tower's incident volume times its P1 share in the severity mix (so it follows estate complexity and the yearly inflow), or from the **P1 incidents a month** box if you enter one (shared across towers by incident volume, scaled by the yearly inflow). The default stays flat 15%, so no existing estimate moves. The allowance changes the team only where the coverage floor binds. It appears in the floor note, the Delivery windows card and the register. Four self-tests cover the flat default, the P1 formula, the override and the effect on the floor.

### 3.20 Delivery windows: overlap, on-call and gaps

A deal-level view, **analysis only unless you switch it on**, of how the delivery locations' hours line up. In the rail, the **Coverage & delivery windows** section (right after Service towers) holds each tower's **Service tier preset, Coverage window, FTE per shift and Out-of-office-hours coverage** (moved here from the tower cards; their behaviour is unchanged) and, below them, **Delivery windows by location**, which takes the customer time zone (UTC offset), when the support window starts, and, for each location of the chosen region, its UTC offset and one or more working windows in its own local time (**Active** or **On-call**). In the results, **Delivery windows** draws a timeline on the customer's clock: one row per location with that location's local time in each cell (green active, orange on call), a **Required** row, and an **Uncovered** row when something is missing.

- **What is required** comes from the towers: the window is the longest tower window (for example 24x7). If any tower is Active-Active, or the window is 8 hours, the whole window needs active staff. If every tower with a longer window is Active-Passive, only the business hours (8, from the business-hours start you set) need active staff and the rest of the window needs someone on call.
- **It reports** active hours covered, hours covered on call only where active staff were needed, hours with no cover at all (with the time ranges), overlap (two or more locations active at once, with the pairs) and hours worked outside the window, plus a table comparing each location's share of active hours with its % in the location mix (flagged when more than 10 points apart).
- **Automatic layout.** Until you set windows, they are laid out from the location mix: the active hours are cut into slices in proportion to the mix, in half-hour steps, and, for Active-Passive, the location named as the on-call carrier for the region covers the rest on call. Self-tests confirm the automatic layout leaves no gap for every region, window and off-hours model. **Lay out evenly** redoes it; **Back to automatic** clears your windows.
- **By default it never changes FTE or the location mix.** A self-test runs the engine with and without custom windows and requires identical totals.
- **Optional: let the windows set the coverage floor.** Tick **Let these windows set the coverage floor** in the same rail section. The floor of each tower whose window is the deal's longest is then scaled by (staffed shifts from your windows) ÷ (staffed shifts the declared window gives), where staffed hours are active window hours plus on-call window hours × the on-call allowance, and an Active-Passive tower's weekends count as on call, as in the shift formula. Windows that reproduce the declared window give exactly ×1.00 (checked for every region, window and off-hours model); overlap and extra hours raise the floor; uncovered hours lower it, and the card says so. The location mix is still never changed, and the floor only changes the team when it binds (it is above the work-based FTE).
- Once you have set windows they also appear in the register (under Coverage & locations), the Download summary and the Customer summary.

### 3.18 Download summary and Customer summary

Two standalone HTML files, built from the same numbers as the screen. Neither contains script, a rate card or a price, and both are generated in the browser (inside the claude.ai viewer each download asks you to confirm; on Netlify it downloads directly).

**Download summary** saves the SA-only report that **Print / Save PDF** shows (scenario posture, service responsibility, delivery location, year by year, coverage, traditional vs AI-driven, the role and grade staffing plan, tower breakdown, uncertainty, transition, AIOps and outcome model, confidence, AIOps roadmap, verification and the assumptions and risk register) as one `.html` file you can open, share or print. File name: `damo-estimate-summary-<service lines>-<date>.html`.

**Customer summary** is a client-facing page. Always included: how the client is covered (support window, availability and off-hours model per service), what is in scope (how each service was sized, who provides L1, L2 and L3, P1 response and restore), the Year 1 team by role, by delivery location and by grade, the team over the contract (with the hypercare note), the transition, what we need from the client, the assumptions (the register's coverage, service responsibility, inclusions, exclusions, volume band and special-role sections, with the framework source tags removed), and what would change the team size. Clicking the button first asks three questions, all ticked by default:

| Option | Adds |
|---|---|
| Contingency, confidence and risk | Contingency FTE and % in the Year 1 team and each year, the confidence band and posture, the estate-complexity and confidence sections of the assumptions |
| Effort and benchmarks | Tickets a month, ticketing and other effort hours per tower, resolution effort per ticket by level, SR and CR effort by complexity, pass-through by year, productive share and hours per FTE, the delivery-profile section |
| Savings and the AIOps comparison | Each year against Year 1, the with and without AIOps table and person-months saved, the AIOps solutions applied and the AIOps roadmap |

Untick any of them to leave that content out of the file. The choice is remembered until the page is reloaded. Three self-tests cover the summaries: roles and locations each add up to the Year 1 team, the three options really remove what they name, and the files are complete HTML with no script and no `$`.

---

## 5. The optimization layer

Four combinatorial sub-problems, each stated as a **QUBO** and solved **classically** in-page.

| | Problem | Form | Solver |
|---|---|---|---|
| **O1** | Which AIOps use cases to fund, and when | Multi-period knapsack with precedence | Branch-and-bound, exact |
| **O2** | Follow-the-sun roster | Set cover over 21 weekly shifts | Greedy + local search, with an analytic lower bound |
| **O3** | Team shape in whole people | Integer programme with upward substitution | Bounded lattice enumeration, exact |
| **O4** | Uncertainty on the estimate | Monte Carlo over volume/ARE/deflection priors | 3,000 samples, seeded and reproducible |

O4's priors widen automatically as the confidence score falls, so the Annexure 1 model actually moves the numbers instead of decorating the page.

**O1's use-case tiering was revised.** `USECASES` gates every use case to a single tier (`ow[u.tier]` in `o1Data()`) — a use case whose tier isn't owned is excluded from the fundable portfolio outright, and anything prerequisiting it becomes unfundable too, however deep the chain. Four front-line use cases (Knowledge retrieval, Ticket auto-classification, Alert triage assistant, Ticket summarization) were originally `tier:"L1"`. Moved to `tier:"L2"`: this tooling is built and operated as L2 engineering work that supports the L1 team directly, rather than requiring DAMO to own L1 itself to get credit for it — a real deal (client keeps their own L1 desk, DAMO holds L2/L3) had its entire O1 portfolio collapse to two prerequisite-free items before this change, since every other use case's precedence chain rooted in one of those four. **The trade-off, stated rather than hidden:** with no `tier:"L1"` use case left in the catalogue, a deal where DAMO owns *only* L1 (not L2/L3) now finds nothing fundable in O1 at all — the previous version had exactly the opposite gap. One tier per use case cannot avoid both simultaneously; this is a `proposed` calibration choice, editable in the `USECASES` const, not a framework fact.

### Quantum algorithm mapping

| Algorithm | Attaches to | Assessment |
|---|---|---|
| **QAOA** | O1, O2, O3 | Best fit. Variational solver for exactly the Ising/QUBO form these already export — no reformulation needed. |
| **Quantum annealing** | O1, O2, O3 | Best fit. Native QUBO hardware; the exported `Q` matrix goes straight in. |
| **QAE** | O4 | Cleanest theoretical case. The estimate is `E[f(X)]`; QAE gives `O(1/ε)` against classical `O(1/ε²)`. |
| **VQE** | O1–O3, marginally | Our Hamiltonian is diagonal, so VQE degenerates into QAOA without the structured ansatz. |
| **Grover** | O3, technically | Quadratic speedup on a ~700-config lattice that enumerates instantly; the oracle is classical anyway. |
| **HHL** | **No fit** | Sparse linear solve. Nothing here is a large ill-conditioned system. |
| **Quantum walks** | **No fit** | Graph traversal. The precedence DAG has 14 nodes, the roster graph ~30. |

**Three of seven attach to real sub-problems.** At DAMO instance sizes classical exact methods win outright — the QUBO is here as a rigorous problem statement and an annealer-ready hand-off, not a performance claim. Saying that plainly is more credible in a bid than claiming all seven apply.

The **QUBO inspector** shows variable count, sparsity, penalty weights and the energy check, and exports `Q` as JSON for a QAOA or annealer toolchain.

---

## 6. Seven things the tool will tell you that the framework does not

**1. Annexure 2 has an arithmetic error.** The worked risk-drag example lists nine weighted values summing to **14.25**, but the total row prints **15.3**. The band conclusion (Medium) survives either way. The tool sums the rows and flags it.

**2. At 1:4, AIOps deflection must exceed 20% just to break even on headcount.** An embedded engineer at 1:r adds 1/r to the team, so the team only shrinks once `d > 1/(r+1)` — 20% at 1:4, 11% at 1:8. In Scenario 3 the engineers arrive in Y2, the same year deflection starts, at about 13.5% — below the 20% break-even at 1:4 — so **the first AIOps year can still be larger with AIOps than without**. That is a genuine investment year. Say so in the proposal rather than letting the client find it.

**3. Effort-based sizing says you need almost no L1.** At 15 min ARE charged only on tickets *resolved* at L1, L1 is under 1% of resolution effort — so the integer programme allocates ~0% of the team to L1 while the pyramid convention allocates 45%. Both are defensible; L1 headcount is driven by coverage presence and triage throughput, not resolution hours. Size L1 from the roster, and say which basis the proposal uses.

**4. The automation ceiling caps the stretch curve.** On a mixed AMS+IMS+DMS deal the volume-weighted ceiling is ~56%, so the 18%→65% template flattens at Y4 rather than reaching 65%. The tool marks the year it binds.

**6. Handing L1 to the customer saves almost nothing.** On the default deal, full stack sizes at 23.7 FTE and "L1 by customer" sizes at **24.3** — it goes *up*, because L1 is 0.7% of resolution effort while the new ownership interface costs 4%. The real saving from moving L1 out is the rostered coverage, not the effort. If the commercial case for the split is headcount, reduce *FTE per shift* too, or the split buys you nothing.

**7. Split ownership means you do not control your own inflow.** If another party runs L1, *their* resolution rate sets your L2 volume. The estimate assumes benchmark 70% pass-through; if the incumbent under-performs it, your volume rises with no contractual trigger. A volume-band clause does not protect you — you need a **pass-through band** as well.

**5. The source is inconsistent on productive hours.** The page-3 illustration divides by **160**; Scenario 3 Step 1 says **150**. Exposed as an input, defaulting to 160, with the discrepancy labelled.

---

## 7. Verification

The **Verify against framework** card runs 229 checks on every render. Each is a worked example from the source, or a synthetic case for logic that has no source-document analogue (the print report, the RFP intake extractors, the structural-complexity model), so a green run means the engine reproduces the document it claims to implement and the newer mechanics behave as designed:

1–3. Page-3 illustration → A = 421 hrs, B = 105 hrs, base FTE = 3.3
4. Coverage shift maths, 24×5 at 2/shift → 6.0 FTE
5–7. Annexure 1 score = 64.8; Annexure 2 drag = 14.25; effective = 50.6, band Medium
8. Scenario matrix wiring across all four combinations
9. O1 branch-and-bound = exhaustive enumeration on a 6-use-case instance
10. O1 QUBO energy = −objective at the solver's assignment (catches under-weighted penalties)
11. Monte Carlo unit sample reproduces the deterministic run
12. Role and grade split conserves total headcount
13. Grade mix sums to 1 and stays non-negative at every shape
14. Handing L1 to the customer removes L1 effort and L1 roles
15. An ownership interface applies a coordination uplift
16. AMS L3 switches cleanly from SSE to Developer at the evolution threshold — never both, never neither
17. SRE and QA are gone from the role map, tower flags and benchmarks; a stale `tower.sre` changes nothing (the map is now seven roles: pse, sse, dev, isu, dse, mle, sdm)
18. Special roles add exactly their FTE to Total FTE, never alter delivery or AIOps, honour per-year overrides, and conserve headcount (role/grade and location)
19. A mixed AMS+IMS deal loads SSE and Infrastructure Support Engineer simultaneously
20. Every engagement includes an SDM
21. DMS Data Engineer spans both L2 and L3 via the tier2 mechanism, exactly
22. Grade ladder is Lead:Senior:Consultant = 1:2:4, no Principal
23. SDM (governance tier) is graded 100% Lead at every team shape
24. IME region ignores locMix and resolves to 100% India
25. EU location split conserves headcount per role and in total
26. Location split normalises when the entered percentages don't sum to 100
27. The print report builds cleanly, contains no optimization/quantum terms, and includes every core SA section
28–30. Intake `extractTerm` handles month-count and spelled-out-number phrasings, including the tie-break-up rule (a detected 4-year term maps to 5, not 3)
31. Intake `extractTowers` picks up all three service lines independently from one paragraph
32. Intake `extractIncidentVolume` on a "N incidents per month" phrasing
33. Intake `extractSLA` normalises an hours-stated restoration target to minutes
34–35. Intake `extractCoverage` on 24×7 and "business hours" phrasings
36. Intake `extractAIOps` on an automation-keyword sentence
37. Intake `extractMAU` on a comma-formatted user count
38. Intake `extractOwnership` — nearest-keyword-wins, not first-match-wins (a document naming a customer-owned L1 elsewhere in the text must not mis-tag an L2/L3 clause that's actually retained)
39. Intake `applyExtraction` end-to-end on a synthetic multi-field RFP snippet, asserting term and tower set
40. Intake `extractAll("")` degrades to exactly `seedRoles(defaults())`, never throws
41. `deepMergeState` — a partial `{eng:{term:5}}` updates only that field; every sibling of `eng` survives, unlike the shallow `Object.assign` the JSON-file Import button uses
42. Intake tower-replacement rule — text naming only two service lines produces exactly those two towers, no leftover default AMS
43. Intake `extractTabularIncidents` on a pipe-flattened incident-history sheet (what `parseXlsxText` produces) — correct aggregate volume, per-priority SLA in minutes, and a derived percentage mix
44. Multi-document merge — one document supplying contract term and another supplying tabular incident data combine into a single extraction pass, exactly as `combinedIntakeText()` feeds the live intake screen
45. `defaults().docSummary` starts `null` — a real summary can only ever arrive via the Claude hand-off, never generated by the page itself
46. `deepMergeState` with only `docSummary` in the partial JSON sets it without disturbing any sibling field
47. `buildRegister` includes a `## Document summary` section when `docSummary` is set and omits it when `null`
48. `buildPrintReport` includes a "Document summary" section when set — confirming it sits on the "include" side of the print report's SA-only content boundary, not excluded like O1–O4
49. A non-string `docSummary` from a malformed paste doesn't throw when later rendered or stringified
50. APAC location split conserves headcount per role and in total — a 2-key catalogue with no onshore/nearshore/offshore labels
51. NA location split conserves headcount per role and in total
52. Legacy region/locMix migration is behaviour-preserving — a raw `region:"europe"` + flat `locMix` state, run through `seedRoles`, produces identical `locationSplit` results to an equivalent freshly-constructed new-shape state, not just the same shape
53. Per-region memory — setting an EU mix, switching to APAC and setting a mix there, then switching back to EU leaves the EU mix exactly as it was
54. Engagement type 'greenfield' seeds conf[4]=4, risk[2,3,4]=0.25
55. Engagement type 'brownfield' seeds conf[4]=2, risk[2,3,4]=0.75
56. Switching engagement type always re-seeds rather than preserving a manual edit
57. `defaults().eng.engagementType` defaults to `'brownfield'`
58. `confScore`/`riskDrag`/`bandOf` compute without throwing for both engagement types
59. `seedRoles` backfills a missing `eng.engagementType` to `'brownfield'` for legacy saved states, without touching that state's own `conf`/`risk` values
60. Brownfield Y1 total FTE exceeds an otherwise-identical greenfield run — the actual behavioural fix, not just the slider seed
61. The brownfield uplift tapers to exactly zero by Y3, so a 3-year brownfield and greenfield run converge in the final year
62. The [F p3] regression state (`T1`) carries no `engagementType`, so it picks up zero uplift — the isolation the whole feature depends on to keep reproducing 3.3 FTE exactly
63. `seedRoles` backfills a bench field missing from an old saved hash/import (e.g. `brownfieldUplift`) — the same shallow-merge gap `eng.locMix` already had, now closed for `bench` too
64. A partial AI-extracted tower (missing `enabled`, `own`, `apps`, `mau`, `inc`, `sr`, `mix`) is silently excluded from `S.towers.filter(t=>t.enabled)` before the `backfillTowers()` fix — reproduces the live bug exactly
65. The same partial tower is complete (`enabled:true`, `own`/`apps`/`mau` present) and included in the engine after `backfillTowers()`
66. `backfillTowers()` never overwrites fields the source JSON actually provided — `type`/`mode`/`coverage`/`avail`/`sla.P1x` all survive untouched
67. Y1 FTE for the backfilled tower reflects real demand (well above the ~0.3 governance-only baseline the live bug produced), not just the tower being present
68–70. IMS structural-complexity tier bands: hand-picked low/high inputs, and the tower's own proposed defaults (score 12) land at Medium
71–73. DMS structural-complexity tier bands: same pattern, including an "Other" platform pushing a high-input tower over the High threshold
74. `structCpxTier` returns `null` for AMS regardless of field values, even contrived large ones
75. IMS B-factor bump strictly increases across escalating environment counts (1, 10, 50, 100) well past the High cut-point — the regression test for a real reported defect where the earlier flat-per-tier bump silently stopped moving the FTE once a tower crossed into "high," no matter how much higher the inputs went afterward
76. IMS B-factor bump matches the exact `score × bumpPerPoint` formula below the cap
77. IMS B-factor bump is capped at `bench.structCpx.maxBump` only for a genuinely extreme, adversarial input
78. DMS B-factor bump strictly increases across escalating data-product counts (1, 10, 50, 100) — same no-plateau regression test as IMS
79. DMS B-factor bump matches the exact `score × bumpPerPoint` formula below the cap
80. DMS B-factor bump is capped at `bench.structCpx.maxBump` only for a genuinely extreme, adversarial input
81. AMS's B-factor is never bumped, even with contrived complexity-field values sitting unused on the shared tower shape
82. *(retired)* Information Security Engineer gating on the `security` checkbox — removed with the role catalogue
83. *(retired)* Data Architect / Data Strategist gating — removed with the role catalogue
84. `backfillTowers()` backfills the new IMS structural-complexity fields on a legacy partial tower to `mkTower()`'s defaults, landing at Medium tier
85. `structCpxTier` does not throw and degrades safely to Low on a raw legacy tower object missing the new fields entirely (the hash-restore/Import path, which doesn't call `backfillTowers`)
86. `seedRoles` backfills the entire `bench.structCpx` sub-object for an old saved hash/import predating this feature — same shallow top-level pattern already relied on for `brownfieldUplift`
87. A negative IMS field (e.g. `envCount:-50`) clamps to zero contribution rather than driving the score — and the B-factor bump — negative
88. A negative DMS field clamps to zero contribution the same way
89. A negative field never cancels or reduces another field's valid, positive contribution to the score
90. Non-numeric garbage in a structural-complexity field degrades to zero, never `NaN` (which would otherwise poison every downstream FTE calculation for that tower)
91–94. Active-Active reproduces the exact pre-existing shift count for all four coverage windows (8x5/16x5/24x5/24x7) — the backward-compatibility proof
95. Active-Passive on 24x7: business hours (5) + off-hours delta (16) × 0.15 = 7.4
96. Active-Passive is meaningfully cheaper than Active-Active on the same 24x7 window
97. An 8x5 tower ignores the off-hours model entirely, regardless of its value
98. Through `runEngine()` end-to-end: Active-Passive's coverage floor is strictly lower than Active-Active's on an identical 24x7 window
99. A shared roster with mixed off-hours models sizes to the more demanding (Active-Active) tower
100. `effShiftsPerWeek` degrades safely to Active-Active on a legacy tower missing the off-hours model field entirely (the hash-restore/Import path, which doesn't call `backfillTowers`)
101. The `[F p3]` regression state is unaffected by the off-hours feature — still reproduces 3.3 FTE
102. `oohLocationFor`: IME is always India (only one location exists)
103. `oohLocationFor`: EU defaults to Offshore (India)
104. `oohLocationFor`: APAC defaults to China (proposed — no cost data to derive it from)
105. `oohLocationFor`: NA defaults to Offshore (India)
106. `oohLocationFor` honours a Benchmarks override away from the proposed default
107. `seedRoles` backfills `bench.oohLocationByRegion` and `bench.oohOnCallFactor` missing from an old saved hash
108. AMS's Complexity-mode demand is unaffected by this feature — still the apps-by-size table, not the structural-complexity score
109. IMS Complexity-mode demand equals `structCpxScore × ticketsPerPoint`, not an apps-by-size table
110. DMS Complexity-mode demand equals `structCpxScore × ticketsPerPoint`, not an apps-by-size table
111. An IMS tower in History mode ignores its structural-complexity fields entirely, same as before this feature
112. A DMS tower in MAU mode ignores its structural-complexity fields entirely, same as before this feature
113–117. `applyAvailClass` sets `t.avail` to the correct percentage for each of Classes A–E
118. `applyAvailClass('custom')` leaves `t.avail` untouched — a hand-typed value survives switching to Custom
119. `applyServiceTier('gold')` sets coverage, off-hours model, Availability Class, `avail`, and every SLA field at once
120. `applyServiceTier('bronze')` sets a different coverage/availability than Gold, proving the presets are genuinely distinct, not just relabeled
121. `mkTower()` defaults `availClass` and `serviceTier` to `'custom'` — no preset is silently applied to a fresh tower
122. The `[F p3]` regression state is unaffected by this feature — still reproduces 3.3 FTE
123. Knowledge retrieval, Ticket auto-classification, Alert triage assistant and Ticket summarization are `tier:"L2"` in `USECASES`, not `L1`
124. A deal where DAMO owns L2/L3 but not L1 (e.g. the client keeps their own L1 desk) now excludes nothing on tier alone — `o1Data().excluded` is empty
125. …and the full precedence chain (Intelligent alerting → Automated RCA, Runbook suggestion → Self-healing, Anomaly detection → Predictive alerting/scaling → Chaos engineering) is reachable in that same deal, not just the two prerequisite-free L3 items
126. The trade-off is asserted explicitly, not left implicit: a deal where DAMO owns *only* L1 now has zero in-scope AIOps use cases
127–132. Active-Active reproduces the exact pre-existing shift count for all six coverage windows (8x5/8x7/16x5/16x7/24x5/24x7), including the two new ones
133. `SHIFTS["8x7"]` is 7 shifts/week and `SHIFTS["16x7"]` is 14, matching the shift-count formula
134. Active-Passive on 8x7 discounts only the weekend delta: business hours (5) + (2 × 0.15) = 5.3
135. `o2Solve` on an 8x7 tower resolves 7 days × 1 block/day — not the 24-hour fallback a hardcoded ternary used to produce for any coverage string it didn't recognise
136. `o2Solve` on a 16x7 tower resolves 7 days × 2 blocks/day, same fix
137. `extractCoverage` picks up 8x7 and 16x7 phrasing
138. `eng.term` runs the engine for exactly 2 and exactly 4 year-rows — direct values now, not values `nearestTerm` used to remap to 1/3/5
139. The AIOps calculator in what-if mode leaves the estimate byte-identical to a state with no calculator at all, across all four scenarios
140. Driving the calculator with every solution switched off gives exactly zero deflection, every year
141. Stacked solutions never exceed the tower automation ceiling, even with every solution set to 100% deflection from Y1
142. A 12-month adoption ramp averages 78/144 of full effect in its first year — the linear-ramp-by-month arithmetic, not an approximation
143. Reduce + redeploy + commit always adds back to exactly the net FTE saved, whatever the three-way split
144. Transition: a steady team of 10 with a core of 2, at the default 6/4/4-week phases and 50/80/100% ratios, totals 30.02 person-months by hand-calculation
145. Transition: a legacy estate stretches every phase length by exactly 25%, scaling the person-months total the same way
146. Outcome target: Scenario 3 compounds its 13.5% YoY figure from Y2, so Y3's target is exactly `1 − 0.865²`
147. Portfolio vs. curve: on a 5-year Scenario 3 term, the default calculator solutions under-deflect the scenario curve only in Y3–Y5 (where the curve keeps compounding and the fixed portfolio has levelled off) — and never when AIOps itself is off
148. Applying the calculator matches the headline estimate exactly: its net FTE saved equals no-AIOps FTE minus the driven estimate's FTE, every year, with AIOps engineers counted from the year deflection starts in both
149. Excel export round-trips through this file's own zip reader — a cell value and its CRC32 checksum both survive a full write-then-read cycle
150–213. Later additions (summarised): SR and CR AREs by complexity, mix weighting, normalisation of counts, SR tier routing and fall-through, the estate-complexity tilt, and legacy-link backfill; the CR bucket and its L2/L3 ownership gate; Singapore and the 'Singapore only' preset; AIOps phased in with deflection and the Y1→Y2 step-down note; the reporting-period override and extraction prompt parity; Special roles (add exactly their FTE, per-year override, conservation, legacy backfill); the fixed role map (SRE/QA gone, IMS L2+L3 one role, Developer threshold); estate complexity (pyramid per level, contingency Y1/Y2+, overrides, exclusions, headcount conservation, effective severity mix, register section); AIOps engineers follow the scenario and add to Total FTE; new-tower defaults (L1 = Customer, SR/CR mixes); observed pass-through, tower labels, existing-team and opportunities; extraction: table-aware PDF rows, quote verification, review model (grouping, apply/strip), partial nested towers, prompt rule markers

---

## 8. Calibration backlog

These are **proposed defaults derived from the framework's ranges**, not from your engagements. Every one is editable in the Benchmarks panel and listed in the exported register.

- P1–P4 tier-of-entry matrix
- Per-tower ARE multipliers, B-factors and automation ceilings for AMS / IMS / DMS
- Team-shape splits (pyramid 45/35/20, diamond 25/50/25, inverted 15/45/40)
- Role policy: the fixed per-tower role map, the AMS evolution threshold (default 30%) that switches SSE to Developer at L3, and the estate-complexity pyramids (1:2:4 / 1:2:3 / 1:2:2)
- Estate complexity: the Y1 contingency % per level (5 / 7.5 / 10, from the Estimation Workflow), the Y2+ cap (6%), and the severity / SR / CR tilt (0 / 10% / 20%, this tool's own calibration)
- SR and CR AREs by complexity (SR 0.25 / 0.5 / 1.5 h, CR 4 / 8 / 16 h), their default mixes (60/30/10 and 50/35/15) and the SR tier routing
- Delivery location presets for APAC and NA (proposed guesses — China/Australia and LATAM-Ecuador/India splits with no framework or client data behind them yet, unlike EU's presets); the split is applied uniformly to every role, not per role — if specific roles need to be pinned to specific locations, that's a follow-up, not something the current mix does
- Governance load, hypercare duration and multiplier
- AIOps use-case catalogue: build effort, deflection benefit and prerequisites
- IMS/DMS structural-complexity weights, cut-points and B-factor bumps (§3.11) — grounded in the supplied deck's tier framing, not `[F]`/`[P]`; the weights, thresholds and default field values all need calibration against real IMS/DMS engagements
- Off-hours on-call factor (§3.12, default 15% of a dedicated shift) and the off-hours on-call location by region (EU/NA → Offshore, APAC → China) — neither is derived from real cost/rate data, since the tool has none; both are stated conventions pending real engagement data
- IMS/DMS complexity-proxy `ticketsPerPoint` (§3.13, default 4.5 for IMS, 3.4 for DMS) — calibrated only so a fresh tower's own field defaults land near the AMS default's ~55 tickets/month, not against any real engagement's actual ticket volume
- Availability Class percentages and Service Tier preset coverage/SLA numbers (§3.13) — a generic, illustrative A–E/Gold-Silver-Bronze scheme grounded in one real client RFP, not calibrated as a house standard; treat the tier presets as a starting point to edit per deal, not a target to match
- Transition phase lengths, team ratios, core FTE and legacy stretch (§3.14) — a proposed KT/Shadow/Reverse-shadow shape, not sourced from `[F]`/`[P]` or any specific engagement's actual transition experience
- The seven default-on AIOps calculator solutions and their per-solution deflection/ramp figures (§3.15) — chosen so the default selection clears the 1:4 break-even, not because those seven are necessarily the right seven for a given deal
- `USECASE_MTTR`, the indicative MTTR-reduction table (§3.15/§3.16) — informational only, never touches FTE, and not derived from real incident data
- Outcome band multipliers — credit floor (0.8×), gain-share trigger (1.25×), service-credit cap (10% of annual effort) and gain-share split (50%) (§3.16) — generic contractual-shape defaults, not calibrated against any real outcome-based contract

The highest-value calibration is the **AIOps use-case effort and deflection numbers**, because they drive O1's funding decisions, the calculator's default selection, and the whole savings narrative.

---

## 9. Technical notes

- Single HTML file. Inline CSS and JS, hand-rolled inline SVG charts, no network requests. One deliberate library exception: pdf.js is bundled inline for PDF text extraction (§2) — everything else (including .docx/.xlsx parsing) is dependency-free.
- Theme-aware light/dark. Note that the UA stylesheet resets `color` on `<table>`, so it is set explicitly — without that, every cell renders in light-theme ink under dark mode.
- Rendering is debounced with `setTimeout`, not `requestAnimationFrame`: rAF is throttled to zero in a hidden or background tab, which would leave the results pane blank until focus.
- All non-ASCII characters in the script are `\u` escapes so the page is encoding-proof regardless of how it is served.
- Monte Carlo uses a seeded xorshift PRNG, so results are reproducible across runs and machines.
- **Print / Save PDF** builds a dedicated, always-current report (`#printReport`, hidden on screen) containing only what a solution architect needs — effort, FTE, roles, confidence, the assumptions register — and deliberately excludes O1–O4, the QUBO inspector and the quantum-algorithm mapping. `@media print` shows only that report regardless of what triggers printing (the button, or the browser's own Ctrl/Cmd+P), and forces black-on-white regardless of the on-screen theme. A self-test asserts the report contains no optimization/quantum terms and all core sections.
- The **Print / Save PDF** button no longer calls `window.print()`, `window.open()`, or a Blob download at all — in this deployment, all three turned out to be blocked by the Artifact's iframe sandbox (confirmed the hard way: even the pre-existing Export JSON button, which uses the same `download()` helper as everything else, was blocked in the same environment). Any scripted escape from a sandboxed iframe is unverifiable from inside the page, so the fix stops trying to escape it. `showPrintPreview()` just adds a `print-preview` class to `<body>`, which CSS uses to hide `.shell` and show `#printReport` in place of it — the exact same mechanism the Theme button already uses (toggling `data-theme`), which is known to work because plain DOM/attribute changes need no sandbox permission at all. From there, the user's own **Ctrl/Cmd+P** — a browser-chrome action, not a scripted call — prints whatever is visibly on screen, which is only the SA-only report. `btnBackFromPrint` removes the class to return to the live tool.
- The **RFP intake screen** (§2) follows the same lesson as the print fix: `showIntake()`/`hideIntake()` toggle an `intake-active` class on `<body>`, nothing scripted or sandbox-dependent. `extractOwnership` deliberately does *not* pick "whichever owner keyword's regex match starts earliest in the raw text" — an earlier version of that logic mistagged L2/L3 as customer-owned in a sentence like "L1 is provided by the customer; DAMO retains L2/L3," because "customer" happens to occur earlier in the string than "DAMO" even though it's contextually irrelevant to L2/L3. The fix collects every owner-keyword occurrence and every tier-token occurrence separately, then assigns each tier the *nearest* owner keyword by character distance (capped at 80 chars) — proximity, not document order. Self-test 38 guards this regression directly.
- The masthead's **Start from RFP** button exists because the intake screen's fresh-load landing gate turned out to be a one-time-only trap in production: it checks `location.hash`, but every render saves state to that hash, so a bookmarked/long-lived tab trips "not fresh" forever after the very first visit. The button re-opens intake unconditionally, resetting `INTAKE_REPORT` and `INTAKE_DOCS` to a clean single blank row each time, regardless of hash state.
- `parsePdfText`'s position-aware run-joining (§2) was added after an early version — `content.items.map(it=>it.str).join(" ")`, a space between every pdf.js text run unconditionally — was caught inserting spaces inside words on a real extracted PDF (a run split mid-word by a font/kerning change became two runs, and the naive join turned "Services" into "Servic es," which silently broke a tower-name match). Verified by generating real test files (`docx`/`xlsx` node packages, `cupsfilter` for a real PDF) and round-tripping them through the actual parsers rather than trusting the code by inspection.
- **Copy prompt for Claude** (§2) reuses the exact `t.select(); document.execCommand("copy")` mechanism the register's own Copy button already uses — deliberately not `navigator.clipboard.writeText` (untested in this sandboxed deployment) and not a Blob download (confirmed broken here). Its target textarea (`#claudePromptText`) is positioned off-screen with `left:-9999px`, not `display:none` — a `display:none` element can't be `.select()`-ed for `execCommand("copy")` to work in every browser, so it has to stay in the layout, just invisible.
- **Downloads actually work inside the Artifact viewer now.** The plain `<a download>`/Blob approach the "broken here" note above describes for print/popups turned out to affect every file-producing button the same way, including the pre-existing Export JSON. Fixed properly rather than worked around: `window.claude.use("downloads")` is requested once at load (`DOWNLOADS` module-level variable, `try`/`catch`-guarded since `window.claude` is absent on every non-Artifact host), and `download(name,text,type)` now checks for it first — inside the Artifact, a save goes through `DOWNLOADS.save({filename,data})`, which surfaces the viewer's own confirm/decline/rate-limit outcomes rather than silently doing nothing; on any other host (local file, Netlify) `window.claude` is simply absent and the original plain-link path runs unchanged.
- **Excel export (§3.17) is a from-scratch, dependency-free `.xlsx` writer** — `xlsxWrite`, `zipStore`, `crc32` — matching the file's existing no-library stance (the same reasoning that keeps everything but pdf.js hand-rolled, §2). A minimal SpreadsheetML package (`[Content_Types].xml`, `workbook.xml`, one `sheetN.xml` per sheet, a two-style `styles.xml` for bold headers) is zipped with **STORE**, not DEFLATE — no compression, so no need to reimplement or bundle a deflate encoder, at the cost of a somewhat larger file than a real zip tool would produce. Inline strings and numeric cells only (no shared-string table, no formulas) — everything the workbook needs is either text or a plain number already computed by the engine. Self-tested by round-tripping a real cell value and its CRC32 checksum through this same file's own `unzipEntry`/XML-parsing code (the same reader `extractTabularIncidents`, §2, already uses for uploaded `.xlsx` files) — the writer and the reader check each other.
