// [LISTING-INTAKE] Turns a pasted URL (property listing, product page,
// event page) into a compact factual context block for plan generation.
//
// Strategy: direct fetch first (brokerage sites, Shopify pages, most of
// the open web), Perplexity fallback second (Zillow/Realtor and anything
// bot-walled), fail-open to null so a bad link never blocks a plan.
// No new tables — plans regenerate weekly; caching adds state for
// pennies of savings.

import { callPerplexity } from "./perplexity.js";

const FETCH_TIMEOUT_MS = 6000;
const MAX_CONTEXT_CHARS = 4000;

function validListingUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (raw.length > 500) return null;
    // Block obvious SSRF targets — this fetch runs server-side.
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || /^(\d+\.){3}\d+$/.test(host) || host.endsWith(".local") || host.endsWith(".internal")) return null;
    return u.toString();
  } catch (e) { return null; }
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchListingContext(rawUrl) {
  const url = validListingUrl(rawUrl);
  if (!url) return null;

  // 1. Direct fetch.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VIRLBot/1.0; +https://govirl.ai)" },
    });
    clearTimeout(timer);
    if (res.ok) {
      const html = await res.text();
      const text = htmlToText(html).slice(0, MAX_CONTEXT_CHARS);
      // A bot-wall interstitial produces near-empty or captcha text —
      // treat anything too thin as a miss and fall through.
      if (text.length > 300 && !/access denied|captcha|are you a human|robot check/i.test(text.slice(0, 600))) {
        return { source: "page", url, text };
      }
    }
  } catch (e) { /* fall through to Perplexity */ }

  // 2. Perplexity fallback (handles Zillow/Realtor bot walls).
  try {
    const answer = await callPerplexity({
      prompt:
        `Summarize the page at ${url} in plain factual bullet points for a social media content plan: ` +
        `what is being offered (property, product, or event), name/address, price if shown, ` +
        `5-8 standout features, and any dates or availability (open house, launch, event time). ` +
        `Facts only, no marketing language, no information about who should buy it.`,
      maxTokens: 700,
    });
    const raw = (answer && typeof answer === "object") ? (answer.text || answer.content || "") : answer;
    const text = String(raw || "").trim().slice(0, MAX_CONTEXT_CHARS);
    if (text.length > 80) return { source: "perplexity", url, text };
  } catch (e) {
    console.warn("[listing] perplexity fallback failed:", e.message);
  }
  return null;
}
