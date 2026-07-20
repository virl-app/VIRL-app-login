// [HANDLE-RESEARCH] Per-user Perplexity research on the creator's actual
// social presence — what topics they post about, their voice/tone, visual
// signatures, AND verbatim caption excerpts from their indexed posts.
// Threaded into the system prompt as additional creator context so
// generations don't have to guess at a profile we could just look up.
//
// Pattern mirrors api/_lib/trends-research.js (Perplexity Sonar wrapper +
// best-effort parsing + fail-open semantics). Differences:
//   - Cached per-user in creator_handle_research instead of per-platform
//     in latest_trends.
//   - 30-day TTL instead of 7-day — a creator's voice doesn't shift weekly.
//   - Refresh keyed on handles_hash so swapping/adding a handle forces a
//     re-fetch independent of the TTL. The hash also includes the
//     inspiration field so adding/changing "a creator whose style you
//     admire" busts the cache and re-asks Perplexity.
//   - Returns { researchText, postExcerpts } so the prompt builder gets
//     the descriptive paragraph and voice-drift.js gets the verbatim
//     excerpts as a separate corpus.

import crypto from "node:crypto";
import { callPerplexity } from "./perplexity.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Refresh research older than this OR when the handles / inspiration change.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
// [NEGATIVE-TTL] Empty rows (NO_USEFUL_RESEARCH / parse failure) expire
// much sooner. A transient Perplexity flub or an overly-cautious bail used
// to blank a creator's research for the full 30 days — with the Profile
// panel now SHOWING the research, that read as "VIRL lost my platforms."
// 6 hours is long enough to not hammer Perplexity, short enough that the
// next day's session retries.
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;

// [RESEARCH-V2] Bump when buildResearchPrompt materially changes. Folded
// into the handles hash so every cached row from the previous prompt
// version re-fetches on next use — without this, existing users would
// keep their v1 research (fewer dimensions, 5 excerpts) for up to 30 days.
// [HANDLE-URLS] v3: handles now render as canonical profile URLs with a
// "resolve the account from the URL, don't name-search" instruction.
// [WEBSITE-FALLBACK] v4: when no social profile is publicly indexable but
// the business website is readable, the brief is written from the website
// instead of bailing with NO_USEFUL_RESEARCH.
// [SONAR-PRO-FALLBACK] v5: a failed `sonar` attempt now retries once with
// `sonar-pro` before giving up. Bumped so users already sitting on a
// negative-cached row (NEGATIVE_TTL_MS = 6h) get a fresh attempt with the
// stronger fallback immediately instead of serving the pre-fix "nothing
// found" result until the negative TTL happens to expire.
const PROMPT_VERSION = "v5";

// [HANDLE-URLS] Defensive cleanup of a stored handle value. The client
// normalizes on blur + save (index.html#normalizeSocialInput), but legacy
// rows and API writes can still carry "@name", full URLs, or stray
// slashes. Output is a bare handle ("lauren") or a qualifier path
// ("in/lauren-doty", "channel/UCxxx", "profile.php?id=123").
function cleanStoredHandle(v) {
  let s = String(v || "").trim();
  if (!s) return "";
  // [SHARE-LINK FIX] A stored full URL is the most precise research target
  // there is — pass it through untouched. The client now deliberately
  // stores full URLs for opaque shortlinks (facebook.com/share/XyZ) where
  // no handle is extractable; stripping the domain here turned those into
  // meaningless path fragments.
  if (/^https?:\/\//i.test(s)) return s;
  s = s.replace(/^www\./i, "");
  const slash = s.indexOf("/");
  // A dot before the first slash means a domain slipped in — drop it and
  // keep the path, which carries the identity.
  if (slash > 0 && s.slice(0, slash).indexOf(".") >= 0) s = s.slice(slash + 1);
  s = s.replace(/^\/+|\/+$/g, "");
  // Leading @ only matters when it's a bare handle, not a path.
  if (s.indexOf("/") < 0) s = s.replace(/^@+/, "");
  return s;
}

// [HANDLE-URLS] Canonical public profile URL per platform. Platform keys
// are the client's display names (TikTok, Instagram, ...), matched
// case-insensitively. Qualifier paths append to the domain root so
// linkedin company pages, youtube channel IDs, and facebook numeric
// profiles all resolve. Unknown platforms return "" and the prompt just
// shows the bare handle.
function profileUrlFor(platform, handle) {
  const h = handle;
  if (!h) return "";
  if (/^https?:\/\//i.test(h)) return h;
  const p = String(platform || "").toLowerCase();
  const isPath = h.indexOf("/") >= 0 || h.indexOf("?") >= 0;
  if (p === "tiktok")    return "https://www.tiktok.com/" + (isPath ? h : "@" + h);
  if (p === "instagram") return "https://www.instagram.com/" + (isPath ? h : h + "/");
  if (p === "youtube")   return "https://www.youtube.com/" + (isPath ? h : "@" + h);
  if (p === "linkedin")  return "https://www.linkedin.com/" + (isPath ? h : "in/" + h + "/");
  if (p === "facebook")  return "https://www.facebook.com/" + h;
  if (p === "x" || p === "twitter") return "https://x.com/" + h;
  if (p === "pinterest") return "https://www.pinterest.com/" + (isPath ? h : h + "/");
  return "";
}

// Deterministic, content-addressable signature so a row's handles_hash
// trivially tells us whether the cached research is still about the right
// set of inputs. Sorted keys keep {tiktok, instagram} === {instagram, tiktok}.
// Inspiration is included so changing the admired-creator answer forces a
// re-fetch — Perplexity's response materially depends on it.
// [BUSINESS-WEBSITE] businessWebsite is folded into the same hash so
// editing or adding a URL re-fetches research that incorporates it.
// Empty / absent website hashes the same as before, so users without a
// site don't get cache churn from this change.
function hashHandles(handles, inspiration, businessWebsite) {
  const safeHandles = (handles && typeof handles === "object") ? handles : {};
  const sortedHandles = Object.keys(safeHandles)
    .filter(k => safeHandles[k])
    .sort()
    .map(k => k.toLowerCase() + ":" + String(safeHandles[k]).trim().toLowerCase());
  const inspStr = (inspiration && typeof inspiration === "string")
    ? inspiration.trim().toLowerCase()
    : "";
  const siteStr = (businessWebsite && typeof businessWebsite === "string")
    ? businessWebsite.trim().toLowerCase()
    : "";
  return crypto.createHash("sha256")
    .update(PROMPT_VERSION + "||" + sortedHandles.join("|") + "||insp:" + inspStr + "||site:" + siteStr)
    .digest("hex");
}

// Reads the cached research row. Returns null on any failure (network,
// missing table) so callers degrade to "skip the research block" rather
// than failing the whole generation. select=* keeps this forward-compatible
// across migration boundaries: pre-008 rows simply return without
// post_excerpts and downstream Array.isArray() falls through to [].
async function readCache(userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !userId) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/creator_handle_research?user_id=eq.${userId}&select=*`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows && rows[0] ? rows[0] : null;
  } catch (e) { return null; }
}

// Upserts the cache. Fire-and-forget from the caller's perspective.
async function writeCache(userId, research_text, post_excerpts, handles_hash) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !userId) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/creator_handle_research`, {
      method: "POST",
      headers: {
        apikey:           SUPABASE_SERVICE_KEY,
        Authorization:    `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type":   "application/json",
        Prefer:           "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        user_id:       userId,
        research_text,
        post_excerpts: Array.isArray(post_excerpts) ? post_excerpts : [],
        handles_hash,
        fetched_at:    new Date().toISOString(),
      }),
    });
  } catch (e) { /* non-fatal */ }
}

// Builds the Perplexity prompt. Asks for two things in one call:
//   1. A tight descriptive paragraph (same as before) — fed to the LLM as
//      creator context.
//   2. Up to 5 verbatim caption excerpts from indexed posts — fed to voice-
//      drift telemetry (and future few-shot exemplar slots) so the
//      stylometric reference isn't just the single sampleCaption.
//
// Inspiration ("a creator whose style you admire") is mentioned as context,
// not as a research target. We want excerpts from THE USER, not from their
// idol — diluting the voice reference with someone else's writing would
// defeat the purpose. The descriptive paragraph IS allowed to note how the
// user's actual posting compares to that aspiration, which can sharpen the
// LLM's voice instructions.
function buildResearchPrompt(handles, inspiration, businessWebsite) {
  // [HANDLE-URLS] Render each handle WITH its canonical profile URL and
  // tell the model to resolve the account from the URL. A bare handle
  // forces the search engine to name-match, which is exactly how a
  // same-name lookalike account ends up describing the wrong person for
  // 30 days. The direct link removes the ambiguity.
  const handleList = Object.keys(handles)
    .filter(k => handles[k])
    .map(k => {
      const h = cleanStoredHandle(handles[k]);
      if (!h) return null;
      const url = profileUrlFor(k, h);
      // Full-URL values ARE the link — don't render them twice.
      if (/^https?:\/\//i.test(h)) return "  - " + k + ": " + h;
      const label = h.indexOf("/") >= 0 ? h : "@" + h;
      return "  - " + k + ": " + label + (url ? " → " + url : "");
    })
    .filter(Boolean)
    .join("\n");
  const inspirationLine = (inspiration && typeof inspiration === "string" && inspiration.trim())
    ? "Style aspiration the creator named (context only — do NOT excerpt this person's posts): " + inspiration.trim()
    : "";
  // [BUSINESS-WEBSITE] When the creator has supplied a business / brand
  // URL AND consented to public-post research, ask Perplexity to read
  // the site for voice + offering signals. Crucially: we want the site
  // to INFORM the descriptive paragraph (voice + topics), not become
  // its own deliverable. Marketing-page voice is often more polished
  // than the creator's social voice, so we tell Perplexity to weight
  // the social handles more heavily and use the site as a secondary
  // input for offerings, services, and any specific terminology /
  // claims the brand uses consistently.
  const businessLine = (businessWebsite && typeof businessWebsite === "string" && businessWebsite.trim())
    ? "Business / brand website (read this for the creator's actual offerings, services, and brand-consistent terminology — use as a secondary voice signal behind the social handles, since marketing copy on a website is often more formal than this creator's social posts): " + businessWebsite.trim()
    : "";
  const hasWebsite = !!businessLine;

  return [
    "Research this creator's actual posting patterns across their connected platforms"
      + (hasWebsite ? ", and review their business website for offerings + brand-consistent terminology" : "")
      + ".",
    "",
    handleList
      ? "Profiles to research (open each URL directly and research THAT exact account — do NOT search by name or handle text, which risks pulling a different person with the same name. If a URL is unreachable, has no indexable posts, or clearly belongs to a different person or business than the other profiles suggest, say so plainly for that platform instead of substituting a lookalike account):\n" + handleList
      : "Handles: (none provided)",
    ...(inspirationLine ? ["", inspirationLine] : []),
    ...(businessLine    ? ["", businessLine]    : []),
    "",
    "Look at what's publicly visible. Surface:",
    "  1. What topics or themes do they consistently post about? (3-5 specific ones)",
    "  2. What's their voice / tone like? Pick concrete adjectives (warm, dry, conversational, authoritative, irreverent, etc.) — not generic praise. Anchor your read in the SOCIAL posts, not the website (which may be more formal). If they named a style aspiration above, briefly note how their actual voice compares (matches it, partway there, diverges).",
    "  3. What visual signature, if any? (e.g. 'always shot outdoors,' 'high-contrast B&W,' 'kitchen flat-lays,' 'screen-recorded tutorials')",
    "  4. Any recurring phrases, sign-offs, or in-jokes that show up in their captions?",
    // [RESEARCH-V2] Three added dimensions: formats/series (so plans can
    // continue what the creator already runs instead of inventing parallel
    // lookalikes), visible resonance (only what's actually observable), and
    // untouched adjacent topics (variety fuel beyond the profile fields).
    "  5. What content FORMATS do they actually use (talking-head video, carousels, photo + long caption, Stories-style casual clips), and do they run any recurring series or franchises (a named weekly segment, a repeated format, an ongoing storyline)? Name the series if one exists.",
    "  6. Where engagement is VISIBLE (comment counts, visible like counts), which of their posts or topics clearly resonate most with their audience? Only report what you can actually observe — if engagement isn't visible, skip this rather than guessing.",
    "  7. What 2-3 topics ADJACENT to their niche do they post about rarely or never — obvious angles a strategist would flag as untapped? Frame these as observations about coverage, not criticisms.",
    ...(hasWebsite
      ? ["  8. From the business website: what specific products, services, or programs does this creator actually offer? Any branded terminology (program names, signature methods, taglines) that should be used verbatim in generated content rather than improvised? Stay concrete — name the actual offerings, do not paraphrase the website's marketing language."]
      : []),
    "",
    // [PARTIAL-RESULTS] The escape hatch is now strictly last-resort. The
    // previous wording let one dead link or one thin platform tip the model
    // into bailing on the WHOLE brief — a creator with a rich Instagram and
    // a broken Facebook shortlink got NO research (which then negative-
    // cached). Partial coverage is the expected, useful outcome.
    "Be honest about uncertainty. If a profile returns very few indexable posts or its URL is unreachable, say so plainly for THAT platform — DO NOT invent details, and never fill a numbered point with plausible guesses. But a dead link or an empty platform is NOT a reason to abandon the brief: write it from the platforms that DID yield content, and name the ones that came up empty."
      + (hasWebsite
        ? " WEBSITE FALLBACK: small or new creators are often not in the public search index at all — their social pages return nothing while their business website reads fine. In that case still write the brief: ground it in the website's voice, offerings, and terminology, open with a plain statement that the social profiles weren't publicly indexable yet, and output 'POST_EXCERPTS: NONE'. Return EXACTLY the string NO_USEFUL_RESEARCH (and nothing else) ONLY when the social profiles AND the website all yield nothing usable."
        : " Return EXACTLY the string NO_USEFUL_RESEARCH (and nothing else) ONLY when every single profile above yields nothing usable at all."),
    "",
    "Format your reply with TWO sections separated by a blank line:",
    "",
    "FIRST SECTION — one tight paragraph (max " + (hasWebsite ? "12" : "10") + " sentences) summarizing the points above. No headings, no bullet points, no marketing language. Treat this as a brief to another writer who needs to sound like this person, extend the series they already run, and reference their actual business correctly.",
    "",
    "SECOND SECTION — a line that says exactly 'POST_EXCERPTS:' followed by up to 8 verbatim caption / post excerpts from THIS creator's actual indexed posts, one per line, each starting with '- '. Pick excerpts that show their RANGE, not eight variations of the same register — mix opening hooks, sign-offs, one-liners, and a longer storytelling beat if they have one. Each excerpt should be 8-50 words. Quote them exactly — do not paraphrase. If you cannot find any real excerpts (uncached, private, or too few posts), output exactly 'POST_EXCERPTS: NONE' instead.",
  ].join("\n");
}

// Splits the Perplexity response into the descriptive paragraph and the
// excerpt list. Robust to: the section being missing, the model paraphrasing
// the header ("Post excerpts:" / "Excerpts:"), inconsistent bullet glyphs,
// or the model returning NONE. Returns { description, excerpts }.
function parseResearchResponse(rawText) {
  if (!rawText || typeof rawText !== "string") {
    return { description: "", excerpts: [] };
  }
  const text = rawText.trim();

  // Locate the excerpts header. Tolerant of slight wording variations so a
  // model that says "Post Excerpts:" or "POST EXCERPTS:" still parses.
  const headerRe = /\n\s*POST[_\s-]?EXCERPTS\s*:/i;
  const headerMatch = text.match(headerRe);
  if (!headerMatch) {
    // No excerpts section returned — treat the whole reply as the
    // description and surface zero excerpts.
    return { description: text, excerpts: [] };
  }

  const description = text.slice(0, headerMatch.index).trim();
  const excerptsBlob = text.slice(headerMatch.index + headerMatch[0].length).trim();

  if (/^NONE\b/i.test(excerptsBlob)) {
    return { description, excerpts: [] };
  }

  // Pull bullet lines: "- ...", "* ...", "• ...", or plain lines. Strip the
  // bullet glyph + leading/trailing whitespace + surrounding quotes the
  // model sometimes wraps excerpts in.
  const excerpts = excerptsBlob
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*[-*•]\s+/, "").trim())
    .map(line => line.replace(/^["“]+|["”]+$/g, "").trim())
    .filter(line => line.length >= 8 && line.length <= 500);

  return { description, excerpts };
}

// Public entry. Returns either null (no usable research) or:
//   { researchText: string, postExcerpts: string[] }
//
// Caller (chat.js) sets profile.handleResearch = researchText (preserving
// the prompts.js consumption shape) and profile.handlePostExcerpts =
// postExcerpts (for voice-drift telemetry and future few-shot exemplars).
//
// Cache TTL is 30 days; handles_hash refresh is immediate on handle,
// inspiration, OR business-website change. The website is gated on the
// same learn_from_public_posts consent as the handle research — callers
// must check the flag before invoking. We don't gate inside this
// function because chat.js + profile-research-prewarm.js each have
// their own reasons for the call (and chat.js short-circuits before
// reaching here when consent is off).
export async function fetchHandleResearch(userId, handles, inspiration, businessWebsite) {
  if (!userId) return null;
  const safeHandles = (handles && typeof handles === "object") ? handles : {};
  const hasHandle  = Object.keys(safeHandles).some(k => safeHandles[k]);
  const hasWebsite = !!(businessWebsite && typeof businessWebsite === "string" && businessWebsite.trim());
  // [BUSINESS-WEBSITE] If neither handles nor a website is present
  // there's literally nothing for Perplexity to read — skip. With
  // either signal, proceed: a creator with only a website (no public
  // social handles yet) still gets brand-grounded research.
  if (!hasHandle && !hasWebsite) return null;

  const currentHash = hashHandles(safeHandles, inspiration, businessWebsite);
  const cached = await readCache(userId);
  if (cached && cached.handles_hash === currentHash) {
    const ageMs = Date.now() - Date.parse(cached.fetched_at || 0);
    // [NEGATIVE-TTL] Negative rows (empty research_text) get the short
    // TTL: within it, surface null so callers skip the block; past it,
    // fall through to a fresh Perplexity attempt.
    const ttl = cached.research_text ? TTL_MS : NEGATIVE_TTL_MS;
    if (Number.isFinite(ageMs) && ageMs < ttl) {
      if (!cached.research_text) return null;
      return {
        researchText: cached.research_text,
        postExcerpts: Array.isArray(cached.post_excerpts) ? cached.post_excerpts : [],
      };
    }
  }

  // Cache miss / stale / inputs changed → re-fetch. Bump the token
  // budget when the website is included since Perplexity needs room
  // to surface offerings + voice signals in the same paragraph.
  // [RESEARCH-V2] Budgets raised for the three added dimensions + up to
  // 8 excerpts (was 5).
  const prompt    = buildResearchPrompt(safeHandles, inspiration, businessWebsite);
  const maxTokens = hasWebsite ? 1700 : 1400;
  let result = await attemptResearch(prompt, "sonar", maxTokens);
  // [SONAR-PRO-FALLBACK] Base `sonar` search sometimes can't ground on
  // accounts that ARE public but thin on generic-search signal (a real
  // creator, correctly-linked profile, still comes back empty). Before
  // accepting defeat and negative-caching for NEGATIVE_TTL_MS, retry once
  // with `sonar-pro` — a deeper, more expensive search pass more likely to
  // actually resolve the linked URLs rather than bail. Only spent on the
  // failure path (cache hits and first-try successes never reach here),
  // so the extra cost is bounded to once per user per handle-set change.
  if (!result) {
    result = await attemptResearch(prompt, "sonar-pro", maxTokens);
  }
  if (!result) {
    // Cache the negative result with the current hash so we don't fire
    // again until inputs change or the TTL expires.
    writeCache(userId, "", [], currentHash).catch(() => {});
    return null;
  }

  writeCache(userId, result.description, result.excerpts, currentHash).catch(() => {});
  return { researchText: result.description, postExcerpts: result.excerpts };
}

// One Perplexity attempt + parse. Returns null on any failure (API error,
// NO_USEFUL_RESEARCH, or an unparseable/empty reply) so the caller can
// decide whether to retry with a stronger model or give up.
async function attemptResearch(prompt, model, maxTokens) {
  const out = await callPerplexity({ prompt, model, maxTokens });
  if (!out || typeof out.text !== "string") return null;
  const rawText = out.text.trim();
  if (!rawText || rawText === "NO_USEFUL_RESEARCH") return null;
  const { description, excerpts } = parseResearchResponse(rawText);
  if (!description) return null;
  return { description, excerpts };
}
