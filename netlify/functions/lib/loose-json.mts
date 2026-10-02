// Tolerant JSON parsing for model replies. A reply that is almost JSON (raw line breaks or tabs
// inside a quoted passage, an unescaped inner quotation mark, a trailing comma, prose or a code
// fence around the object) should not throw the whole extraction away. This is byte-for-byte the
// same algorithm as tidyJson() in damo-estimator.html - the page applies it to pasted replies, and
// test/extraction/loose-json.test.mjs runs both copies against the same samples.

export function tidyJson(raw: string): string {
  let s = String(raw);
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') {
        // a real closing quote is followed (after spaces) by , : } ] or the end; anything else is an inner quote
        let j = i + 1;
        while (j < s.length && (s[j] === " " || s[j] === "\n" || s[j] === "\r" || s[j] === "\t")) j++;
        const nx = s[j];
        if (j >= s.length || nx === "," || nx === ":" || nx === "}" || nx === "]") { inStr = false; out += ch; }
        else out += '\\"';
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) { out += " "; continue; }   // raw newline / tab / control char inside a string
      out += ch;
    } else {
      if (ch === '"') { inStr = true; out += ch; continue; }
      if (ch === ",") {
        let j = i + 1;
        while (j < s.length && (s[j] === " " || s[j] === "\n" || s[j] === "\r" || s[j] === "\t")) j++;
        if (s[j] === "}" || s[j] === "]") continue;               // trailing comma
      }
      out += ch;
    }
  }
  return out;
}

export function parseLooseJson(raw: string): unknown {
  const t = String(raw).trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : t;
  try { return JSON.parse(body); } catch { /* fall through to the tolerant pass */ }
  return JSON.parse(tidyJson(body));
}
