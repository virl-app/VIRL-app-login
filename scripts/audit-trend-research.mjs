// scripts/audit-trend-research.mjs
//
// [TREND-AUDIT] Scores the quality of the Perplexity-authored rows in
// `public.trends` — the weekly research pipeline that `cron/trends-refresh`
// writes and that `trend-context.js` now falls back to when the observed
// pipeline is dry.
//
// Why this exists. Every other research path in this codebase is checked
// before it reaches a creator: `research-verify.js` fact-checks the handle
// brief against creator-stated ground truth and records whether the check
// actually ran. The trend research is the one that isn't. It auto-publishes
// (`cron/trends-refresh.js` inserts whatever came back), on the reasoning —
// stated in that file's header — that rows are "transparently dated and
// sourced" so the creator can "form their own judgment." That reasoning held
// while trends were a browsable Algo tab. It stopped holding when the same
// rows started feeding generation prompts, because inside a prompt nobody
// forms a judgment. This script is the missing check, run after the fact.
//
// It answers five questions, all deterministically, with no model in the loop:
//
//   1. REPEAT RATE — do this week's items restate last week's? The
//      [TRENDS-SOURCES] comment in trends-research.js documents that "every
//      week's trends look the same" was a real observed symptom, diagnosed as
//      recap publications aggregating each other. The fix applied was to ask
//      the model in prose not to do that. This measures whether the prose
//      worked.
//   2. AGGREGATOR SHARE — what fraction of cited sources are the exact recap
//      publications constraint #1b names and forbids? Direct test of the same
//      prompt-level fix.
//   3. LINK INTEGRITY — does `items[].source_url` resolve? Nothing validates
//      it today; it is model-asserted, taken on faith at trends-research.js,
//      and rendered as "Source:" next to a specific claim.
//   4. SPECIFICITY — how many items name a concrete artifact (a hashtag, a
//      quoted sound, a number) versus restating evergreen advice, which
//      constraint #4 bans outright?
//   5. COVERAGE — rows per platform per week, and which platforms are lagging.
//      cron/trends-refresh counts an `errored` platform and returns it in a
//      JSON body nobody reads, so a platform can quietly stop refreshing.
//
// Every metric is a count you can re-derive by hand from the printed detail.
// Nothing here infers intent — an item is flagged, never judged.
//
// Usage:
//   node scripts/audit-trend-research.mjs
//   node scripts/audit-trend-research.mjs --weeks=8 --platform=TikTok
//   node scripts/audit-trend-research.mjs --check-links     # network, slow
//   node scripts/audit-trend-research.mjs --json > audit.json
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (same names api/_lib uses).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── CLI ────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const FLAG = (name) => process.argv.includes(`--${name}`);

const WEEKS = Math.max(1, Number(arg("weeks", "6")) || 6);
const PLATFORM_FILTER = arg("platform", "");
const CHECK_LINKS = FLAG("check-links");
const AS_JSON = FLAG("json");

// ── Reference data ─────────────────────────────────────────────────────────

// The recap publications constraint #1b in trends-research.js names and tells
// the model to avoid as primary evidence. Listed here so the audit tests the
// same rule the prompt states, rather than a different one of my choosing.
const AGGREGATOR_DOMAINS = new Set([
  "sproutsocial.com", "hootsuite.com", "buffer.com", "socialmediaexaminer.com",
  "later.com", "planoly.com", "metricool.com", "socialpilot.co",
  "influencermarketinghub.com", "semrush.com", "hubspot.com", "neilpatel.com",
  "backlinko.com", "shopify.com", "canva.com", "adobe.com", "wix.com",
  "sprinklr.com", "brandwatch.com", "agorapulse.com", "loomly.com",
]);

// Primary venues the prompt's SOURCE_HINTS point AT. Counted separately so a
// low aggregator share isn't mistaken for a high primary share — "neither"
// is a real and common third bucket (SEO listicles, content farms).
const PRIMARY_DOMAINS = new Set([
  "reddit.com", "newsroom.tiktok.com", "creators.tiktok.com",
  "creators.instagram.com", "about.instagram.com", "business.linkedin.com",
  "blog.youtube", "creatoracademy.youtube.com", "about.fb.com",
  "business.x.com", "blog.x.com", "business.pinterest.com",
  "tiktok.com", "instagram.com", "youtube.com", "youtu.be", "linkedin.com",
  "x.com", "twitter.com", "pinterest.com", "facebook.com",
]);

// Platform URLs are hostile to automated requests — TikTok and Instagram
// routinely serve 403 or a login wall to anything without a browser session.
// A 403 from tiktok.com is therefore NOT evidence of a bad citation, and
// scoring it as one would manufacture a failure rate out of bot defenses.
// These hosts get their own "unverifiable" bucket and are excluded from the
// resolve rate entirely.
const UNVERIFIABLE_HOSTS = new Set([
  "tiktok.com", "instagram.com", "facebook.com", "fb.com",
  "x.com", "twitter.com", "linkedin.com", "threads.net", "threads.com",
]);

// Evergreen advice constraint #4 bans by name, plus the nearest neighbours.
// Deliberately a small, literal list: it catches the unambiguous cases and
// defers everything else to the specificity-marker test below, which is the
// more reliable signal.
const EVERGREEN_PATTERNS = [
  /\bpost(ing)? consistent(ly|cy)\b/i,
  /\bengage with (your|the) (audience|followers|community)\b/i,
  /\buse trending (audio|sounds?|music)\b/i,
  /\bbe authentic\b/i, /\bauthenticity (is|remains|continues)\b/i,
  /\bshow(ing)? behind[- ]the[- ]scenes\b/i,
  /\btell(ing)? (a )?stor(y|ies)\b/i,
  /\bshort[- ]form video (is|continues|remains|dominates)\b/i,
  /\bknow your audience\b/i,
  /\bhook (viewers|them) in the first \d+ seconds?\b/i,
  /\bvalue[- ]driven content\b/i,
  /\buser[- ]generated content (is|remains)\b/i,
];

// Words carrying no discriminating power when comparing two trend blurbs.
const STOPWORDS = new Set(`a an and are as at be been being but by for from has
have how in into is it its of on or that the their there these this to was were
what when where which who will with your you creators creator content video
videos post posts posting trend trends trending tiktok instagram youtube
linkedin facebook pinterest platform social media week this new more most using
use used`.split(/\s+/));

// ── Supabase ───────────────────────────────────────────────────────────────

async function sbGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${pathAndQuery} → ${res.status} ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

// ── Text helpers ───────────────────────────────────────────────────────────

function host(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, "");
    return h;
  } catch (e) {
    return "";
  }
}

// Match a host against a set, allowing the apex to stand in for a subdomain
// ("newsroom.tiktok.com" is primary; "cdn.sproutsocial.com" is aggregator).
function inSet(h, set) {
  if (!h) return false;
  if (set.has(h)) return true;
  const apex = h.split(".").slice(-2).join(".");
  return set.has(apex);
}

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9#@']+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// The concrete artifacts constraint #4 demands and evergreen advice never has.
// An item with zero of these is making a claim nothing can be checked against.
function specificityMarkers(text) {
  const s = String(text || "");
  const marks = [];
  if (/#[a-z0-9_]{3,}/i.test(s)) marks.push("hashtag");
  if (/["“][^"”]{4,}["”]/.test(s)) marks.push("quoted-phrase");
  if (/\b\d[\d,.]*\s*(k|m|b|%|x|million|billion|thousand)\b/i.test(s)) marks.push("metric");
  if (/@[a-z0-9_.]{3,}/i.test(s)) marks.push("handle");
  // A capitalised multi-word proper noun that isn't sentence-initial — a named
  // sound, tool, person, or format.
  if (/(?:^|[^.!?]\s)(?:[A-Z][a-z0-9]+\s){1,3}[A-Z][a-z0-9]+/.test(s)) marks.push("proper-noun");
  return marks;
}

function isEvergreen(text) {
  return EVERGREEN_PATTERNS.some((re) => re.test(String(text || "")));
}

function isoWeek(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "unknown";
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ── Link checking ──────────────────────────────────────────────────────────

// HEAD first (cheap), GET on 405/501 since plenty of hosts reject HEAD. A
// network error and a 404 are recorded distinctly: one says the citation is
// wrong, the other says we couldn't tell.
async function probe(url) {
  const h = host(url);
  if (!h) return { url, bucket: "malformed", status: null };
  if (inSet(h, UNVERIFIABLE_HOSTS)) return { url, bucket: "unverifiable", status: null, host: h };

  for (const method of ["HEAD", "GET"]) {
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
        headers: { "user-agent": "Mozilla/5.0 (compatible; VIRL-trend-audit/1.0)" },
      });
      if ((res.status === 405 || res.status === 501) && method === "HEAD") continue;
      const bucket = res.ok ? "ok" : (res.status === 404 || res.status === 410) ? "dead" : "blocked";
      return { url, bucket, status: res.status, host: h };
    } catch (e) {
      if (method === "GET") {
        return { url, bucket: "unreachable", status: null, host: h, error: String(e && e.message).slice(0, 80) };
      }
    }
  }
  return { url, bucket: "unreachable", status: null, host: h };
}

async function probeAll(urls, concurrency = 4) {
  const out = [];
  const queue = [...urls];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const u = queue.shift();
      out.push(await probe(u));
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Report helpers ─────────────────────────────────────────────────────────

const pct = (n, d) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
const bar = (n, d, width = 24) => {
  if (d === 0) return "".padEnd(width, "·");
  const filled = Math.round((n / d) * width);
  return "█".repeat(filled).padEnd(width, "·");
};

function heading(s) {
  console.log(`\n${s}\n${"─".repeat(s.length)}`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.");
    process.exit(2);
  }

  const since = new Date(Date.now() - WEEKS * 7 * 86400000).toISOString();
  let query =
    "trends?select=id,platform,summary,items,sources,fetched_at" +
    `&fetched_at=gte.${encodeURIComponent(since)}` +
    "&order=fetched_at.desc&limit=1000";
  if (PLATFORM_FILTER) query += `&platform=eq.${encodeURIComponent(PLATFORM_FILTER)}`;

  const rows = await sbGet(query);
  if (!Array.isArray(rows) || rows.length === 0) {
    console.error(`No rows in \`trends\` within the last ${WEEKS} weeks.`);
    process.exit(1);
  }

  // Flatten to items, keeping the row context each came from.
  const items = [];
  for (const r of rows) {
    const list = Array.isArray(r.items) ? r.items : [];
    for (const it of list) {
      const text = [it && it.trend, it && it.reason].filter(Boolean).join(" ").trim();
      if (!text) continue;
      items.push({
        platform: r.platform,
        week: isoWeek(r.fetched_at),
        fetchedAt: r.fetched_at,
        trend: String((it && it.trend) || "").trim(),
        reason: String((it && it.reason) || "").trim(),
        category: String((it && it.category) || "").trim(),
        sourceUrl: (it && it.source_url) || "",
        text,
        tokens: tokens(text),
      });
    }
  }

  // Seed the map from ROWS, not from items. A platform whose every row came
  // back with an empty items array has zero items and would otherwise never
  // enter this map — vanishing from the coverage table that exists to catch
  // precisely that. A platform researching nothing week after week is the
  // loudest possible finding, so it must appear with `0 items`, never be
  // absent. (Caught by the smoke fixture: a LinkedIn row with items: [].)
  const byPlatform = new Map();
  for (const r of rows) if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, []);
  for (const it of items) byPlatform.get(it.platform).push(it);

  const report = {
    windowWeeks: WEEKS,
    rows: rows.length,
    items: items.length,
    generatedAt: new Date().toISOString(),
    platforms: {},
  };

  // ── 1. Coverage ──────────────────────────────────────────────────────────
  const weeks = [...new Set(rows.map((r) => isoWeek(r.fetched_at)))].sort();
  const coverage = {};
  for (const r of rows) {
    const k = r.platform;
    if (!coverage[k]) coverage[k] = { rows: 0, emptyRows: 0, items: 0, weeks: new Set(), newest: "" };
    coverage[k].rows++;
    const n = Array.isArray(r.items) ? r.items.length : 0;
    coverage[k].items += n;
    if (n === 0) coverage[k].emptyRows++;
    coverage[k].weeks.add(isoWeek(r.fetched_at));
    if (r.fetched_at > coverage[k].newest) coverage[k].newest = r.fetched_at;
  }

  // ── 2. Repeat rate (week over week, within platform) ─────────────────────
  // An item counts as a repeat when it overlaps ANY item from the immediately
  // preceding week on the same platform above the threshold. Compared against
  // the previous week only — not the whole window — because a trend genuinely
  // resurging two months later is a different claim from one that never left.
  const REPEAT_THRESHOLD = 0.45;
  for (const [platform, list] of byPlatform) {
    const weekBuckets = new Map();
    for (const it of list) {
      if (!weekBuckets.has(it.week)) weekBuckets.set(it.week, []);
      weekBuckets.get(it.week).push(it);
    }
    const orderedWeeks = [...weekBuckets.keys()].sort();

    let compared = 0;
    let repeats = 0;
    const examples = [];
    for (let i = 1; i < orderedWeeks.length; i++) {
      const cur = weekBuckets.get(orderedWeeks[i]);
      const prev = weekBuckets.get(orderedWeeks[i - 1]);
      for (const c of cur) {
        compared++;
        let best = null;
        let bestScore = 0;
        for (const p of prev) {
          const score = jaccard(c.tokens, p.tokens);
          if (score > bestScore) { bestScore = score; best = p; }
        }
        if (bestScore >= REPEAT_THRESHOLD) {
          repeats++;
          if (examples.length < 5) {
            examples.push({ week: c.week, score: Number(bestScore.toFixed(2)), now: c.trend, prior: best.trend });
          }
        }
      }
    }

    // ── 3. Specificity ─────────────────────────────────────────────────────
    let generic = 0;
    let evergreen = 0;
    const genericExamples = [];
    for (const it of list) {
      const marks = specificityMarkers(it.trend);
      const ever = isEvergreen(it.text);
      if (ever) evergreen++;
      if (marks.length === 0) {
        generic++;
        if (genericExamples.length < 5) genericExamples.push(it.trend);
      }
    }

    // ── 4. Source provenance ───────────────────────────────────────────────
    const itemHosts = list.map((it) => host(it.sourceUrl)).filter(Boolean);
    const missingUrl = list.filter((it) => !it.sourceUrl).length;
    const aggregator = itemHosts.filter((h) => inSet(h, AGGREGATOR_DOMAINS)).length;
    const primary = itemHosts.filter((h) => inSet(h, PRIMARY_DOMAINS)).length;
    const other = itemHosts.length - aggregator - primary;

    const hostCounts = {};
    for (const h of itemHosts) hostCounts[h] = (hostCounts[h] || 0) + 1;
    const topHosts = Object.entries(hostCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

    report.platforms[platform] = {
      items: list.length,
      coverage: {
        rows: coverage[platform].rows,
        emptyRows: coverage[platform].emptyRows,
        weeksPresent: coverage[platform].weeks.size,
        weeksInWindow: weeks.length,
        newest: coverage[platform].newest,
      },
      repeat: { compared, repeats, rate: compared ? repeats / compared : null, examples },
      specificity: {
        total: list.length,
        genericNoMarkers: generic,
        evergreenPhrases: evergreen,
        examples: genericExamples,
      },
      sources: {
        withUrl: itemHosts.length,
        missingUrl,
        aggregator,
        primary,
        other,
        topHosts,
      },
    };
  }

  // ── 5. Link integrity (opt-in) ───────────────────────────────────────────
  if (CHECK_LINKS) {
    const urls = [...new Set(items.map((i) => i.sourceUrl).filter(Boolean))];
    if (!AS_JSON) console.error(`Probing ${urls.length} unique source URLs...`);
    const probes = await probeAll(urls);
    const byBucket = {};
    for (const p of probes) byBucket[p.bucket] = (byBucket[p.bucket] || 0) + 1;
    const verifiable = probes.filter((p) => p.bucket !== "unverifiable");
    report.links = {
      unique: urls.length,
      buckets: byBucket,
      verifiable: verifiable.length,
      resolved: verifiable.filter((p) => p.bucket === "ok").length,
      resolveRate: verifiable.length ? verifiable.filter((p) => p.bucket === "ok").length / verifiable.length : null,
      failures: probes
        .filter((p) => p.bucket === "dead" || p.bucket === "unreachable" || p.bucket === "malformed")
        .slice(0, 20),
    };
  }

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // ── Print ────────────────────────────────────────────────────────────────

  console.log(`\nVIRL trend-research audit — last ${WEEKS} weeks`);
  console.log(`${rows.length} rows, ${items.length} items, weeks ${weeks[0] || "?"} → ${weeks[weeks.length - 1] || "?"}`);

  heading("COVERAGE — is every platform still refreshing?");
  console.log("platform      rows  empty  weeks  items  newest");
  for (const p of Object.keys(report.platforms).sort()) {
    const c = report.platforms[p].coverage;
    // "Researched every week and found nothing every week" is a distinct and
    // worse state than "missed a week" — call it out separately.
    const flag = report.platforms[p].items === 0
      ? "  ← NO ITEMS AT ALL"
      : c.weeksPresent < weeks.length ? "  ← GAP" : "";
    console.log(
      `${p.padEnd(12)} ${String(c.rows).padStart(4)} ${String(c.emptyRows).padStart(6)} ` +
      `${String(c.weeksPresent).padStart(3)}/${weeks.length}  ${String(report.platforms[p].items).padStart(5)}  ` +
      `${String(c.newest).slice(0, 10)}${flag}`
    );
  }

  heading("REPEAT RATE — does this week restate last week?");
  console.log("Higher is worse. Above ~35% means the recap loop is still running.\n");
  for (const p of Object.keys(report.platforms).sort()) {
    const r = report.platforms[p].repeat;
    if (!r.compared) { console.log(`${p.padEnd(12)} (only one week of data)`); continue; }
    console.log(`${p.padEnd(12)} ${bar(r.repeats, r.compared)} ${pct(r.repeats, r.compared).padStart(4)}  (${r.repeats}/${r.compared})`);
  }
  for (const p of Object.keys(report.platforms).sort()) {
    const ex = report.platforms[p].repeat.examples;
    if (!ex.length) continue;
    console.log(`\n  ${p} — closest week-over-week pairs:`);
    for (const e of ex) {
      console.log(`    [${e.score}] ${e.week}  ${e.now.slice(0, 88)}`);
      console.log(`           prior week  ${e.prior.slice(0, 88)}`);
    }
  }

  heading("SPECIFICITY — is the item a named artifact or advice?");
  console.log("`generic` = zero specificity markers (no hashtag, quote, metric, handle,");
  console.log("or proper noun). Constraint #4 of the prompt bans these outright.\n");
  for (const p of Object.keys(report.platforms).sort()) {
    const s = report.platforms[p].specificity;
    console.log(
      `${p.padEnd(12)} ${bar(s.genericNoMarkers, s.total)} ${pct(s.genericNoMarkers, s.total).padStart(4)} generic ` +
      `(${s.genericNoMarkers}/${s.total}), ${s.evergreenPhrases} evergreen phrase${s.evergreenPhrases === 1 ? "" : "s"}`
    );
  }
  for (const p of Object.keys(report.platforms).sort()) {
    const ex = report.platforms[p].specificity.examples;
    if (!ex.length) continue;
    console.log(`\n  ${p} — items with no checkable specific:`);
    for (const e of ex) console.log(`    · ${e.slice(0, 100)}`);
  }

  heading("SOURCE PROVENANCE — where did the evidence come from?");
  console.log("Constraint #1b forbids recap publications as PRIMARY evidence for an item.\n");
  for (const p of Object.keys(report.platforms).sort()) {
    const s = report.platforms[p].sources;
    console.log(
      `${p.padEnd(12)} primary ${String(s.primary).padStart(3)}  aggregator ${String(s.aggregator).padStart(3)}  ` +
      `other ${String(s.other).padStart(3)}  no-url ${String(s.missingUrl).padStart(3)}`
    );
  }
  console.log("\n  Most-cited hosts:");
  const allHosts = {};
  for (const p of Object.keys(report.platforms)) {
    for (const [h, n] of report.platforms[p].sources.topHosts) allHosts[h] = (allHosts[h] || 0) + n;
  }
  for (const [h, n] of Object.entries(allHosts).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    const tag = inSet(h, AGGREGATOR_DOMAINS) ? " [aggregator]" : inSet(h, PRIMARY_DOMAINS) ? " [primary]" : "";
    console.log(`    ${String(n).padStart(3)}  ${h}${tag}`);
  }

  if (report.links) {
    heading("LINK INTEGRITY — does the cited URL resolve?");
    console.log("Platform URLs (tiktok/instagram/etc) are excluded from the rate: they");
    console.log("block automated requests, so a 403 there is bot defense, not a bad cite.\n");
    const l = report.links;
    console.log(`  unique URLs      ${l.unique}`);
    for (const [b, n] of Object.entries(l.buckets).sort((a, b2) => b2[1] - a[1])) {
      console.log(`  ${b.padEnd(16)} ${String(n).padStart(4)}`);
    }
    console.log(`\n  resolve rate (verifiable only): ${pct(l.resolved, l.verifiable)} (${l.resolved}/${l.verifiable})`);
    if (l.failures.length) {
      console.log("\n  Failing citations:");
      for (const f of l.failures) {
        console.log(`    ${String(f.status || f.bucket).padEnd(12)} ${f.url.slice(0, 96)}`);
      }
    }
  } else {
    console.log("\n(Link integrity not checked. Re-run with --check-links to probe source URLs.)");
  }

  heading("HOW TO READ THIS");
  console.log("There is no pass/fail line here on purpose — these are measurements, and");
  console.log("what counts as acceptable is a product call, not a threshold I can pick");
  console.log("for you. The three that would change a decision:");
  console.log("");
  console.log("  · Repeat rate above ~35%      → the research is recycling; the prompt-level");
  console.log("                                  source fix did not hold.");
  console.log("  · Generic share above ~30%    → items are advice, not trends; they will");
  console.log("                                  produce vague plans wherever they are cited.");
  console.log("  · Resolve rate below ~85%     → citations are decorative, and a creator who");
  console.log("                                  clicks one lands nowhere.");
  console.log("");
  console.log("Any of those means the research pipeline cannot carry generation alone,");
  console.log("which makes the observed pipeline load-bearing rather than optional.");
  console.log("");
}

main().catch((e) => {
  console.error("audit failed:", e && e.message);
  process.exit(2);
});
