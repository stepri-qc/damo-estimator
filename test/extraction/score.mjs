// Scores an AI-extraction result against expected.json for the synthetic fixture.
// Usage:  node score.mjs                      -> POSTs the fixture to the live function, polls, scores
//         node score.mjs --site https://...   -> a different deployment
//         node score.mjs --json result.json   -> score a saved reply (no network)
// Uses only the synthetic fixture; never send a real client document through this script.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const site = arg("--site", "https://damo-estimator.netlify.app");
const jsonFile = arg("--json", null);
const passphrase = arg("--pass", "");
const periodMonths = +arg("--period", 0) || undefined;
const fixture = fs.readFileSync(path.join(here, arg("--file", "synthetic-agency-notes.txt")), "utf8");
const exp = JSON.parse(fs.readFileSync(path.join(here, "expected.json"), "utf8"));

const norm = (t) => String(t || "").toLowerCase().replace(/[|•●○■]/g, " ").replace(/[^a-z0-9%.\/ ]+/g, " ").replace(/\s+/g, " ").trim();

async function run() {
  if (jsonFile) return JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  const jobId = Date.now() + "-" + Math.random().toString(36).slice(2);
  await fetch(site + "/.netlify/functions/extract-inputs-background", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, text: fixture, passphrase, periodMonths }),
  });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const d = await (await fetch(site + "/.netlify/functions/extract-status?jobId=" + encodeURIComponent(jobId))).json();
    if (d.status === "pending") continue;
    if (d.status === "error") throw new Error(d.error);
    console.log("tokens:", JSON.stringify(d.usage));
    return d.json;
  }
  throw new Error("timed out");
}

const res = [];
const check = (name, ok, got) => res.push({ name, ok: !!ok, got });
const near = (a, b, t) => typeof a === "number" && Math.abs(a - b) <= t;

const j = await run();
const t0 = (j.towers || [])[0] || {};
check("one tower, AMS, history", (j.towers || []).length === exp.towers.count && t0.type === exp.towers.type && t0.mode === exp.towers.mode, `${(j.towers || []).length} ${t0.type} ${t0.mode}`);
check("no IMS/DMS tower", !(j.towers || []).some((t) => exp.noTowerTypes.includes(t.type)), (j.towers || []).map((t) => t.type).join(","));
check("incidents/month", near(t0.inc, exp.inc.value, exp.inc.tol), t0.inc);
check("SRs/month", near(t0.sr, exp.sr.value, exp.sr.tol), t0.sr);
check("CRs/month", near(t0.cr, exp.cr.value, exp.cr.tol), t0.cr);
const m = t0.mix || {}; const mt = ["P1", "P2", "P3", "P4"].reduce((a, k) => a + (+m[k] || 0), 0) || 1;
for (const [k, [v, tol]] of Object.entries(exp.mix)) check("mix " + k + " %", near((+m[k] || 0) / mt * 100, v, tol), ((+m[k] || 0) / mt * 100).toFixed(2));
check("ownership L1 customer / L2,L3 us", t0.own && t0.own.L1 === exp.own.L1 && t0.own.L2 === exp.own.L2 && t0.own.L3 === exp.own.L3, JSON.stringify(t0.own));
check("coverage 8x5", t0.coverage === exp.coverage, t0.coverage);
const sm = t0.srMix || {}; const st = (+sm.low || 0) + (+sm.medium || 0) + (+sm.high || 0) || 1;
check("SR mix: high share 8-25%", st > 1 && (+sm.high || 0) / st * 100 >= exp.srMixHighRange[0] && (+sm.high || 0) / st * 100 <= exp.srMixHighRange[1], JSON.stringify(sm));
const e = j.eng || {};
// the fixture states only where the cloud is hosted, not where the delivery team sits
const regEv = (j.evidence || []).find((x) => x.path === "eng.region");
check("region not presented as stated from hosting-only evidence", e.region === undefined || (regEv && regEv.basis !== "stated" && (e.locMix === undefined || (e.locMix.apac && +e.locMix.apac.singapore === 100))), JSON.stringify([e.region, e.locMix, regEv && regEv.basis]));
check("pass12 not set (L1 is not ours; the L1.5 rate is context)", e.pass12 === undefined, e.pass12);
check("L2->L3 pass-through ~5%", e.pass23 != null && near(+e.pass23, exp.pass23.value, exp.pass23.tol), e.pass23);
check("incumbent team 30-36 (not the analysis figure)", typeof e.incumbentFTE === "number" && e.incumbentFTE >= exp.incumbentFTE.min && e.incumbentFTE <= exp.incumbentFTE.max, e.incumbentFTE);
check("brownfield", e.engagementType === exp.engagementType, e.engagementType);
check("complexity medium/high", exp.complexityAny.includes(e.complexity), e.complexity);
check("AI maturity low", exp.aiMaturityAny.includes(e.aiMaturity), e.aiMaturity);
check("opportunities >= 2", Array.isArray(j.opportunities) && j.opportunities.length >= exp.opportunitiesMin, (j.opportunities || []).map((o) => o.name).join(" | "));
const wtxt = (j.warnings || []).join(" || ").toLowerCase();
for (const alts of exp.warningMentions) check("warning mentions " + alts.join(" / "), alts.every((a) => wtxt.includes(a.toLowerCase())) || alts.some((a) => wtxt.includes(a.toLowerCase())), "");
const src = norm(fixture); const ev = j.evidence || [];
const found = ev.filter((x) => src.includes(norm(x.quote))).length;
check("evidence present, quotes verbatim (>= 80% found)", ev.length >= 8 && found / ev.length >= 0.8, `${found}/${ev.length}`);
check("evidence basis present on every entry", ev.length > 0 && ev.every((x) => ["stated", "inferred", "assumed"].includes(x.basis)), "");

let fails = 0;
for (const r of res) { console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.got !== "" ? "  [" + r.got + "]" : "")); if (!r.ok) fails++; }
console.log(`\n${res.length - fails}/${res.length} passed`);
fs.writeFileSync(path.join(here, "last-result.json"), JSON.stringify(j, null, 2));
process.exit(fails ? 1 : 0);
