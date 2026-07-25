// [PAGE-FETCH] Shared direct-fetch-and-extract-text helper. Pulled out of
// listing-research.js so handle-research.js's business-website read uses
// the exact same SSRF guard, timeout, and bot-wall detection instead of a
// second, drifting copy of the same ~20 lines.
//
// Why direct fetch at all: Perplexity's search-grounded models only see a
// page if it's already in their search index. A brand-new domain (or a
// low-traffic one) can be perfectly live and public and still return zero
// search hits, which reads as "unreachable" even though a plain HTTP GET
// from our own server would work fine. Fetching it ourselves and handing
// the model the actual text sidesteps the indexing dependency entirely
// for any URL that ISN'T behind a platform's bot wall (which direct fetch
// can't help with — see handle-research.js's Perplexity fallback for that).

const FETCH_TIMEOUT_MS = 6000;

function validPublicUrl(raw) {
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

// Direct-fetches `rawUrl` and returns its visible text, or null when the
// URL is invalid/unsafe, the fetch fails/times out, or the response reads
// like a bot-wall interstitial (captcha, "access denied") rather than real
// content. `maxChars` caps the returned text (callers own their own token
// budget). Never throws.
export async function fetchPageText(rawUrl, maxChars) {
  const page = await fetchRawHtml(rawUrl);
  if (!page) return null;
  const text = htmlToText(page.html).slice(0, maxChars || 4000);
  // A bot-wall interstitial produces near-empty or captcha text — treat
  // anything too thin (or that reads like a challenge page) as a miss.
  if (text.length > 300 && !/access denied|captcha|are you a human|robot check/i.test(text.slice(0, 600))) {
    return { url: page.url, text };
  }
  return null;
}

// Direct-fetches `rawUrl` and returns its RAW html (no tag-stripping), or
// null on an invalid/unsafe URL, fetch failure, or timeout. Unlike
// fetchPageText this does NOT reject a thin/bot-walled response — a bot
// wall's near-empty page shell can still carry real Open Graph metadata
// in its <head> (platforms deliberately keep that working for their own
// link-preview tooling), which extractOgText below can pull out even
// when the visible-text extraction would call it a miss.
export async function fetchRawHtml(rawUrl) {
  const url = validPublicUrl(rawUrl);
  if (!url) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VIRLBot/1.0; +https://govirl.ai)" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    return { url, html };
  } catch (e) { return null; }
}

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .trim();
}

// Pulls Open Graph / Twitter Card meta tags out of raw HTML. These are
// the fields a platform renders for ITS OWN link-preview cards (Slack,
// iMessage, etc.), so many platforms keep them populated even on pages
// that otherwise block bots or require JS to render the real content —
// a individual post URL is far more likely to carry a real og:description
// than a profile URL, which platforms lock down harder. Attribute order
// in the tag (property/content vs content/property) varies by site, so
// both orders are matched. Never throws; returns {title, description}
// with empty strings when nothing is found.
export function extractOgText(html) {
  const s = String(html || "");
  function metaContent(attrRe) {
    const forward  = s.match(new RegExp("<meta[^>]+" + attrRe + "[^>]+content=[\"']([^\"']*)[\"']", "i"));
    if (forward) return decodeHtmlEntities(forward[1]);
    const backward = s.match(new RegExp("<meta[^>]+content=[\"']([^\"']*)[\"'][^>]+" + attrRe, "i"));
    if (backward) return decodeHtmlEntities(backward[1]);
    return "";
  }
  const description = metaContent("property=[\"']og:description[\"']") || metaContent("name=[\"']twitter:description[\"']");
  const title       = metaContent("property=[\"']og:title[\"']")       || metaContent("name=[\"']twitter:title[\"']");
  return { title, description };
}
