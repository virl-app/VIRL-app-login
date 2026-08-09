// Enrichment: niche tagging (one batched Claude call) + context (Perplexity).
//
// Cost shape per run, by design:
//   • exactly ONE Anthropic call, regardless of how many trends came in
//   • at most PERPLEXITY_MAX_CALLS Perplexity calls
// Both ceilings are enforced here in code, not just vendor-side.

import { CANONICAL_SEGMENTS, type SegmentKey, type TrendStatus } from "./types.ts";

/** Hard cap on Perplexity enrichment calls per run (brief: 10). */
export const PERPLEXITY_MAX_CALLS = 10;

/** Minimum niche score for a trend to be worth a Perplexity call. */
export const ENRICH_SCORE_FLOOR = 0.6;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";

export interface TaggableTrend {
  id: string;
  displayName: string;
  type: string;
  platform: string;
  views?: number | null;
  postCount?: number | null;
}

export interface NicheTag {
  scores: Record<string, number>;
  note: string;
}

/**
 * Models write JSON with varying amounts of ceremony around it (prose preamble,
 * ```json fences). Pull the first balanced array/object out rather than trusting
 * the whole body to parse.
 */
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch { /* fall through to substring scan */ }

  for (const [open, close] of [["[", "]"], ["{", "}"]] as const) {
    const start = cleaned.indexOf(open);
    const end = cleaned.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch { /* try the other bracket type */ }
    }
  }
  return null;
}

/** Clamp to [0,1] and drop anything that isn't a canonical segment key. */
function sanitizeScores(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const seg of CANONICAL_SEGMENTS) {
    const v = (raw as Record<string, unknown>)[seg];
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) out[seg] = Math.min(1, Math.max(0, Math.round(n * 100) / 100));
  }
  return out;
}

/**
 * ONE batched Claude call for every trend that needs tagging. Returns a map
 * keyed by trend id; trends the model omits simply don't get an entry and keep
 * whatever niche_scores they already had.
 */
export async function tagNiches(
  trends: TaggableTrend[],
  opts: {
    apiKey: string;
    model?: string;
    fetchImpl?: typeof fetch;
    log?: (m: string, e?: unknown) => void;
  },
): Promise<Map<string, NicheTag>> {
  const result = new Map<string, NicheTag>();
  if (trends.length === 0) return result;

  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m: string, e?: unknown) => console.log(`[enrich:tag] ${m}`, e ?? ""));
  const model = opts.model ?? "claude-haiku-4-5-20251001";

  // Index-addressed rather than name-addressed: display names contain quotes,
  // emoji and em-dashes that models mangle on echo, and a mangled key would
  // silently drop the row.
  const list = trends
    .map((t, i) =>
      `${i}. [${t.type} on ${t.platform}] ${t.displayName}` +
      (t.views ? ` (~${t.views.toLocaleString()} views` + (t.postCount ? `, ${t.postCount} posts)` : ")") : ""),
    )
    .join("\n");

  const prompt =
`You are scoring social-media trends for how well each fits nine audience segments.

SEGMENTS: ${CANONICAL_SEGMENTS.join(", ")}

TRENDS:
${list}

For EACH trend return a fit score from 0 to 1 for EVERY segment (0 = irrelevant, 1 = a perfect fit), plus a one-line note on how a creator could adapt it.

Respond with ONLY a JSON array, one object per trend, no prose:
[{"i": 0, "scores": {${CANONICAL_SEGMENTS.map((s) => `"${s}": 0.0`).join(", ")}}, "note": "one line"}]`;

  // ~160 tokens/trend of JSON, with headroom and a ceiling.
  const maxTokens = Math.min(8000, 512 + trends.length * 200);

  let res: Response;
  try {
    res = await doFetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    log("anthropic request failed — trends keep existing scores", e instanceof Error ? e.message : e);
    return result;
  }

  if (!res.ok) {
    log(`anthropic HTTP ${res.status} — trends keep existing scores`, await res.text().catch(() => ""));
    return result;
  }

  const body = await res.json().catch(() => null) as { content?: Array<{ text?: string }> } | null;
  const text = body?.content?.map((c) => c.text ?? "").join("") ?? "";
  const parsed = extractJson<Array<{ i?: number; scores?: unknown; note?: unknown }>>(text);

  if (!Array.isArray(parsed)) {
    log("could not parse tagging response — trends keep existing scores");
    return result;
  }

  for (const row of parsed) {
    const idx = typeof row?.i === "number" ? row.i : Number(row?.i);
    const trend = Number.isInteger(idx) ? trends[idx] : undefined;
    if (!trend) continue;
    result.set(trend.id, {
      scores: sanitizeScores(row.scores),
      note: typeof row.note === "string" ? row.note.trim() : "",
    });
  }

  log(`tagged ${result.size}/${trends.length} trends in 1 call (${model})`);
  return result;
}

export interface EnrichCandidate {
  id: string;
  displayName: string;
  status: TrendStatus;
  scores: Record<string, number>;
}

/**
 * Pick the trends worth a Perplexity call: any niche score >= 0.6, status in
 * (new, rising), best-scoring first, capped at PERPLEXITY_MAX_CALLS.
 * Pure so the cap is unit-testable without touching the network.
 */
export function selectForEnrichment(
  candidates: EnrichCandidate[],
  limit = PERPLEXITY_MAX_CALLS,
): Array<EnrichCandidate & { topSegment: SegmentKey; topScore: number }> {
  return candidates
    .map((c) => {
      let topSegment: SegmentKey = CANONICAL_SEGMENTS[0];
      let topScore = -1;
      for (const seg of CANONICAL_SEGMENTS) {
        const v = c.scores?.[seg];
        if (typeof v === "number" && v > topScore) {
          topScore = v;
          topSegment = seg;
        }
      }
      return { ...c, topSegment, topScore };
    })
    .filter((c) => c.topScore >= ENRICH_SCORE_FLOOR && (c.status === "new" || c.status === "rising"))
    .sort((a, b) => b.topScore - a.topScore)
    .slice(0, limit);
}

export interface TrendContext {
  context: string;
  angles: string[];
}

// Perplexity's sonar responses embed inline citation markers like [1][9].
// They're noise inside a generation prompt, so scrub them (and tidy the space
// they leave before punctuation) from both the explanation and the angles.
export function stripCitations(s: string): string {
  return s
    .replace(/\[\d+\]/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * One Perplexity call per selected trend, hard-capped. A failure on any single
 * trend is swallowed — enrichment is a nice-to-have on top of an already-valid
 * ingestion run.
 */
export async function enrichContext(
  selected: Array<{ id: string; displayName: string; topSegment: string }>,
  opts: {
    apiKey: string;
    segmentLabels?: Record<string, string>;
    fetchImpl?: typeof fetch;
    log?: (m: string, e?: unknown) => void;
  },
): Promise<Map<string, TrendContext>> {
  const out = new Map<string, TrendContext>();
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m: string, e?: unknown) => console.log(`[enrich:ctx] ${m}`, e ?? ""));

  const capped = selected.slice(0, PERPLEXITY_MAX_CALLS);
  if (capped.length < selected.length) {
    log(`capped enrichment at ${PERPLEXITY_MAX_CALLS} (${selected.length} eligible)`);
  }

  let calls = 0;
  for (const t of capped) {
    if (calls >= PERPLEXITY_MAX_CALLS) break;
    const label = opts.segmentLabels?.[t.topSegment] ?? t.topSegment.replace(/_/g, " ");
    const prompt =
`Explain why ${t.displayName} is trending on TikTok this week and give 3 ways a ${label} could adapt it.

Respond with ONLY JSON: {"explanation": "2-3 sentences", "angles": ["way 1", "way 2", "way 3"]}`;

    try {
      calls++;
      const res = await doFetch(PERPLEXITY_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: "sonar",
          messages: [{ role: "user", content: prompt }],
          // [SEARCH-CONTROLS] Was "low". This call writes the `context` string
          // and the `suggested_angles` that get injected into generation
          // prompts and rendered to the creator as the reason a trend matters
          // — the most-read output of the whole ingest. "low" was buying less
          // grounding on the one string here that a creator actually reads.
          // "medium" rather than "high": this is capped at 10 calls per run
          // and the question ("why is X trending, give 3 angles") is narrow,
          // so the marginal source has less to add than it does on the
          // open-ended weekly research.
          web_search_options: { search_context_size: "medium" },
          // Matches the trend it is explaining: the ingest only enriches
          // trends observed in the last few days, so a source from six months
          // ago is describing a different moment.
          search_recency_filter: "week",
        }),
      });

      if (!res.ok) {
        log(`${t.displayName}: HTTP ${res.status} — skipping`);
        continue;
      }

      const body = await res.json().catch(() => null) as
        { choices?: Array<{ message?: { content?: string } }> } | null;
      const text = body?.choices?.[0]?.message?.content ?? "";
      const parsed = extractJson<{ explanation?: string; angles?: unknown }>(text);

      const angles = Array.isArray(parsed?.angles)
        ? parsed!.angles.filter((a): a is string => typeof a === "string" && a.trim() !== "").map(stripCitations).slice(0, 3)
        : [];
      // Fall back to the raw answer if the JSON envelope didn't survive — a
      // paragraph of real context beats discarding the call we already paid for.
      const context = stripCitations((parsed?.explanation ?? text).trim());
      if (context) out.set(t.id, { context, angles });
    } catch (e) {
      log(`${t.displayName}: request failed — skipping`, e instanceof Error ? e.message : e);
    }
  }

  log(`enriched ${out.size} trends in ${calls} perplexity calls`);
  return out;
}
