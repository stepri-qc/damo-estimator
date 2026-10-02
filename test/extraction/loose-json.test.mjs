// Runs the server's loose-json.mts and the page's JS twin (extracted from damo-estimator.html)
// against the same samples. Usage: node loose-json.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLooseJson as serverParse } from "../../netlify/functions/lib/loose-json.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "../../index.html"), "utf8");
const a = html.indexOf("function tidyJson(raw)");
const b = html.indexOf("/* loose-json end */");
if (a < 0 || b < 0) throw new Error("page twin not found in index.html");
const pageParse = new Function(html.slice(a, b) + "; return parseLooseJson;")();

const samples = [
  ["plain", '{"a":1,"b":"x"}', { a: 1, b: "x" }],
  ["fenced with prose after", 'Here you go:\n```json\n{"a":1}\n```\nHope that helps', { a: 1 }],
  ["raw newline inside a string", '{"q":"line one\nline two","n":2}', { q: "line one line two", n: 2 }],
  ["raw tab inside a string", '{"q":"a\tb"}', { q: "a b" }],
  ["unescaped inner quotes", '{"q":"he said "ok" then left","n":3}', { q: 'he said "ok" then left', n: 3 }],
  ["trailing commas", '{"a":[1,2,],"b":{"c":1,},}', { a: [1, 2], b: { c: 1 } }],
  ["inner quote and newline together", '{"e":[{"path":"x","quote":"the "SSE" team\nworks 24x7","basis":"stated"}]}', { e: [{ path: "x", quote: 'the "SSE" team works 24x7', basis: "stated" }] }],
  ["escapes preserved", '{"q":"a \\"b\\" c\\nd"}', { q: 'a "b" c\nd' }],
  ["pipes and backslashes", '{"q":"No. | eService | \\\\share\\\\ops"}', { q: "No. | eService | \\share\\ops" }],
];
let bad = 0;
for (const [name, input, want] of samples) {
  for (const [who, fn] of [["server", serverParse], ["page", pageParse]]) {
    let ok = false, got;
    try { got = fn(input); ok = JSON.stringify(got) === JSON.stringify(want); } catch (e) { got = String(e.message); }
    console.log((ok ? "PASS " : "FAIL ") + who + " - " + name + (ok ? "" : "  got " + JSON.stringify(got)));
    if (!ok) bad++;
  }
}
console.log(bad ? bad + " failed" : "all passed");
process.exit(bad ? 1 : 0);
