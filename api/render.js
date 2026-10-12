// [PR2] POST /api/render — the weekly rendered static post as files.
//
// Body: { kind: "images" | "pdf" | "pin", card: {...plan card...}, kicker?, footer? }
//   images → { files: [{ name, mime, base64 }] }   1080×1350 PNG per slide
//   pdf    → { files: [{ name: "...pdf", mime, base64 }] }   LinkedIn document post
//   pin    → { files: [one 1000×1500 PNG] }
//
// Brand colours come from the profile row (profiles.brand), never from the
// request, so a creator's own palette is used without trusting the client
// with it. Everything is downloaded by the user; nothing is published.

import { renderSlides, renderPdf, renderPin, slidesFromCard } from "./_lib/render-post.js";
import { recordEvent, checkRateLimit } from "./_lib/usage.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export const config = { maxDuration: 60 };

function sb() { return { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }; }

async function getUser(req) {
  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch (e) { return null; }
}

function safeName(s) { return String(s || "post").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "post"; }

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: "Server misconfigured." });
  const userId = await getUser(req);
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const rl = await checkRateLimit(userId, "render", 10, 60);
  if (!rl.ok) return res.status(429).json({ error: "Slow down a touch." });

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const kind = ["images", "pdf", "pin"].includes(body.kind) ? body.kind : "images";
  const card = body.card && typeof body.card === "object" ? body.card : {};
  const kicker = typeof body.kicker === "string" ? body.kicker.slice(0, 40) : "";
  const footer = typeof body.footer === "string" ? body.footer.slice(0, 60) : "";

  let brand = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=brand,handles`, { headers: sb() });
    if (r.ok) { const rows = await r.json(); brand = rows[0] && rows[0].brand; }
  } catch (e) {}

  try {
    const slides = slidesFromCard(card);
    const base = safeName(card.title);
    let files = [];
    if (kind === "pin") {
      const png = await renderPin(slides[0], { brand, kicker, footer });
      files = [{ name: base + "-pin.png", mime: "image/png", base64: png.toString("base64") }];
    } else {
      const pngs = await renderSlides(slides, { brand, kicker, footer });
      if (kind === "pdf") {
        const pdf = await renderPdf(pngs);
        files = [{ name: base + ".pdf", mime: "application/pdf", base64: pdf.toString("base64") }];
      } else {
        files = pngs.map((p, i) => ({ name: base + (pngs.length > 1 ? "-" + (i + 1) : "") + ".png", mime: "image/png", base64: p.toString("base64") }));
      }
    }
    await recordEvent(userId, "static_post_rendered", { kind, slides: slides.length, title: card.title || "" });
    return res.status(200).json({ files });
  } catch (e) {
    console.error("[render]", e && e.message);
    return res.status(500).json({ error: "I couldn't render that one." });
  }
}
