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
    const text = htmlToText(html).slice(0, maxChars || 4000);
    // A bot-wall interstitial produces near-empty or captcha text — treat
    // anything too thin (or that reads like a challenge page) as a miss.
    if (text.length > 300 && !/access denied|captcha|are you a human|robot check/i.test(text.slice(0, 600))) {
      return { url, text };
    }
    return null;
  } catch (e) { return null; }
}
