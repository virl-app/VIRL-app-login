// scripts/check-build.mjs
//
// [PR C] Guards the build step and the Vercel config it depends on.
//
//   1. buildPage(index.html) yields one deferred, content-hashed app script,
//      no Babel in the page, and code that parses — compiled with the exact
//      options Babel Standalone used in the browser.
//   2. The CDN scripts the app relies on (React, ReactDOM, Supabase) are
//      still in the page, in the same order, before the app script.
//   3. vercel.json builds into dist/, caches the hashed script for a year
//      and index.html not at all, and keeps the functions/crons config.
//   4. dist/ is an allowlist that covers every root file served over HTTP
//      and nothing else (the briefs and docs were public before PR C).
//   5. middleware.js (the geo-gate) is untouched by the build.

import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import { buildPage, BABEL_OPTIONS, STATIC_FILES } from "./build.mjs";

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.error("FAIL " + msg); } }
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

const html = read("index.html");
const { page, appFile, code } = buildPage(html);

// 1. the page and the script
assert(/^app\.[0-9a-f]{12}\.js$/.test(appFile), "app file is content-hashed: " + appFile);
assert((page.match(/<script defer src="\/app\.[0-9a-f]{12}\.js"><\/script>/g) || []).length === 1, "exactly one deferred app script tag");
assert(!/text\/babel|babel-standalone|babel\.min\.js/.test(page), "the built page loads no Babel");
assert(page.indexOf('<div id="root"></div>') < page.indexOf(`src="/${appFile}"`), "the app script comes after #root");
assert(code.startsWith('"use strict";'), "compiled code runs in strict mode, as Babel's env preset made it in the browser");
assert(!/^\s*(?:const|let)\s+[\w{[]/m.test(code) && !/\)\s*=>\s*[{(]/.test(code), "compiled code is ES5 (env preset: no const/let declarations, no arrow functions), like the browser-compiled code");
try { new vm.Script(code); } catch (e) { assert(false, "compiled code does not parse: " + e.message); }
assert(JSON.stringify(BABEL_OPTIONS.presets) === '["react","env"]', "presets match Babel Standalone's script-tag default");
assert(JSON.stringify(BABEL_OPTIONS.plugins) === '["transform-class-properties","transform-object-rest-spread","transform-flow-strip-types"]', "plugins match Babel Standalone's script-tag default");
const pkg = JSON.parse(read("package.json"));
const cdn = (html.match(/babel-standalone\/([\d.]+)\//) || [])[1];
assert(pkg.devDependencies["@babel/standalone"] === cdn, `@babel/standalone is pinned to the CDN version the page used (${cdn}), got ${pkg.devDependencies["@babel/standalone"]}`);
assert(pkg.scripts.build === "node scripts/build.mjs", "npm run build runs scripts/build.mjs");

// 2. CDN scripts kept, in order, ahead of the app
const order = ["@supabase/supabase-js@2", "react/18.2.0/umd/react.production.min.js", "react-dom/18.2.0/umd/react-dom.production.min.js", `/${appFile}`];
const at = order.map(s => page.indexOf(s));
assert(at.every(i => i >= 0) && at.every((v, i) => i === 0 || v > at[i - 1]), "Supabase, React, ReactDOM, then the app: " + at.join(","));
const strip = (s) => s.replace(/<script type="text\/babel">[\s\S]*?<\/script>/, "").replace(/<script defer src="\/app\.[0-9a-f]+\.js"><\/script>/, "").replace(/[ \t]*<script src="[^"]*babel-standalone[^"]*"><\/script>\r?\n?/, "");
assert(strip(html) === strip(page), "nothing else in the page changes");

// 3. vercel.json
const vj = JSON.parse(read("vercel.json"));
assert(vj.buildCommand === "npm run build" && vj.outputDirectory === "dist", "Vercel builds with npm run build into dist/");
const hdr = (src) => ((vj.headers || []).find(h => h.source === src) || { headers: [] }).headers.find(h => h.key === "Cache-Control");
assert(hdr("/app.:hash.js") && /max-age=31536000/.test(hdr("/app.:hash.js").value) && /immutable/.test(hdr("/app.:hash.js").value), "the hashed script is cached for a year, immutable");
for (const s of ["/", "/index.html"]) assert(hdr(s) && /max-age=0/.test(hdr(s).value), `${s} is not cached long`);
assert(vj.functions && vj.functions["api/render.js"] && /satori/.test(vj.functions["api/render.js"].includeFiles), "api/render.js keeps its includeFiles");
assert(Array.isArray(vj.crons) && vj.crons.length === 8 && vj.crons.some(c => c.path === "/api/cron/strategist-touches"), "all 8 crons are still configured");

// 4. dist/ allowlist
for (const f of STATIC_FILES) assert(existsSync(new URL("../" + f, import.meta.url)), "static file exists: " + f);
for (const f of ["robots.txt", "og-image.png", "virl-wordmark.png", "virl-wordmark-navy.png"]) assert(STATIC_FILES.includes(f), "dist/ serves " + f);
const templates = read("api/_lib/email-templates.js");
for (const m of templates.matchAll(/\$\{APP_URL\}\/([\w.-]+\.(?:png|jpg|svg))/g)) assert(STATIC_FILES.includes(m[1]), "an email links " + m[1] + " but dist/ does not serve it");
for (const m of html.matchAll(/https:\/\/app\.govirl\.ai\/([\w.-]+\.(?:png|jpg|svg|ico|txt))/g)) assert(STATIC_FILES.includes(m[1]), "index.html links " + m[1] + " but dist/ does not serve it");
for (const f of ["virl-impact-review", "virl-launch-brief.pdf", "package.json", "README.md"]) assert(!STATIC_FILES.includes(f), f + " must not be served");
assert(/^dist\/$/m.test(read(".gitignore")), "dist/ is git-ignored");

// 5. middleware untouched
assert(/matcher: '\/\(\(\?!api\/international-waitlist\|favicon\|robots\|og-image\)\.\*\)'/.test(read("middleware.js")), "the geo-gate matcher is unchanged");

if (failures) { console.error(`\n${failures} build check(s) failed.`); process.exit(1); }
console.log(`OK: the build ships ${appFile} compiled as the browser compiled it, with no Babel in the page, and Vercel serves only dist/.`);
