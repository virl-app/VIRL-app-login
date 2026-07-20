// [LISTING-INTAKE] Turns a pasted URL (property listing, product page,
// event page) into a compact factual context block for plan generation.
//
// Strategy: direct fetch first (brokerage sites, Shopify pages, most of
// the open web), Perplexity fallback second (Zillow/Realtor and anything
// bot-walled), fail-open to null so a bad link never blocks a plan.
// No new tables — plans regenerate weekly; caching adds state for
// pennies of savings.

import { callPerplexity } from "./perplexity.js";
import { fetchPageText } from "./page-fetch.js";

const MAX_CONTEXT_CHARS = 4000;

export async function fetchListingContext(rawUrl) {
  let url;
  try {
    const u = new URL(String(rawUrl || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (String(rawUrl).length > 500) return null;
    url = u.toString();
  } catch (e) { return null; }

  // 1. Direct fetch.
  const direct = await fetchPageText(url, MAX_CONTEXT_CHARS);
  if (direct) return { source: "page", url: direct.url, text: direct.text };

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
