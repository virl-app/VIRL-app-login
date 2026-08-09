// DB-backed trend + playbook context for per-generation prompts.
//
// This replaces the old inline Perplexity "fresh trends" path. Trend signal now
// comes from the trend_items pipeline (ingested Mon/Thu by the ingest-trends
// edge function) and the playbook layer, rather than a live web-search on every
// generation. No per-generation vendor cost, and trends carry lifecycle status
// + niche fit + pre-written adaptation angles.
//
// Fail-open by contract: any missing table, empty result, or Supabase blip
// returns an empty block, and the prompt builders fall back to their explicit
// "no trends this week" state (see planTrendsContext in prompts.js). A trend
// outage must never break a generation.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SUPABASE_HEADERS = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

// Trend query knobs (mirror the brief's WS2.B contract).
const TREND_FRESHNESS_DAYS = 7;   // never surface a trend older than this
const FIT_FLOOR            = 0.6; // minimum niche_scores[segment] to qualify
const MAX_TRENDS           = 5;   // items shown per generation
const SNAPSHOT_VERSION     = 2;   // bump if the snapshot shape changes

// TikTok is the always-on fallback source: a trend peaking on TikTok is valid
// input for an Instagram (Reels) target, per the brief's fallback rule.
const FALLBACK_PLATFORM = "tiktok";

// [TREND-FALLBACK] The weekly editorial research in the legacy `trends` table
// as a second source when the observed pipeline has nothing.
//
// Two pipelines have been running side by side and only one of them fed
// generation. `cron/trends-refresh` researches every platform weekly via
// Perplexity and writes dated, cited rows into `trends`; the observed pipeline
// (this file's primary path) reads `trend_items`, which is written only by the
// ingest-trends edge function — and that function has exactly one adapter,
// EnsembleData, which does nothing without a token. So `trend_items` can be
// empty while `trends` is full, and until now that combination produced the
// "no trends" empty state on every surface while the research bill kept
// arriving. The creator saw those trends on the Algo tab, which reads `trends`
// directly, and got a plan built from none of them.
//
// This is a fallback, not a merge: observed data wins whenever it exists,
// because a measured rising sound beats a publication's claim. The block below
// labels the difference rather than hiding it — these items carry no lifecycle
// signal, so the model is told to cite them as what is being discussed, never
// as what is peaking.
const LEGACY_TREND_FRESHNESS_DAYS = 14;  // the cron is weekly; two cycles of slack
const LEGACY_TREND_CATEGORIES = new Set(["topic", "audio", "format", "hook", "hashtag"]);

// ── Segment resolution ─────────────────────────────────────────────────────
// The app keys generation off a user-facing `niche` label (17 values) which
// nicheCategory() collapses into 7 format-mix buckets — neither matches the 9
// canonical playbook_segments keys. This is the single place that bridges them.
// Default is `creator`, matching playbook_segments' documented default archetype.

const NICHE_TO_SEGMENT = {
  "Real Estate":          "real_estate",
  "Small Business":       "small_business",
  "Education":            "coach",
  "Finance":              "coach",
  "Fitness":              "fitness",
  "Sports":               "fitness",
  "Healthcare & Medical": "healthcare",
  "Wellness":             "coach",
  "Food & Recipes":       "creator",
  "Beauty":               "beauty",
  "Fashion":              "creator",
};

const CANONICAL_SEGMENTS = new Set([
  "real_estate", "coach", "creator", "personal_brand",
  "small_business", "fitness", "healthcare", "beauty", "hair",
]);

// The niche picker can't express hair / personal_brand and blurs beauty, so a
// light profile-text pass rescues those before we fall back to `creator`.
function segmentFromProfileHints(profile) {
  if (!profile) return null;
  const hay = [
    profile.offerings, profile.knownFor, profile.audience, profile.serviceArea,
    profile.topics, profile.idealClientProblem, profile.name,
  ].filter(v => typeof v === "string").join(" ").toLowerCase();
  if (!hay) return null;
  if (/\b(hair ?stylist|hairstylist|hair salon|barber|colou?rist|balayage)\b/.test(hay)) return "hair";
  if (/\b(esthetician|lash|brow|nail|med ?spa|medspa|waxing|facials?|makeup artist|mua)\b/.test(hay)) return "beauty";
  if (/\b(keynote|speaker|thought leader|linkedin|b2b|consultant)\b/.test(hay)) return "personal_brand";
  return null;
}

// `niche` is the user-facing label; `profile` is optional and only consulted to
// recover segments the picker can't express.
export function resolveSegment(niche, profile) {
  if (typeof niche === "string" && CANONICAL_SEGMENTS.has(niche)) return niche; // already canonical
  const mapped = niche && NICHE_TO_SEGMENT[niche];
  if (mapped) return mapped;
  return segmentFromProfileHints(profile) || "creator";
}

// ── [TREND-PERSONALIZATION] Creator fit beyond the niche score ─────────────
//
// Trend selection used exactly one input: `niche_scores[segment] >= 0.6`,
// then rising-first, then best fit, then take 5. Niche is one of the three
// things VIRL claims to personalize on; goals and voice reached the writing
// of a trend but never the CHOOSING of one. Two real-estate creators — one
// working listing appointments, one building a personal brand, one who has
// told VIRL never to touch a subject — received the identical five trends.
//
// The split below is deliberate about what is measurable and what is not:
//
//   OFF-LIMITS is a hard exclusion, applied in code. A creator who wrote
//   "never talk about politics" has stated a boundary, and a boundary
//   enforced by asking a model nicely is not enforced. This also runs over
//   the legacy fallback items, which are not niche-scored at all and so had
//   no filtering of any kind before now.
//
//   TOPIC OVERLAP is a ranking nudge, applied in code. Whether a trend's
//   words overlap the creator's stated pillars is a fact about two strings.
//
//   GOAL is stated to the model, NOT scored in code. Building a
//   goal→trend-type mapping ("hashtag trends suit awareness, formats suit
//   conversion") would mean inventing a rule nothing here can check —
//   precisely the unfalsifiable claim the trend-grounding rules exist to
//   stop. The model gets the goal and picks among trends already filtered
//   for fit and safety.

const OFF_LIMITS_MIN_TERM = 4;   // below this a term matches half the language
const TOPIC_BONUS         = 0.15; // tiebreak only; never outranks a fit gap

// Creators write boundaries in whatever number happens to come out — "no
// politics, elections" against a trend that says "election day". Plain
// substring matching misses that, and a boundary that fails on a plural is
// not a boundary. Crudely folding a trailing "s" off every word on BOTH
// sides makes the comparison agree with itself; it does not need to be
// linguistically right ("business" → "busines" on both sides still matches),
// only applied identically to the term and the text.
function foldPlurals(s) {
  return s.replace(/\b([a-z0-9']{4,})s\b/g, "$1");
}

// Free-text "don't go near this" from the profile, split into matchable
// terms. Short fragments are dropped: a two-letter term would silently
// filter out most of the trend table.
function offLimitsTerms(profile) {
  const raw = profile && typeof profile.offLimits === "string" ? profile.offLimits : "";
  if (!raw.trim()) return [];
  return raw
    .toLowerCase()
    .split(/[,;\n•]+|\band\b/)
    .map(s => s.replace(/^\s*(no|never|avoid|don'?t (?:talk about|mention|post about))\b/, "").trim())
    .map(s => s.replace(/[^a-z0-9 '-]/g, "").trim())
    .filter(s => s.length >= OFF_LIMITS_MIN_TERM)
    .map(foldPlurals);
}

// The creator's own subject matter, as a token set. Sourced from what they
// typed rather than anything inferred, so an empty profile yields an empty
// set and the bonus simply never fires.
function creatorTopicTokens(profile) {
  if (!profile) return new Set();
  const hay = [profile.pillars, profile.topics, profile.knownFor, profile.offerings, profile.loveToReference]
    .map(v => Array.isArray(v) ? v.join(" ") : v)
    .filter(v => typeof v === "string")
    .join(" ")
    .toLowerCase();
  const stop = new Set(["and","the","for","with","that","this","your","from","about","content","video","posts","tips"]);
  return new Set(hay.split(/[^a-z0-9]+/).filter(w => w.length > 3 && !stop.has(w)));
}

// True when a trend touches a stated boundary. Checks the display name AND
// the enrichment context, because the trend's title is often a bare sound or
// hashtag while the reason it is trending is where the subject actually
// shows up.
function violatesOffLimits(trend, terms) {
  if (!terms.length) return false;
  const hay = foldPlurals(
    [trend.display_name, trend.context, trend.reason]
      .filter(v => typeof v === "string")
      .join(" ")
      .toLowerCase(),
  );
  if (!hay) return false;
  return terms.some(t => hay.includes(t));
}

function topicOverlapBonus(trend, topicTokens) {
  if (!topicTokens.size) return 0;
  const words = String(trend.display_name || "").toLowerCase().split(/[^a-z0-9]+/);
  return words.some(w => w.length > 3 && topicTokens.has(w)) ? TOPIC_BONUS : 0;
}

// ── low-level fetch ─────────────────────────────────────────────────────────

async function sbGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: SUPABASE_HEADERS });
  if (!res.ok) throw new Error(`trend-context ${pathAndQuery} → ${res.status}`);
  return await res.json();
}

// Normalize the app's Title-case platform labels ("TikTok") to the lowercase
// keys the trend/playbook tables use ("tiktok").
function normPlatform(p) {
  return String(p || "").trim().toLowerCase();
}

function ymd(iso) {
  try { return new Date(iso).toISOString().slice(0, 10); } catch (_e) { return ""; }
}

// [TREND-FALLBACK] Most-recent legacy research row per requested platform,
// flattened into items. Called ONLY when the observed pipeline came back
// empty, so the healthy path pays no extra round trip.
//
// Platform names differ between the two tables — `trends` stores the app's
// Title-case labels ("TikTok"), `trend_items` stores lowercase keys — so the
// match is done on the normalized form.
async function loadLegacyTrends(requestedPlatforms) {
  const since = new Date(Date.now() - LEGACY_TREND_FRESHNESS_DAYS * 86400000).toISOString();
  const rows = await sbGet(
    "trends?select=platform,summary,items,fetched_at" +
    `&fetched_at=gte.${encodeURIComponent(since)}` +
    "&order=fetched_at.desc&limit=100",
  ).catch(() => []);
  if (!Array.isArray(rows) || !rows.length) return { items: [], asOf: "" };

  const want = new Set(requestedPlatforms.map(normPlatform));
  const newestByPlatform = new Map();
  for (const r of rows) {
    if (!r || !r.platform) continue;
    const key = normPlatform(r.platform);
    if (!want.has(key)) continue;
    if (!newestByPlatform.has(key)) newestByPlatform.set(key, r); // rows are desc-sorted
  }
  if (!newestByPlatform.size) return { items: [], asOf: "" };

  const items = [];
  let asOf = "";
  for (const [key, row] of newestByPlatform) {
    if (row.fetched_at && row.fetched_at > asOf) asOf = row.fetched_at;
    const list = Array.isArray(row.items) ? row.items : [];
    for (const it of list) {
      const name = it && typeof it.trend === "string" ? it.trend.trim() : "";
      if (!name) continue;
      const cat = it.category && LEGACY_TREND_CATEGORIES.has(String(it.category))
        ? String(it.category)
        : "topic";
      items.push({
        platform:     key,
        type:         cat,
        display_name: name,
        reason:       (typeof it.reason === "string" && it.reason.trim()) ? it.reason.trim() : "",
        external_url: (typeof it.source_url === "string" && /^https?:\/\//.test(it.source_url))
          ? it.source_url : null,
      });
    }
  }

  // Interleave across platforms before capping, so a single chatty platform
  // can't crowd the others out of the 5 slots.
  const byPlatform = new Map();
  for (const it of items) {
    const list = byPlatform.get(it.platform) || [];
    list.push(it);
    byPlatform.set(it.platform, list);
  }
  const interleaved = [];
  for (let i = 0; interleaved.length < items.length; i++) {
    let took = false;
    for (const list of byPlatform.values()) {
      if (i < list.length) { interleaved.push(list[i]); took = true; }
    }
    if (!took) break;
  }

  return { items: interleaved.slice(0, MAX_TRENDS), asOf };
}

// [TREND-FALLBACK] Deliberately NOT renderTrendItem. That renderer prints a
// lifecycle status ("status rising") which the legacy rows simply do not have —
// reusing it would mean inventing one, and an invented "rising" is exactly the
// kind of unfalsifiable claim the trend-grounding rule exists to stop.
function renderLegacyTrendItem(idx, t) {
  const parts = [`${idx}. ${String(t.type).toUpperCase()}: ${t.display_name}`];
  if (t.reason) parts.push(t.reason);
  let line = "  " + parts.join(" ");
  if (t.external_url) line += `\n     Source: ${t.external_url}`;
  return line;
}

// ── block assembly ──────────────────────────────────────────────────────────

function renderTrendItem(idx, t, targetPlatforms) {
  const type = String(t.type || "trend").toUpperCase();
  const name = t.display_name || "";
  const status = t.status || "";
  const parts = [`${idx}. ${type}: "${name}" — status ${status}.`];

  if (t.context) parts.push(t.context.trim());

  // Fallback framing: a TikTok trend shown to a non-TikTok target.
  const platform = normPlatform(t.platform);
  const wantsThisPlatform = targetPlatforms.includes(platform);
  if (!wantsThisPlatform && platform === FALLBACK_PLATFORM) {
    parts.push("(peaking on TikTok now → adapt it for this week's post.)");
  }

  let line = "  " + parts.join(" ");
  const angle = Array.isArray(t.suggested_angles) && t.suggested_angles.find(a => typeof a === "string" && a.trim());
  if (angle) line += `\n     Angle: ${angle.trim()}`;
  if (t.external_url) line += `\n     Link: ${t.external_url}`;
  return line;
}

/**
 * Build the DB-backed trend + playbook context for a generation.
 *
 * @param {object} opts
 * @param {string[]} opts.platforms  target platform label(s), e.g. ["TikTok","Instagram"]
 * @param {string}   opts.niche      user-facing niche label
 * @param {object}   [opts.profile]  profile (for segment hint recovery)
 * @returns {Promise<{ block: string, snapshot: object|null, usedTrends: boolean }>}
 */
export async function buildTrendContext({ platforms, niche, profile, goal, goalSecondary } = {}) {
  const empty = { block: "", snapshot: null, usedTrends: false };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return empty;

  const requested = (Array.isArray(platforms) ? platforms : [platforms])
    .map(normPlatform)
    .filter(Boolean);
  if (requested.length === 0) return empty;

  const segment = resolveSegment(niche, profile);

  try {
    // Include the TikTok fallback in the trend query so IG/other targets can
    // still surface trending TikTok signal.
    const trendPlatforms = Array.from(new Set([...requested, FALLBACK_PLATFORM]));
    const since = new Date(Date.now() - TREND_FRESHNESS_DAYS * 86400000).toISOString();

    const [trendRows, segRows, ...playbookRows] = await Promise.all([
      sbGet(
        // `last_seen` is selected as well as filtered on: it is what dates
        // the "as of" line below. It was previously filter-only, so every
        // row came back without it and the date silently fell through to
        // today — presenting a six-day-old trend to both the model and the
        // creator as this morning's signal.
        "trend_items?select=platform,type,display_name,external_url,status,context,suggested_angles,niche_scores,last_seen" +
        "&status=in.(rising,peaking)" +
        `&last_seen=gte.${encodeURIComponent(since)}` +
        `&platform=in.(${trendPlatforms.join(",")})` +
        "&limit=100",
      ).catch(() => []),
      sbGet(
        "playbook_segments?select=compliance_overlay,platform_priority,label" +
        `&segment_key=eq.${encodeURIComponent(segment)}&limit=1`,
      ).catch(() => []),
      // One playbook row per REQUESTED platform (not the fallback).
      ...requested.map(p =>
        sbGet(
          "platform_playbooks?select=content,niche_notes,version" +
          `&platform=eq.${encodeURIComponent(p)}&status=eq.active&order=version.desc&limit=1`,
        ).catch(() => []),
      ),
    ]);

    // Score + rank trends: fit = niche_scores[segment] >= floor, rising first,
    // then by fit desc. (Done in JS — PostgREST can't cast jsonb->>seg to float
    // for filter+order without a custom RPC, and this keeps the query simple.)
    // [TREND-PERSONALIZATION] Boundaries and subject matter the creator
    // stated, resolved once and reused for both the observed and legacy paths.
    const banned      = offLimitsTerms(profile);
    const topicTokens = creatorTopicTokens(profile);

    const scored = (Array.isArray(trendRows) ? trendRows : [])
      .map(t => ({ ...t, fit: Number(t.niche_scores && t.niche_scores[segment]) }))
      .filter(t => Number.isFinite(t.fit) && t.fit >= FIT_FLOOR)
      // Hard exclusion, before ranking — a trend the creator has ruled out is
      // not a low-ranked option, it is not an option.
      .filter(t => !violatesOffLimits(t, banned))
      .map(t => ({ ...t, rank_score: t.fit + topicOverlapBonus(t, topicTokens) }))
      .sort((a, b) => {
        const ar = a.status === "rising" ? 1 : 0;
        const br = b.status === "rising" ? 1 : 0;
        if (ar !== br) return br - ar;      // rising ahead of peaking
        return b.rank_score - a.rank_score; // then best fit, nudged by overlap
      })
      .slice(0, MAX_TRENDS);

    const segLabel = (segRows && segRows[0] && segRows[0].label) || segment.replace(/_/g, " ");
    const overlay = segRows && segRows[0] && segRows[0].compliance_overlay;

    // ── assemble, in the brief's WS2.D order ────────────────────────────────
    const sections = [];

    requested.forEach((p, i) => {
      const pb = playbookRows[i] && playbookRows[i][0];
      if (!pb) return;
      let sec = `[PLATFORM PLAYBOOK — ${p.toUpperCase()}]\n${(pb.content || "").trim()}`;
      const note = pb.niche_notes && pb.niche_notes[segment];
      if (note && String(note).trim()) {
        sec += `\n[SEGMENT NOTE — ${segLabel}]\n${String(note).trim()}`;
      }
      sections.push(sec);
    });

    if (overlay && String(overlay).trim()) {
      sections.push(`[COMPLIANCE OVERLAY — HARD RULES, non-negotiable]\n${String(overlay).trim()}`);
    }

    // [TREND-FALLBACK] Only reached when the observed pipeline is dry, so the
    // healthy path costs nothing. Observed data always wins — this is a
    // second source, never a merge.
    let legacy = { items: [], asOf: "" };
    if (scored.length === 0) {
      legacy = await loadLegacyTrends(requested).catch(() => ({ items: [], asOf: "" }));
      // [TREND-PERSONALIZATION] The same boundary check the observed path
      // gets. These rows were previously the LEAST filtered thing in the
      // system — no niche score, no fit floor, nothing — while being the
      // path that runs precisely when the observed pipeline is dark. A
      // creator's stated boundary should not depend on which pipeline is up.
      if (banned.length) {
        legacy = { ...legacy, items: legacy.items.filter(t => !violatesOffLimits(t, banned)) };
      }
    }

    let refreshedAt = "";
    if (scored.length) {
      // The "as of" date is the freshest trend we're actually showing.
      const latest = scored.reduce((mx, t) => {
        const d = t.last_seen || "";
        return d > mx ? d : mx;
      }, "");
      // No fallback to today. If we can't date the data, we say nothing
      // about its age rather than claiming freshness we haven't verified —
      // an unverifiable date is worse than no date, because the creator
      // reads it as a guarantee.
      refreshedAt = ymd(latest);
      const lines = scored.map((t, i) => renderTrendItem(i + 1, t, requested));
      sections.push(
        (refreshedAt ? `[CURRENT TRENDS as of ${refreshedAt}]\n` : "[CURRENT TRENDS]\n") +
        lines.join("\n") +
        "\n  Rules: use at most 2 of these trends, and only where they fit naturally. " +
        "Prefer RISING over peaking. Always name the exact sound or hashtag. " +
        "Never use a trend older than 7 days.",
      );
    } else if (legacy.items.length) {
      refreshedAt = ymd(legacy.asOf);
      const lines = legacy.items.map((t, i) => renderLegacyTrendItem(i + 1, t));
      sections.push(
        (refreshedAt ? `[CURRENT TRENDS as of ${refreshedAt}]\n` : "[CURRENT TRENDS]\n") +
        lines.join("\n") +
        "\n  PROVENANCE: these come from VIRL's weekly trend research of published sources (each cited above), NOT from live measurement of the platforms. They are real, dated, and checkable — but they carry no rising-or-peaking lifecycle signal, so refer to them as what is being talked about in this niche right now, never as what is 'peaking' or 'blowing up'. Do not attach an engagement number to any of them." +
        "\n  Rules: use at most 2 of these, and only where they fit naturally. Always name the exact hashtag, sound, format, or angle as written above.",
      );
    } else {
      sections.push(
        "[CURRENT TRENDS]\nNo current trend meets this creator's bar this week. " +
        "Do NOT cite any trend — build on the playbook, the creator's strategy, and logged results instead.",
      );
    }

    // [TREND-PERSONALIZATION] The goal, stated rather than scored. Placed
    // immediately after the trend list so it reads as a selection instruction
    // over the items just supplied, not as a general aspiration. Only emitted
    // when a goal exists — an empty directive is worse than none, because it
    // invites the model to invent what the creator is optimizing for.
    const goalText = [goal, goalSecondary && goalSecondary !== goal ? goalSecondary : ""]
      .filter(g => typeof g === "string" && g.trim())
      .join(", then ");
    if (goalText) {
      sections.push(
        `[TREND SELECTION — THIS CREATOR'S GOAL]\nTheir stated goal is: ${goalText}. ` +
        "Of the trends above, prefer the ones that can plausibly move THAT goal, and angle whichever you use toward it. " +
        "A trend that fits the niche but does nothing for this goal is worth skipping — using fewer trends is allowed and often better. " +
        "Do not claim a trend serves the goal in a way the trend data above does not support.",
      );
    }

    // Precedence, matching the platform_playbooks 'global' usage rules.
    sections.push(
      "PRECEDENCE: trend data wins on WHAT is trending; the playbook wins on FORMAT and SPECS.",
    );

    // If we got literally nothing useful (no playbook, no trends), signal empty
    // so the builder's own empty-state takes over cleanly.
    const hasPlaybook = sections.some(s => s.startsWith("[PLATFORM PLAYBOOK"));
    if (!hasPlaybook && scored.length === 0 && legacy.items.length === 0) return empty;

    const block = sections.join("\n\n");
    const snapshot = {
      v: SNAPSHOT_VERSION,
      block,
      segment,
      // Empty when the data can't be dated — the UI already branches on
      // this and falls back to undated wording. Same reason as above: do
      // not stamp today's date on data whose age we don't know.
      refreshedAt,
      // [TREND-FALLBACK] Fallback items ride the SAME snapshot shape. This is
      // load-bearing, not cosmetic: the client's trend verifier builds its
      // allow-list from `items[].display_name` and strips any cited trend it
      // can't find there. Omitting them would make the scrub delete the very
      // trends the prompt just supplied. `status` is null rather than a
      // plausible-looking "rising" — these rows carry no lifecycle signal and
      // inventing one here would launder a guess into the snapshot the
      // creator's UI reads back.
      items: scored.length
        ? scored.map(t => ({
            type: t.type, display_name: t.display_name, status: t.status,
            platform: t.platform, external_url: t.external_url || null,
          }))
        : legacy.items.map(t => ({
            type: t.type, display_name: t.display_name, status: null,
            platform: t.platform, external_url: t.external_url,
          })),
    };

    return { block, snapshot, usedTrends: scored.length > 0 || legacy.items.length > 0 };
  } catch (_e) {
    return empty;
  }
}

// Validate a client-supplied snapshot before trusting it on a regen path.
export function isValidTrendSnapshot(s) {
  return !!(s && typeof s === "object" && s.v === SNAPSHOT_VERSION && typeof s.block === "string");
}

export { SNAPSHOT_VERSION };
