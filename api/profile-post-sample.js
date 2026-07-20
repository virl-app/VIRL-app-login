// [POST-SAMPLE] Turns ONE pasted post link into caption text the creator
// can review and keep as a voice sample. Companion to the
// voice_sample_extract generationType in api/chat.js (which handles the
// screenshot-upload half of the same flow via Claude vision) — this half
// handles links, and needs no LLM call at all: it's a direct HTTP fetch
// plus deterministic parsing, so it doesn't fit chat.js's generationType
// dispatch and gets its own small endpoint instead.
//
// Why this can succeed where handle research (a whole-profile crawl)
// fails: an individual post URL is far more likely to carry real Open
// Graph metadata than a profile URL, because platforms deliberately keep
// link-preview metadata working on post pages (that's what renders their
// OWN share cards in iMessage/Slack/etc.) even while blocking bots from
// the full profile. TikTok also exposes a public, unauthenticated oEmbed
// endpoint for individual videos, which we try first there.
//
// Auth: same Bearer-token pattern as /api/profile-research-prewarm.
// Never auto-saves anything — returns the extracted text for the client
// to show the creator, who explicitly taps "Keep" to add it as a voice
// sample. A bad extraction is caught by a human, not trusted blind.

import { fetchRawHtml, extractOgText } from "./_lib/page-fetch.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OEMBED_TIMEOUT_MS    = 5000;
const MAX_CAPTION_CHARS    = 2000;

async function tiktokOembedCaption(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OEMBED_TIMEOUT_MS);
    const res = await fetch("https://www.tiktok.com/oembed?url=" + encodeURIComponent(url), { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return "";
    const j = await res.json();
    return (j && typeof j.title === "string") ? j.title.trim() : "";
  } catch (e) { return ""; }
}

// Tries, in order: TikTok's public oEmbed (reliable, unauthenticated,
// per-video), then a direct fetch of the page's Open Graph metadata
// (best-effort — works on some platforms/pages, not others). Returns
// {caption, source} or null when nothing usable came back.
async function extractFromUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  if (/(^|\.)tiktok\.com$/i.test(u.hostname)) {
    const caption = await tiktokOembedCaption(u.toString());
    if (caption) return { caption: caption.slice(0, MAX_CAPTION_CHARS), source: "tiktok_oembed" };
  }

  const page = await fetchRawHtml(u.toString());
  if (page) {
    const og = extractOgText(page.html);
    const caption = (og.description || og.title || "").trim();
    if (caption.length >= 8) return { caption: caption.slice(0, MAX_CAPTION_CHARS), source: "og_meta" };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in required." });

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!r.ok) return res.status(401).json({ error: "Sign in required." });
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }

  const postUrl = (req.body && typeof req.body.postUrl === "string") ? req.body.postUrl.trim() : "";
  if (!postUrl) return res.status(400).json({ error: "postUrl required." });
  if (postUrl.length > 500) return res.status(400).json({ error: "URL too long." });

  const result = await extractFromUrl(postUrl);
  if (!result) {
    return res.status(200).json({ ok: false, reason: "unreachable" });
  }
  return res.status(200).json({ ok: true, caption: result.caption, source: result.source });
}
