// scripts/check-index-syntax.mjs
// Quick parse check for index.html — extract every <script type="text/babel">,
// transform with sucrase (JSX → JS), then feed the result through vm.Script
// to confirm V8 can parse it. Catches typos and JSX mistakes that would only
// surface as a blank page in the browser otherwise.

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transform } from "sucrase";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const re = /<script\s+type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/g;
let i = 0;
let m;
let totalScripts = 0;
let totalErrors = 0;

while ((m = re.exec(html)) !== null) {
  i += 1;
  totalScripts += 1;
  const src = m[1];
  try {
    const out = transform(src, { transforms: ["jsx"] });
    new vm.Script(out.code);
  } catch (err) {
    totalErrors += 1;
    const msg = err && err.message ? err.message : String(err);
    console.error(`Script #${i} failed: ${msg}`);
  }
}

if (totalScripts === 0) {
  console.error("No <script type=\"text/babel\"> blocks found — wrong file?");
  process.exit(2);
}
if (totalErrors > 0) {
  console.error(`\n${totalErrors} of ${totalScripts} script(s) failed parsing.`);
  process.exit(1);
}
console.log(`OK: ${totalScripts} script(s) parsed cleanly.`);
