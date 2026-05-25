// [COMPLIANCE 1] Compliance distillation pipeline.
//
// Fetches canonical agency guidance pages, distills each into a
// model-ready { rule_text, denylist, compliance_note } draft, and upserts
// into compliance_sources / inserts into compliance_rules at status=draft.
// Generation NEVER reads drafts — a human reviews each row in Supabase
// and sets status='approved' before it reaches the prompt builder.
//
// Two callers share this module:
//
//   - api/cron/compliance-refresh.js  (weekly scheduled job)
//   - scripts/ingest-compliance.mjs   (local CLI invocation)
//
// Mirrors the shape of api/_lib/playbook-research.js + api/cron/playbook-refresh.js.

import crypto from "node:crypto";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;

// User-Agent: identifies the crawler + gives the agencies an inbox for
// any concerns. Role mailbox so it survives team changes.
const USER_AGENT = "VIRL-compliance-ingest/1.0 (contact: compliance@govirl.ai)";

// Distillation model. Sonnet (not Opus): the task is extractive, no
// creative judgment needed. Cheap and fast.
const DISTILL_MODEL = "claude-sonnet-4-6";

// Hard fetch ceilings. Anything over these is almost certainly the full
// agency homepage, not the specific guidance page we want — abort rather
// than spend tokens distilling noise.
const FETCH_MAX_BYTES  = 2_000_000;
const FETCH_TIMEOUT_MS = 30_000;

// SOURCES manifest. Each entry maps to one compliance_sources row.
// Confirm URLs resolve at run time — agency sites move pages.
export const SOURCES = [
  // Real estate (US)
  { niche: "real_estate", locale: "US", category: "fair_housing",             agency: "HUD",
    source_url: "https://www.hud.gov/program_offices/fair_housing_equal_opp/fair_housing_act_overview" },
  { niche: "real_estate", locale: "US", category: "advertising_fair_housing", agency: "HUD",
    source_url: "https://www.hud.gov/sites/documents/DOC_7780.PDF" },
  { niche: "real_estate", locale: "US", category: "code_of_ethics_article_12", agency: "NAR",
    source_url: "https://www.nar.realtor/about-nar/governing-documents/code-of-ethics" },
  { niche: "real_estate", locale: "US", category: "endorsement_guides",       agency: "FTC",
    source_url: "https://www.ftc.gov/business-guidance/resources/ftc-endorsement-guides-what-people-are-asking" },

  // Wellness (US)
  { niche: "wellness", locale: "US", category: "structure_function_claims",   agency: "FDA",
    source_url: "https://www.fda.gov/food/food-labeling-nutrition/structurefunction-claims" },
  { niche: "wellness", locale: "US", category: "dietary_supplements",         agency: "FDA",
    source_url: "https://www.fda.gov/food/dietary-supplements/dietary-supplement-products-ingredients" },
  { niche: "wellness", locale: "US", category: "health_products_compliance",  agency: "FTC",
    source_url: "https://www.ftc.gov/business-guidance/resources/health-products-compliance-guidance" },
  { niche: "wellness", locale: "US", category: "endorsement_guides",          agency: "FTC",
    source_url: "https://www.ftc.gov/business-guidance/resources/ftc-endorsement-guides-what-people-are-asking" },
];

const SUPABASE_HEADERS = {
  apikey:         SUPABASE_SERVICE_KEY,
  Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// Cheap boilerplate stripper. Drops <script>/<style>/<nav>/<footer>/<header>
// then strips remaining tags. Keeps the distillation prompt small enough
// that Sonnet doesn't time out / fail JSON.
function htmlToText(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  s = s.replace(/<header[\s\S]*?<\/header>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ")
       .replace(/&amp;/g, "&")
       .replace(/&lt;/g, "<")
       .replace(/&gt;/g, ">")
       .replace(/&quot;/g, "\"")
       .replace(/&#39;/g, "'");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Fetch one source page. Honors Retry-After on 429, caps body size, times
// out the request. Returns { text, pdfBase64, etag, pdf } — text is set
// for HTML responses, pdfBase64 for PDF responses (consumed directly by
// Claude as a document attachment, no Node-side PDF parser required).
async function fetchSource(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers:  { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/pdf" },
      signal:   controller.signal,
      redirect: "follow",
    });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get("Retry-After") || "60", 10);
      console.warn("[compliance-research] 429 from " + url + " — sleeping " + retry + "s before retry");
      await new Promise(r => setTimeout(r, retry * 1000));
      return fetchSource(url);
    }
    if (!res.ok) throw new Error("HTTP " + res.status + " fetching " + url);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const isPdf = ct.includes("application/pdf") || url.toLowerCase().endsWith(".pdf");
    const buf = await res.arrayBuffer();
    if (buf.byteLength > FETCH_MAX_BYTES) {
      throw new Error("Body too large (" + buf.byteLength + " bytes) for " + url);
    }
    if (isPdf) {
      // Claude accepts PDFs as inline base64 document attachments, so we
      // skip Node-side PDF parsing entirely — no pdf-parse / pdfjs-dist
      // dependency, no native binary. The model reads the document
      // directly. Etag is over the raw bytes so a content change to the
      // PDF still triggers re-distillation.
      const bytes = Buffer.from(buf);
      const etag = res.headers.get("etag") || crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
      return { text: null, pdfBase64: bytes.toString("base64"), etag, pdf: true };
    }
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const html = decoder.decode(buf);
    const text = htmlToText(html);
    const etag = res.headers.get("etag") || crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
    return { text, pdfBase64: null, etag, pdf: false };
  } finally {
    clearTimeout(t);
  }
}

async function upsertSource(entry, etag) {
  const url = `${SUPABASE_URL}/rest/v1/compliance_sources?on_conflict=niche,locale,category,source_url`;
  const body = JSON.stringify([{
    niche:           entry.niche,
    locale:          entry.locale,
    category:        entry.category,
    agency:          entry.agency,
    source_url:      entry.source_url,
    last_fetched_at: new Date().toISOString(),
    last_fetch_etag: etag,
  }]);
  const res = await fetch(url, {
    method:  "POST",
    headers: Object.assign({}, SUPABASE_HEADERS, { Prefer: "resolution=merge-duplicates,return=representation" }),
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("upsert source " + res.status + ": " + txt.slice(0, 200));
  }
  const rows = await res.json().catch(() => []);
  return rows[0] || null;
}

async function fetchSourceRow(entry) {
  const params = new URLSearchParams({
    niche:      "eq." + entry.niche,
    locale:     "eq." + entry.locale,
    category:   "eq." + entry.category,
    source_url: "eq." + entry.source_url,
    select:     "*",
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/compliance_sources?${params}`, { headers: SUPABASE_HEADERS });
  if (!res.ok) throw new Error("read source row " + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

async function nextRuleVersion(sourceId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/compliance_rules?source_id=eq.${sourceId}&select=version&order=version.desc&limit=1`,
    { headers: SUPABASE_HEADERS }
  );
  if (!res.ok) throw new Error("read rule version " + res.status);
  const rows = await res.json();
  if (!rows.length) return 1;
  return (rows[0].version || 0) + 1;
}

async function insertDraftRule(sourceId, version, parsed, sourceExcerpt) {
  const body = JSON.stringify([{
    source_id:       sourceId,
    version,
    rule_text:       parsed.rule_text || "",
    denylist:        Array.isArray(parsed.denylist) ? parsed.denylist : [],
    compliance_note: parsed.compliance_note || null,
    source_excerpt:  sourceExcerpt || null,
    status:          "draft",
  }]);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/compliance_rules`, {
    method:  "POST",
    headers: Object.assign({}, SUPABASE_HEADERS, { Prefer: "return=minimal" }),
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("insert rule " + res.status + ": " + txt.slice(0, 200));
  }
}

// Distillation prompt. Inline for v1 per the spec; extract to
// prompts/compliance-distill.txt if it grows or diverges per agency.
// Hard rails matter: agency pages contain plenty of unrelated guidance
// and we only want rules a content-generation model can act on at write
// time.
//
// PDF path: when `pageText` is null, the caller is sending the page as
// a Claude document attachment instead — the prompt swaps the inline
// "PAGE TEXT" block for a sentence pointing the model at the attached
// document, so the schema + hard rails stay identical across formats.
function distillPrompt(entry, pageText) {
  const sourceBlock = pageText
    ? ["PAGE TEXT (boilerplate stripped):", pageText.slice(0, 60000)]
    : ["The page is attached as a PDF document. Read the entire document before distilling."];
  return [
    "You are auditing a canonical " + entry.agency + " page for the VIRL content-generation system. The page covers " + entry.category.replace(/_/g, " ") + " for " + entry.niche.replace(/_/g, " ") + " creators in " + entry.locale + ".",
    "",
    ...sourceBlock,
    "",
    "YOUR TASK:",
    "Distill the page into rules a content-generation model can apply at write time. Return ONLY valid JSON (no markdown, no preamble). Schema:",
    "{",
    '  "rule_text":       "1-3 sentences, written as an instruction to a content-generation model. No legalese, no hedging.",',
    '  "source_excerpt":  "exact quote from the page that backs the rule (<= 300 chars)",',
    '  "denylist":        [ { "pattern": "regex pattern", "flags": "i", "replacement": "string or null" }, ... ],',
    '  "compliance_note": "short note the creator should consider adding to the post, or null"',
    "}",
    "",
    "HARD RAILS:",
    "1. Do not invent rules not supported by the page. If a sentence is not in the page text above, do not write it.",
    "2. If the page is not relevant to social-media compliance (org-chart page, press release, etc.), return: {\"rule_text\":\"\",\"source_excerpt\":\"\",\"denylist\":[],\"compliance_note\":null}",
    "3. Patterns in `denylist` must be anchored on word boundaries (\\\\b) and conservative. False positives are worse than false negatives. Use replacement=null when a rewrite would distort meaning — the model will retry.",
    "4. `flags` should default to \"i\". The runtime appends \"g\" automatically.",
    "5. `compliance_note` is the disclosure text a creator pastes verbatim. Keep it short and unambiguous.",
  ].join("\n");
}

// Single Anthropic call. Accepts either text (HTML path) or a base64-encoded
// PDF (PDF path) — the latter is sent as a `document` content block so
// Claude reads it natively without a Node-side PDF parser. The prompt is
// the same in both cases; only the content array shape differs.
async function callClaudeDistill(prompt, pdfBase64) {
  const content = [];
  if (pdfBase64) {
    content.push({
      type:   "document",
      source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
    });
  }
  content.push({ type: "text", text: prompt });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      DISTILL_MODEL,
      max_tokens: 2000,
      messages:   [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error("Anthropic " + res.status + ": " + errBody.slice(0, 500));
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  return text;
}

function tryParseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (e) { /* ignore */ }
  }
  return null;
}

// Main entry: iterates over SOURCES, distills each, and stages drafts.
// Returns a summary the caller (cron or CLI) can log or email.
export async function runIngestion() {
  const summary = { drafted: 0, unchanged: 0, skipped: [], errored: [] };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
    throw new Error("compliance-research requires SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY");
  }

  for (const entry of SOURCES) {
    const label = entry.niche + " / " + entry.locale + " / " + entry.category;
    try {
      const fetched = await fetchSource(entry.source_url);
      if (!fetched.text && !fetched.pdfBase64) {
        summary.skipped.push({ label, reason: "empty body" });
        continue;
      }

      // Upsert source first so we have an id. PostgREST sometimes elides
      // the response body on conflict — fall back to a GET in that case.
      let sourceRow = await upsertSource(entry, fetched.etag);
      if (!sourceRow) sourceRow = await fetchSourceRow(entry);
      if (!sourceRow) {
        summary.errored.push({ label, reason: "could not read source row after upsert" });
        continue;
      }

      // Cheap change-detection: same etag → page hasn't moved → no point
      // distilling again or cluttering the table with duplicate drafts.
      if (sourceRow.last_fetch_etag && sourceRow.last_fetch_etag === fetched.etag) {
        summary.unchanged += 1;
        continue;
      }

      const prompt = distillPrompt(entry, fetched.text);
      const distilled = tryParseJSON(await callClaudeDistill(prompt, fetched.pdfBase64));
      if (!distilled) {
        summary.errored.push({ label, reason: "distillation JSON parse failed" });
        continue;
      }
      const hasContent = (distilled.rule_text && distilled.rule_text.trim().length > 0)
        || (Array.isArray(distilled.denylist) && distilled.denylist.length > 0);
      if (!hasContent) {
        summary.skipped.push({ label, reason: "empty distillation (page not relevant?)" });
        continue;
      }

      const version = await nextRuleVersion(sourceRow.id);
      await insertDraftRule(sourceRow.id, version, distilled, distilled.source_excerpt);
      summary.drafted += 1;
    } catch (e) {
      summary.errored.push({ label, reason: e.message || String(e) });
    }
  }

  return summary;
}
