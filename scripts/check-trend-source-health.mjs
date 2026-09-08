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
const MODULES = ["tiktok-normalize", "hashtags", "ensembledata", "http-source", "youtube", "youtube-terms"];

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
const { youtubeSource, extractHashtags } = await import(pathToFileURL(join(dir, "youtube.mjs")).href);

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

// ── YouTube adapter: the first non-TikTok observed source ─────────────────
//
// Same pairs as above, on the free source. Plus the one thing that is
// different about a search platform: a query that matched no videos this week
// is a real answer, not a failure, and must not trip the backstop.

const TERMS = [{ term: "house tour", segment: "real_estate" }, { term: "life coach", segment: "coach" }];
const ytVideo = (id, views, desc) => ({ id, statistics: { viewCount: String(views) }, snippet: { title: `Video ${id}`, description: desc } });
const ytOk = (body) => ({ ok: true, status: 200, json: async () => body });
const ytFetch = (search, videos) => async (url) => String(url).includes("/search?") ? search(url) : videos(url);

// (a) Healthy: one search_term per query, views summed, hashtags aggregated across queries.
let ytGot = null; let ytThrew = null;
try {
  ytGot = await youtubeSource({ apiKey: "k", terms: TERMS, log: () => {}, fetchImpl: ytFetch(
    () => ytOk({ items: [{ id: { videoId: "v1" } }, { id: { videoId: "v2" } }] }),
    () => ytOk({ items: [ytVideo("v1", 1000, "tips #realestate #housetour"), ytVideo("v2", 500, "more #realestate")] }),
  ) }).fetch();
} catch (e) { ytThrew = e; }
assert(!ytThrew, `a healthy YouTube run threw (${ytThrew && ytThrew.message})`);
const terms = (ytGot || []).filter((t) => t.type === "search_term");
const tags  = (ytGot || []).filter((t) => t.type === "hashtag");
assert(terms.length === 2 && terms.every((t) => t.platform === "youtube" && t.source === "youtube-data-api"),
  "the YouTube adapter did not emit one youtube/search_term row per query with its own source name — a row stamped tiktok or ensembledata would be misattributed for the life of the table");
assert(terms.every((t) => t.views === 1500 && t.postCount === 2),
  "search_term views/postCount are not the sampled videos' sum and count — the lifecycle scorer reads exactly those two numbers");
// Both queries return the same two videos, so #realestate is on TWO videos
// (not four — a video matched by two queries is still one video) and
// #housetour is on one.
assert(tags.some((t) => t.displayName === "#realestate" && t.postCount === 2 && t.views === 1500) && !tags.some((t) => t.displayName === "#housetour"),
  `hashtags are not aggregated across queries, deduped by video, with a minimum of two videos — got ${JSON.stringify(tags.map((t) => [t.displayName, t.postCount]))}; a tag on one video is noise, and a video seen under two queries is one endorsement, not two`);

// (b) A query with no videos this week is an ANSWER: no throw, and no row for it.
ytThrew = null; ytGot = null;
try {
  ytGot = await youtubeSource({ apiKey: "k", terms: TERMS, log: () => {}, fetchImpl: ytFetch(() => ytOk({ items: [] }), () => ytOk({ items: [] })) }).fetch();
} catch (e) { ytThrew = e; }
assert(!ytThrew && Array.isArray(ytGot) && ytGot.length === 0,
  `two queries that matched nothing this week were treated as a failure (${ytThrew && ytThrew.message}) — on a search platform an empty week is a real result, and alarming on it is how alarms stop being read`);

// (c) Quota exhausted: 403 on every call must throw with the body's reason reachable.
ytThrew = null; const ytLines = [];
try {
  await youtubeSource({ apiKey: "k", terms: TERMS, log: (m) => ytLines.push(String(m)),
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => '{"error":{"errors":[{"reason":"quotaExceeded"}]}}' }) }).fetch();
} catch (e) { ytThrew = e; }
assert(ytThrew && /NOT an empty week/i.test(ytThrew.message),
  "a quota-exhausted YouTube run returned normally — index.ts would record it healthy and the platform would go dark with nothing said, the forty-day shape again");
assert(ytLines.some((l) => /quotaExceeded/.test(l)),
  "the YouTube refusal log does not carry the API's own reason — 'HTTP 403' alone sends the reader to guess between a bad key and a spent quota");

// (d) A bad key is 400, which isRefusal does not know — the backstop must still catch it.
ytThrew = null;
try {
  await youtubeSource({ apiKey: "k", terms: TERMS, log: () => {}, fetchImpl: async () => ({ ok: false, status: 400, text: async () => "keyInvalid" }) }).fetch();
} catch (e) { ytThrew = e; }
assert(ytThrew, "every query failing with HTTP 400 (keyInvalid) returned normally — the allCallsFailed backstop is not wired into the YouTube adapter");

// extractHashtags: real hashtags only, deduped, lowercased.
const hx = extractHashtags("Tour! #HouseTour #housetour #x #real_estate #2025tips");
assert(hx.includes("housetour") && hx.filter((h) => h === "housetour").length === 1 && !hx.includes("x") && hx.includes("real_estate"),
  `extractHashtags mis-parsed: ${JSON.stringify(hx)}`);

// index.ts no longer stamps every row as EnsembleData, and the enrichment prompt reads the row's platform.
const indexSrc = readFileSync(new URL("../supabase/functions/ingest-trends/index.ts", import.meta.url), "utf8");
const enrichSrc = readFileSync(new URL("../supabase/functions/ingest-trends/enrich.ts", import.meta.url), "utf8");
assert(!/source:\s*"ensembledata"/.test(indexSrc) && /source:\s*t\.source/.test(indexSrc),
  "index.ts hard-codes source \"ensembledata\" on upsert — every YouTube row would be attributed to the TikTok vendor");
assert(!/trending on TikTok this week/.test(enrichSrc) && /platformLabel\(t\.platform\)/.test(enrichSrc),
  "the enrichment prompt still says 'trending on TikTok' unconditionally — Perplexity would confidently explain why a YouTube search term is trending on TikTok, and that string is what the creator reads");

if (failures > 0) {
  console.error(`\nTrend source health check FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log("OK: refusals are told apart from empty weeks, on known codes and unknown ones alike.");
