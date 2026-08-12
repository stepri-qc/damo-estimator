# DAMO Estimator — README

An interactive RFP sizing tool for the DAMO managed-services line. It takes engagement inputs (service towers, term, AIOps in/out, incident history, SLAs) and produces a defensible **effort and FTE** estimate with a year-on-year productivity curve, a named role-and-grade staffing plan, and an explicit confidence posture.

**It sizes effort and headcount only.** There is no rate card, no margin and no client price anywhere in the tool. That was a deliberate scope decision — pricing stays in the commercial workbook.

- **Live tool:** https://claude.ai/code/artifact/6182d787-5523-4e96-8b2b-ef126a234fc4
- **Interactive user guide:** https://claude.ai/code/artifact/dceb2605-9693-471c-a5c2-0b4481ed07cd  (source: `damo-estimator-guide.html`)
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
   - **Schema gotcha the prompt template exists to prevent:** `deepMergeState` replaces `towers[]` wholesale rather than merging per-tower, so an incomplete tower object from Claude would leave `undefined` fields that NaN out the engine downstream. The copied prompt explicitly instructs Claude to return complete tower objects (every field, matching `mkTower()`'s shape) — this is why the button exists rather than just documenting the schema in this README and hoping it's followed correctly each time.

Reloading a link that already carries a saved-estimate hash skips the intake screen entirely and opens straight on the dashboard, unchanged from before this feature existed.

**File parsing, format by format:**

- **.docx and .xlsx** are parsed natively, no bundled library. Both formats are a ZIP archive of XML internally, and modern browsers can unzip (`DecompressionStream("deflate-raw")`) and parse XML (`DOMParser`) with built-in APIs alone — `unzipEntry`/`readZipTextEntry` implement a minimal ZIP central-directory reader, `parseDocxText` pulls `word/document.xml` and reads `<w:t>` runs per paragraph, `parseXlsxRows`/`parseXlsxText` pull `xl/sharedStrings.xml` plus each `xl/worksheets/sheetN.xml` and resolve shared-string cell references into an actual table.
- **Incident-history spreadsheets are tabular, not prose** — "P1, 20, 15, 120" in cells doesn't match sentence-shaped regexes like "P1 response within 15 minutes." `extractTabularIncidents` scans the pipe-flattened sheet text for a header row containing a priority/severity column plus incident-count and response/resolution-SLA columns, then reads the data rows directly: it produces an aggregate incident volume (summed across P1–P4), per-priority SLA in minutes, and a derived percentage mix — merged into the same `report` shape the prose extractors produce, with tabular data taking priority when both a spreadsheet and prose text mention the same field (structured data is more precise than a regex guess).
- **.pdf is parsed with a real bundled parser (pdf.js).** PDF's internal structure — compressed content streams, font/glyph encoding — genuinely isn't something to hand-roll safely, unlike the ZIP-based formats above, so `pdf.min.js` and `pdf.worker.min.js` (Mozilla, Apache-2.0) are inlined directly into the HTML file: the main library as an executable `<script>` block (defines the `pdfjsLib` global), the worker as an inert `<script type="text/plain">` data block that's turned into a `Blob` worker only on first use, so nothing is ever fetched over the network. `parsePdfText` reconstructs readable text from pdf.js's positioned glyph runs itself, rather than naively joining every run with a space — pdf.js frequently splits a single word across two runs (a font or kerning change mid-word is enough), and blindly inserting a space between every run corrupts words at exactly those split points, which silently breaks keyword matching downstream. The join logic instead compares each run's actual x/y position to the previous one: a real horizontal gap gets a space, a vertical shift starts a new line, anything else concatenates directly.

Adds roughly 1.5 MB to the artifact (the pdf.js bundle) — well inside the 16 MB Artifact limit, and it's the only way to support real PDF upload; the alternative was leaving PDF as copy-paste-only.

### 2a. Extract with AI now — Netlify-only, one click, no copy-paste

**Netlify-only.** This button does not exist as a real capability on the claude.ai Artifact — a published Artifact cannot call an external serverless function, so the whole mechanism below is specific to `damo-estimator.netlify.app`. The regex extractor (2) and the manual copy-prompt-to-a-fresh-chat path (2, item 2) still work identically everywhere, including the Artifact.

On the Netlify deployment, **Extract with AI now** in the "Import Claude-prepared inputs" section sends `combinedIntakeText()` straight to a real backend — `netlify/functions/extract-inputs.mts` — which calls the Claude API (`claude-sonnet-5`, via `output_config.format` structured outputs so the response is guaranteed-valid JSON, not a hand-parsed prompt reply) and returns the result directly into the page. No copy-paste, no second chat window.

- **Same schema, same apply path, by design.** The JSON schema the function requests from Claude is exactly the shape `buildClaudePrompt()` already documents for the manual path — `docSummary`, `eng{term, aiMaturity, volumetrics, aiops, estate, region}`, complete `towers[]` entries. A successful response lands in the same `#intakeJson` textarea and goes through the same **Apply prepared inputs** → `deepMergeState(defaults(), json)` flow the manual path already uses — no second merge implementation to keep in sync.
- **"Omit what's unknown" is preserved, not just asked for.** Every field in the function's JSON Schema is nullable (`{"type":["string","null"]}` etc.) and the model is instructed to use `null` rather than guess. The function then recursively strips every `null` (and any now-empty object/array) before responding — `stripNulls()` — so the JSON that reaches the browser only ever contains fields Claude actually found evidence for. This is what makes `deepMergeState`'s "omitted fields keep their existing default" behavior hold for the AI path exactly as it already does for the manual one, rather than the model quietly inventing plausible-looking values for anything it wasn't sure about.
- **The API key is never in the browser, and Claude (the assistant) never sets it.** `ANTHROPIC_API_KEY` is a Netlify environment variable read server-side via `Netlify.env.get(...)` inside the function — the frontend never sees it, and it never appears in this repo. It has to be set by whoever owns the Netlify site, directly in the Netlify dashboard or via `netlify env:set ANTHROPIC_API_KEY <value>` in their own terminal.
- **Abuse guard, not real auth.** An optional `INTAKE_PASSPHRASE` env var, if set, gates the function — a request without a matching `passphrase` field gets a 401 before any Anthropic call is made. This exists only to stop a stranger who finds the live URL from spending the site owner's API credits; it is not a login system, and the passphrase itself is stored in the browser's `localStorage` for convenience (not treated as a secret — it's a shared gate value, not a credential).
- **Known limitation:** standard (synchronous) Netlify Functions have an execution-time ceiling. A very large document plus a slow model response could hit it; if that happens in practice, the fix is trimming `max_tokens` or the input size, or moving to a Netlify Background Function later.

---

## 3. Quick start

1. Open the tool. On a fresh visit it opens on the RFP intake screen (§2, also reachable any time via **Start from RFP**) — add the RFP, an incident-history sheet, or any other supporting document (paste text or upload .docx/.pdf/.xlsx/.txt/.md) and hit Detect, or click **Skip — set up manually** to land directly on the dashboard with a single AMS tower and a worked default so you see live numbers immediately.
2. Set **Engagement**: term, client AI maturity, whether volumetrics exist, estate profile, AIOps in or out, and delivery region (IME, EU, APAC or NA). The first four choices select the scenario (1–4) and with it the contingency, team shape, AIOps timing and savings target; region drives the Delivery location mix card.
3. Pick the **Service mix** — AMS, IMS, DMS or any combination. Click a line to add or drop it. Use **+ Add another tower** only when one line needs more than one tower (separate estates, different SLAs).
4. Set **Service responsibility** per tower — who provides L1, L2 and L3.
5. Score the nine confidence drivers and nine risk categories.
6. Read the results, then copy the **Assumptions & risk register** into the proposal.
7. Hit **Verify against framework** at the bottom — 63 checks reproducing worked examples from the source documents, validating the role policy, and covering the intake extraction logic.

State is saved to the URL, so you can bookmark or share an estimate. **Export JSON** / **Import** move estimates between people.

---

## 4. The calculation, in order

### 3.1 Scenario selection
`AI maturity × volumetric availability → Scenario 1–4` ([F] Part 2/3). Drives Y1 contingency, team shape, AIOps start year, AIOps FTE ratio, YoY savings target, commercial model and volume-band posture.

### 3.2 Demand
Three interchangeable bases per tower:
- **History** — incidents + service requests per month
- **Complexity proxy** — apps by S/M/L/XL/XXL at 3–5 / 8–12 / 15–20 / 25–35 / 40–60 tickets/app/month ([F] Sc.1 Step 1)
- **MAU** — users × incident rate, benchmark 0.5–2% ([F] Sc.1 Step 2)

Existing client automation then deflates volume: 20–30% coverage → −15–20%, 30–50% → −20–30% ([F] Sc.2 Step 2).

### 3.3 Tiering is a cascade, not a partition
This is the part most people get wrong, and the framework's own page-3 illustration settles it:

> 100 tickets arrive at L1. 30 are resolved there (0.25 h each = 7.5 h). 70 pass to L2 — and **all 70** consume 3 h each = 210 h. 20% of those 70 escalate to L3 — 14 tickets × 10 h = 140 h, **on top of** their L2 hours. Raw total 357.5 h ÷ 0.85 utilisation = **421 h**.

So L2 effort covers every pass-through, and L3 escalations are additive. The P1–P4 matrix sets where each priority *enters* the stack; the framework's pass-through rates (70/65/60% L1→L2, 20/20/15% L2→L3) then cascade the L1-entering stream downward and improve by year.

### 3.4 Effort to FTE
```
raw   = Σ_tier (tickets_at_tier × ARE_tier × tower_multiplier) × (1 + SLA modifier on L2/L3)
A     = raw / utilisation                 # default 85%
B     = A × non-ticketing %               # 20–25% modern, 30–35% legacy
G     = governance & reporting hours
base  = (A + B + G) / hours_per_month     # default 160
```

### 3.5 Coverage, hypercare, AIOps
- **Coverage** — `(shifts_per_week × FTE_per_shift) / 5`. Acts as a **floor**, not an addition: when the roster needs more people than the workload does, headcount is set by the support window. The tool flags this when it happens.
- **Hypercare** — Y1 carries up to 3× steady-state volume for the first few months with a step-down glide path ([F] G4).
- **AIOps** — deflection applies to delivery FTE; AIOps engineers are added at 1:4 or 1:8 (flexing to 1:6 above 20 FTE).

### 3.6 Service responsibility

Each tower declares who provides L1, L2 and L3: **DAMO (us)**, **Customer**, **Other vendor** or **Product team**. Presets cover the common shapes:

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

### 3.7 Manual-estimation role policy

Only **nine roles are on by default** — a deliberate, narrow list, not a weighted competition across the full 37. Everything else in the catalogue stays present and switchable in **Roles & grades**, but off, so a fresh estimate never over-staffs a tower with a role that's rarely actually used.

| Tower | L1 | L2 | L3 |
|---|---|---|---|
| AMS | Product Support Engineer | **Systems Support Engineer** | **SSE** below the evolution threshold, **Developer** at or above it |
| IMS | Product Support Engineer | **Infrastructure Support Engineer** | **Infrastructure Engineer**, plus **SRE** only if named the objective |
| DMS | Product Support Engineer | **Data Engineer** (spans L2 and L3) | **Data Engineer** (spans L2 and L3) |

Plus **Machine Learning Engineer** for AIOps, and **Service Delivery Manager** as the *only* governance role, present on **every** engagement — every other governance role (Delivery Principal, Solution Architect, Enterprise Architect, Data Architect, and the rest) is off by default.

Two roles are **genuinely gated in or out**, not just down-weighted — if they're not eligible, they aren't candidates at all, full stop:

- **SRE is IMS-only, and off by default.** It only enters the mix when the "SRE is the client's named objective" checkbox is set on that IMS tower (the checkbox itself only appears on IMS tower cards). Unchecked, Infrastructure Engineer covers 100% of IMS L3. Checked, both are candidates, weighted 1.8x SRE to 0.5x Infrastructure Engineer, and their *combined* headcount stays unchanged — this reallocates within the pool, it doesn't add or remove people. Switching the role on but leaving an AMS or DMS tower's flag unset still produces zero SRE there, asserted by a self-test.
- **Developer is AMS-only, and only appears once evolution work reaches a threshold** (default 30%, editable — "thirty or forty percent" as given). Below it, Systems Support Engineer is deemed capable of the minor enhancements itself and covers AMS L3 as well as L2 — via a `tier2` field, the same mechanism Data Engineer uses for DMS. At or above the threshold, Developer takes over L3 and SSE drops back to L2 only. Exactly one of the two is ever eligible for AMS L3 — never both, never neither, by construction.

Data Engineer draws from **both the L2 and L3 headcount pools** for DMS rather than being confined to one tier — reflecting "we use Data Engineer for L2/L3."

A mixed AMS+IMS deal loads both towers' roles independently and simultaneously — SSE from the AMS slice, Infrastructure Support Engineer from the IMS slice — since each tower resolves its own eligible roles against its own headcount share, not a deal-wide blend. Asserted by a self-test.

SDM ratio is the manual-estimation convention of exactly **1:8**, not the framework's vaguer 1:8–10 range.

### 3.8 Roles and grades

Tier headcount is distributed across whichever roles you have switched on, weighted by role weight and by how much of that tier's effort comes from the towers each role serves. Each role then splits across **Lead : Senior : Consultant**, targeted at a proper pyramid ratio of **1 : 2 : 4** — no Principal grade, which is rarely used here.

The ratio is applied uniformly per tier, so "Lead" represents the tech-lead-level presence within that tier. **Service Delivery Manager is the one deliberate exception** — graded wholly Lead, not split — which falls out of the same uniform table for free, since SDM is the sole role left in governance rather than needing special-case code.

The seniority mix still shifts upward as the team shape moves pyramid → diamond → inverted across the engagement years (Consultant → Senior → Lead), which is what carries the framework's "leaner but senior-heavy team" narrative in the Role & grade staffing plan card.

The full 37-role catalogue remains available — turn any role on in **Roles & grades** for a deal that genuinely needs it (a Data Scientist on an ML-heavy DMS engagement, a QA Analyst where testing needs a named owner). Off-by-default is a starting posture, not a ceiling.

The allocation conserves headcount exactly: every tier FTE lands on one role, every role FTE lands on one grade. That is asserted by a self-test — and because Quality Analyst is off by default, the QA effort share (`bench.qaShare`) also now defaults to 0, so no headcount is ever generated for a role that isn't switched on to receive it.

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

- **APAC** — two peer locations, **China** and **Australia**, with no onshore/nearshore/offshore hierarchy (APAC doesn't have one relative to India the way EU/NA do). Three `proposed` presets: China only, Australia only, even split.
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

**2. At 1:4, AIOps deflection must exceed 20% just to break even on headcount.** An embedded engineer at 1:r adds 1/r to the team, so the team only shrinks once `d > 1/(r+1)` — 20% at 1:4, 11% at 1:8. In Scenario 3 the AIOps engineers arrive in Y1 while deflection starts in Y2, so **Y1 is larger with AIOps than without**. That is a genuine investment year. Say so in the proposal rather than letting the client find it.

**3. Effort-based sizing says you need almost no L1.** At 15 min ARE charged only on tickets *resolved* at L1, L1 is under 1% of resolution effort — so the integer programme allocates ~0% of the team to L1 while the pyramid convention allocates 45%. Both are defensible; L1 headcount is driven by coverage presence and triage throughput, not resolution hours. Size L1 from the roster, and say which basis the proposal uses.

**4. The automation ceiling caps the stretch curve.** On a mixed AMS+IMS+DMS deal the volume-weighted ceiling is ~56%, so the 18%→65% template flattens at Y4 rather than reaching 65%. The tool marks the year it binds.

**6. Handing L1 to the customer saves almost nothing.** On the default deal, full stack sizes at 23.7 FTE and "L1 by customer" sizes at **24.3** — it goes *up*, because L1 is 0.7% of resolution effort while the new ownership interface costs 4%. The real saving from moving L1 out is the rostered coverage, not the effort. If the commercial case for the split is headcount, reduce *FTE per shift* too, or the split buys you nothing.

**7. Split ownership means you do not control your own inflow.** If another party runs L1, *their* resolution rate sets your L2 volume. The estimate assumes benchmark 70% pass-through; if the incumbent under-performs it, your volume rises with no contractual trigger. A volume-band clause does not protect you — you need a **pass-through band** as well.

**5. The source is inconsistent on productive hours.** The page-3 illustration divides by **160**; Scenario 3 Step 1 says **150**. Exposed as an input, defaulting to 160, with the discrepancy labelled.

---

## 7. Verification

The **Verify against framework** card runs 63 checks on every render. Each is a worked example from the source, or a synthetic case for logic that has no source-document analogue (the print report, the RFP intake extractors), so a green run means the engine reproduces the document it claims to implement and the newer mechanics behave as designed:

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
17. SRE is included in IMS L3 only when the box is checked — zero unchecked, present checked, pair total unchanged
18. SRE produces zero allocation on an AMS tower even when switched on and flagged
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

---

## 8. Calibration backlog

These are **proposed defaults derived from the framework's ranges**, not from your engagements. Every one is editable in the Benchmarks panel and listed in the exported register.

- P1–P4 tier-of-entry matrix
- Per-tower ARE multipliers, B-factors and automation ceilings for AMS / IMS / DMS
- Team-shape splits (pyramid 45/35/20, diamond 25/50/25, inverted 15/45/40)
- Role policy: which nine roles are on by default, the AMS evolution threshold (default 30%) that switches SSE to Developer at L3, the IMS L3 SRE-vs-Infrastructure-Engineer weighting once SRE is included (1.8x/0.5x), and the 1:2:4 grade ratio itself
- Role weights and role→tier assignment for anything you switch on beyond the default nine
- Delivery location presets for APAC and NA (proposed guesses — China/Australia and LATAM-Ecuador/India splits with no framework or client data behind them yet, unlike EU's presets); the split is applied uniformly to every role, not per role — if specific roles need to be pinned to specific locations, that's a follow-up, not something the current mix does
- Governance load, hypercare duration and multiplier
- AIOps use-case catalogue: build effort, deflection benefit and prerequisites

The highest-value calibration is the **AIOps use-case effort and deflection numbers**, because they drive O1's funding decisions and the whole savings narrative.

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
