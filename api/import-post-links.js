// [POST-IMPORT] Paste links to your own posts → VIRL pulls the real
// captions and returns them for the voice-samples editor. The direct
// answer to "make my accounts help VIRL sound like me" for creators whose
// profiles aren't in the public search index yet (most early creators):
// oEmbed reads the caption straight from the platform, no indexing, no
// login, no scraping.
//
// Supported via public oEmbed endpoints (no API keys):
//   TikTok    — www.tiktok.com/oembed         (title = the caption)
//   YouTube   — www.youtube.com/oembed        (title)
//   X/Twitter — publish.twitter.com/oembed    (tweet text inside html)
//   Pinterest — www.pinterest.com/oembed.json (title/description, best-effort)
// Instagram / Facebook oEmbed requires a Meta app token + review, so those
// return a per-URL "unsupported" the client turns into "paste that caption
// manually."
//
// SSRF stance: we NEVER fetch a user-supplied URL. The pasted link is
// validated against a per-platform host allowlist and then passed as an
// ENCODED QUERY PARAM to one of four fixed oEmbed hosts above. The only
// outbound connections are to those constants.
//
// Auth: same Bearer pattern as profile-research-prewarm — this endpoint
// returns fetched content, so it's login-gated to avoid becoming an open
// oEmbed proxy. It writes nothing server-side: captions come back to the
// client as editable voice-sample rows and persist through the normal
// profile save (keeps the human in the loop on every imported string).

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const MAX_URLS     = 10;
const MAX_TEXT_LEN = 600;
const FETCH_TIMEOUT_MS = 6000;

// host suffix → platform. Subdomain-tolerant via endsWith on the hostname.
const HOST_PLATFORMS = [
  { suffix: "tiktok.com",    platform: "TikTok" },
  { suffix: "youtube.com",   platform: "YouTube" },
  { suffix: "youtu.be",      platform: "YouTube" },
  { suffix: "x.com",         platform: "X" },
  { suffix: "twitter.com",   platform: "X" },
  { suffix: "pinterest.com", platform: "Pinterest" },
  { suffix: "pin.it",        platform: "Pinterest" },
  { suffix: "instagram.com", platform: "Instagram" },
  { suffix: "facebook.com",  platform: "Facebook" },
];

function platformFor(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  for (const { suffix, platform } of HOST_PLATFORMS) {
    if (host === suffix || host.endsWith("." + suffix)) return { platform, url: u };
  }
  return null;
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

async function fetchOembed(endpoint) {
  const t = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      signal: t.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    t.done();
  }
}

// Minimal entity decode for the handful oEmbed html/titles actually carry.
function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—").replace(/&hellip;/g, "…");
}

// publish.twitter.com returns html like:
// <blockquote ...><p ...>tweet text with <a>links</a></p>&mdash; Author (@h) <a>date</a></blockquote>
function tweetTextFromHtml(html) {
  const m = String(html || "").match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!m) return "";
  const inner = m[1]
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(inner).trim();
}

function clampText(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > MAX_TEXT_LEN ? t.slice(0, MAX_TEXT_LEN - 1) + "…" : t;
}

async function importOne(rawUrl) {
  const hit = platformFor(rawUrl);
  if (!hit) return { url: rawUrl, ok: false, error: "unrecognized_link" };
  const { platform, url } = hit;

  if (platform === "Instagram" || platform === "Facebook") {
    // Meta gates oEmbed behind an app token + review — no keyless path.
    return { url: rawUrl, platform, ok: false, error: "unsupported_platform" };
  }

  let endpoint;
  if (platform === "TikTok") {
    endpoint = "https://www.tiktok.com/oembed?url=" + encodeURIComponent(url.href);
  } else if (platform === "YouTube") {
    endpoint = "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url.href);
  } else if (platform === "X") {
    // publish.twitter.com predates the x.com rename and only resolves
    // twitter.com URLs — swap the host for the query, keep path intact.
    const twUrl = url.href.replace(/^https?:\/\/(www\.)?x\.com\//i, "https://twitter.com/");
    endpoint = "https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=" + encodeURIComponent(twUrl);
  } else if (platform === "Pinterest") {
    endpoint = "https://www.pinterest.com/oembed.json?url=" + encodeURIComponent(url.href);
  }

  const json = await fetchOembed(endpoint);
  if (!json) return { url: rawUrl, platform, ok: false, error: "fetch_failed" };

  let text = "";
  if (platform === "X") text = tweetTextFromHtml(json.html);
  else text = decodeEntities(json.title || json.description || "");

  text = clampText(text);
  if (!text) return { url: rawUrl, platform, ok: false, error: "no_caption" };

  return {
    url: rawUrl,
    platform,
    ok: true,
    text,
    author: typeof json.author_name === "string" ? json.author_name : null,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in required." });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!r.ok) return res.status(401).json({ error: "Sign in required." });
    const u = await r.json();
    if (!u || !u.id) return res.status(401).json({ error: "Sign in required." });
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }

  const urls = Array.isArray(req.body && req.body.urls)
    ? req.body.urls.map(s => String(s || "").trim()).filter(Boolean).slice(0, MAX_URLS)
    : [];
  if (!urls.length) return res.status(400).json({ error: "Send urls: [] with 1-" + MAX_URLS + " post links." });

  // De-dup before fetching; oEmbed hosts don't need duplicate hits.
  const unique = [...new Set(urls)];
  const results = await Promise.all(unique.map(importOne));

  return res.status(200).json({ results });
}
