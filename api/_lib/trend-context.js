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
export async function buildTrendContext({ platforms, niche, profile } = {}) {
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
        "trend_items?select=platform,type,display_name,external_url,status,context,suggested_angles,niche_scores" +
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
    const scored = (Array.isArray(trendRows) ? trendRows : [])
      .map(t => ({ ...t, fit: Number(t.niche_scores && t.niche_scores[segment]) }))
      .filter(t => Number.isFinite(t.fit) && t.fit >= FIT_FLOOR)
      .sort((a, b) => {
        const ar = a.status === "rising" ? 1 : 0;
        const br = b.status === "rising" ? 1 : 0;
        if (ar !== br) return br - ar;      // rising ahead of peaking
        return b.fit - a.fit;               // then best fit
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

    let refreshedAt = "";
    if (scored.length) {
      // The "as of" date is the freshest trend we're actually showing.
      const latest = scored.reduce((mx, t) => {
        const d = t.last_seen || "";
        return d > mx ? d : mx;
      }, "");
      refreshedAt = ymd(latest) || ymd(new Date().toISOString());
      const lines = scored.map((t, i) => renderTrendItem(i + 1, t, requested));
      sections.push(
        `[CURRENT TRENDS as of ${refreshedAt}]\n` +
        lines.join("\n") +
        "\n  Rules: use at most 2 of these trends, and only where they fit naturally. " +
        "Prefer RISING over peaking. Always name the exact sound or hashtag. " +
        "Never use a trend older than 7 days.",
      );
    } else {
      sections.push(
        "[CURRENT TRENDS]\nNo current trend meets this creator's bar this week. " +
        "Do NOT cite any trend — build on the playbook, the creator's strategy, and logged results instead.",
      );
    }

    // Precedence, matching the platform_playbooks 'global' usage rules.
    sections.push(
      "PRECEDENCE: trend data wins on WHAT is trending; the playbook wins on FORMAT and SPECS.",
    );

    // If we got literally nothing useful (no playbook, no trends), signal empty
    // so the builder's own empty-state takes over cleanly.
    const hasPlaybook = sections.some(s => s.startsWith("[PLATFORM PLAYBOOK"));
    if (!hasPlaybook && scored.length === 0) return empty;

    const block = sections.join("\n\n");
    const snapshot = {
      v: SNAPSHOT_VERSION,
      block,
      segment,
      refreshedAt: refreshedAt || ymd(new Date().toISOString()),
      items: scored.map(t => ({
        type: t.type, display_name: t.display_name, status: t.status,
        platform: t.platform, external_url: t.external_url || null,
      })),
    };

    return { block, snapshot, usedTrends: scored.length > 0 };
  } catch (_e) {
    return empty;
  }
}

// Validate a client-supplied snapshot before trusting it on a regen path.
export function isValidTrendSnapshot(s) {
  return !!(s && typeof s === "object" && s.v === SNAPSHOT_VERSION && typeof s.block === "string");
}

export { SNAPSHOT_VERSION };
