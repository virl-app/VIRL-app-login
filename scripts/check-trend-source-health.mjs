// scripts/check-trend-source-health.mjs
//
// Guards the one distinction the trend adapters exist to get right: "the vendor
// refused us" versus "the vendor had nothing". Those are opposite facts that
// produce identical output unless something forces them apart, and every time
// they have blurred it has cost weeks of dark trend data.
//
// The history this protects against, twice over:
//
//   1. A lapsed plan turned all 22 hashtag calls into skips, the adapter
//      returned [], index.ts took its fail-soft empty branch, and the run
//      reported a healthy 200 while writing nothing. Fixed by counting
//      refusals and throwing.
//
//   2. EnsembleData answers an exhausted account with HTTP 493, which is not an
//      IANA status and was not in `isRefusal`'s list. Every call took the
//      generic "skipping" branch, `authRefusals` stayed 0, the throw from (1)
//      never fired, and the exact same silent outage ran from 2026-07-30 to
//      2026-09-08 — forty days. The staleness monitor caught it; the adapter,
//      which knew on the first call, did not say so.
//
// So these tests come in PAIRS, matching the convention the off-limits filter
// tests already follow: one proving the alarm fires, one proving it does not
// fire on a run that got real data. An adapter that throws on a merely
// disappointing week would trade real trends for a louder log line, which is
// the opposite failure and just as expensive.
//
// The adapters are Deno TypeScript. Sucrase strips the types and the import
// specifiers are rewritten to relative .mjs so plain Node can load them — no
// Deno required in CI.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "sucrase";

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error(`FAIL: ${msg}`);
}

const SRC = new URL("../supabase/functions/ingest-trends/adapters/", import.meta.url);
const MODULES = ["tiktok-normalize", "hashtags", "ensembledata", "http-source"];

// Transform each adapter to ESM Node can import, rewriting "./x.ts" → "./x.mjs".
const dir = mkdtempSync(join(tmpdir(), "virl-adapters-"));
for (const name of MODULES) {
  const ts = readFileSync(new URL(`${name}.ts`, SRC), "utf8");
  const { code } = transform(ts, { transforms: ["typescript"] });
  writeFileSync(join(dir, `${name}.mjs`), code.replace(/(from\s+")\.\/([\w-]+)\.ts(")/g, "$1./$2.mjs$3"));
}
// types.ts is type-only; anything importing it transforms to nothing, but the
// specifier must still resolve.
writeFileSync(join(dir, "types.mjs"), "export {};\n");

const { isRefusal, allCallsFailed } = await import(pathToFileURL(join(dir, "tiktok-normalize.mjs")).href);
const { ensembleDataSource } = await import(pathToFileURL(join(dir, "ensembledata.mjs")).href);

// ── isRefusal knows the codes vendors actually send ────────────────────────

for (const status of [401, 402, 403, 429]) {
  assert(isRefusal(status), `HTTP ${status} is not classified as a refusal — a rejected call would read as an empty week`);
}
assert(isRefusal(493),
  "HTTP 493 is not classified as a refusal. That is EnsembleData's out-of-units code and its absence cost forty days of dark trend data — see the comment on isRefusal before changing this");

// The other half of the pair: a status that genuinely says nothing about
// credentials must NOT be dressed up as a billing problem, or every alert
// starts pointing at the invoice.
for (const status of [404, 500, 503]) {
  assert(!isRefusal(status), `HTTP ${status} is classified as a refusal — it says nothing about credentials or quota, and mislabeling it sends the reader to the billing page`);
}

// ── allCallsFailed closes the class isRefusal enumerates ───────────────────

assert(allCallsFailed(22, 22), "22 attempted and 22 failed is not flagged — that is the shape of every silent outage this file exists to catch");
assert(!allCallsFailed(22, 21), "one successful call out of 22 is flagged as total failure — a partial run still carries real trends and must not be discarded");
assert(!allCallsFailed(0, 0), "a run that attempted nothing is flagged as failed — there is no vendor signal in zero calls");

// ── The adapter throws on a refusal storm, and only on one ─────────────────

const HASHTAGS = [{ tag: "a", segment: "creator" }, { tag: "b", segment: "creator" }];

function sourceWith(fetchImpl) {
  return ensembleDataSource({ token: "t", hashtags: HASHTAGS, fetchImpl, log: () => {} });
}

const post = { id: "1", stats: { play_count: 10 }, music: { id: "m1", title: "S" } };
const okResponse = () => ({ ok: true, status: 200, json: async () => ({ data: { aweme_list: [post, { ...post, id: "2" }] } }) });

// (a) Every call refused with the code that actually broke us.
let threw = null;
try {
  await sourceWith(async () => ({ ok: false, status: 493 })).fetch();
} catch (e) { threw = e; }
assert(threw, "an adapter refused HTTP 493 on every call returned normally instead of throwing — index.ts would record the run healthy and write nothing, which is exactly the forty-day outage");
if (threw) {
  assert(/NOT an empty week/i.test(threw.message),
    "the refusal error does not say this is not an empty week — that sentence is what stops the reader diagnosing the wrong problem");
}

// (b) Every call failed with a status nobody has enumerated. This is the case
//     that must survive the next vendor inventing its own code.
threw = null;
try {
  await sourceWith(async () => ({ ok: false, status: 418 })).fetch();
} catch (e) { threw = e; }
assert(threw, "every call failing with an unrecognized status returned normally — enumerating codes is what let 493 through, and the backstop is what makes the next unknown code cost one run instead of forty days");

// (c) The pair: a run that got real data must NOT throw, however unremarkable.
threw = null;
let got = null;
try {
  got = await sourceWith(async () => okResponse()).fetch();
} catch (e) { threw = e; }
assert(!threw, `a healthy run threw (${threw && threw.message}) — alarming on a good week is how alarms stop being read`);
assert(got && got.length > 0, "a healthy run produced no trends — the fixture or the parser regressed");

// (d) The other pair: partial success keeps its data instead of raising.
threw = null;
got = null;
let call = 0;
try {
  got = await sourceWith(async () => (++call === 1 ? { ok: false, status: 493 } : okResponse())).fetch();
} catch (e) { threw = e; }
assert(!threw, `a partially refused run threw (${threw && threw.message}) — discarding real trends to raise a louder alarm is the wrong trade, and the adapter says so in its own comment`);
assert(got && got.length > 0, "a partially refused run dropped the data it did get");

// ── The refusal log names the reason, not just the status ─────────────────
//
// "HTTP 493" is a lookup task; "HTTP 493: insufficient units" is a fix. The
// forty-day outage logged the former 22 times a run and never the latter.

const lines = [];
try {
  await ensembleDataSource({
    token: "t", hashtags: HASHTAGS, log: (m) => lines.push(String(m)),
    fetchImpl: async () => ({ ok: false, status: 493, text: async () => '{"detail":"insufficient units"}' }),
  }).fetch();
} catch { /* the refusal throw is asserted above; here we only read the log */ }
assert(lines.some(l => /insufficient units/.test(l)),
  "the refusal log does not include the vendor's reason — the status alone leaves the reader looking up what a nonstandard code means, which is how 493 went unread for forty days");

// And it must survive a vendor that returns no readable body at all.
const noBody = [];
try {
  await ensembleDataSource({
    token: "t", hashtags: HASHTAGS, log: (m) => noBody.push(String(m)),
    fetchImpl: async () => ({ ok: false, status: 493, text: async () => { throw new Error("stream consumed"); } }),
  }).fetch();
} catch { /* expected */ }
assert(noBody.some(l => /493/.test(l)),
  "an unreadable error body suppressed the refusal log entirely — reading the reason must never become its own failure");

if (failures > 0) {
  console.error(`\nTrend source health check FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log("OK: refusals are told apart from empty weeks, on known codes and unknown ones alike.");
