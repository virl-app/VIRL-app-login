// [PR2] The weekly rendered static post. Server-side, deterministic, in the
// creator's brand colours (VIRL defaults otherwise), VIRL's own two fonts.
// No photos, no stock: a text carousel or a quote card is the one post a
// week that needs nothing from the creator but a tap.
//
//   renderSlides(slides, opts)  → [PNG Buffer]           1080×1350 each
//   renderPdf(pngs)             → PDF Buffer              one page per slide
//   renderPin(slide, opts)      → PNG Buffer              1000×1500
//
// satori lays out a tiny React-like tree to SVG; resvg rasterises it; pdf-lib
// stacks PNGs into the LinkedIn document post. VIRL's two fonts are embedded
// (fonts-data.js); a creator's chosen headline font is fetched on demand
// (a curated Google Fonts family, or their own TTF/OTF upload) and cached per
// process. satori reads TTF, OTF and WOFF; never WOFF2.

import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { PDFDocument } from "pdf-lib";
import { ITALIANA_REGULAR, JOST_REGULAR, JOST_SEMIBOLD } from "./fonts-data.js";

let FONTS = null;
function fonts() {
  if (FONTS) return FONTS;
  FONTS = [
    { name: "Italiana", data: Buffer.from(ITALIANA_REGULAR, "base64"), weight: 400, style: "normal" },
    { name: "Jost",     data: Buffer.from(JOST_REGULAR, "base64"),     weight: 400, style: "normal" },
    { name: "Jost",     data: Buffer.from(JOST_SEMIBOLD, "base64"),    weight: 600, style: "normal" },
  ];
  return FONTS;
}

export const DEFAULT_BRAND = { bg: "#1F3A8A", fg: "#FFFFFF", accent: "#93C5FD" };
const HEX = /^#[0-9a-fA-F]{6}$/;

// The headline fonts a creator can pick without uploading anything. Each is
// fetched from Google Fonts as TTF the first time it's used and kept in
// memory for the life of the function instance. "Italiana" is VIRL's own
// and needs no fetch.
export const FONT_CHOICES = [
  { id: "italiana",   family: "Italiana",           label: "Italiana (VIRL)",   feel: "editorial" },
  { id: "playfair",   family: "Playfair Display",   label: "Playfair Display",  feel: "classic serif" },
  { id: "cormorant",  family: "Cormorant Garamond", label: "Cormorant",         feel: "soft serif" },
  { id: "dmserif",    family: "DM Serif Display",   label: "DM Serif",          feel: "bold serif" },
  { id: "lora",       family: "Lora",               label: "Lora",              feel: "warm serif" },
  { id: "montserrat", family: "Montserrat",         label: "Montserrat",        feel: "clean sans" },
  { id: "poppins",    family: "Poppins",            label: "Poppins",           feel: "round sans" },
  { id: "raleway",    family: "Raleway",            label: "Raleway",           feel: "light sans" },
  { id: "bebas",      family: "Bebas Neue",         label: "Bebas Neue",        feel: "tall caps" },
  { id: "spacegrotesk", family: "Space Grotesk",    label: "Space Grotesk",     feel: "modern sans" },
];

export function resolveBrand(brand) {
  const b = brand && typeof brand === "object" ? brand : {};
  return {
    bg:     HEX.test(b.bg     || "") ? b.bg     : DEFAULT_BRAND.bg,
    fg:     HEX.test(b.fg     || "") ? b.fg     : DEFAULT_BRAND.fg,
    accent: HEX.test(b.accent || "") ? b.accent : DEFAULT_BRAND.accent,
    font:   resolveFontChoice(b.font),
  };
}

// brand.font is { kind: "google", id } or { kind: "upload", path, name }.
// Anything else (or Italiana itself) means VIRL's default headline font.
export function resolveFontChoice(font) {
  if (!font || typeof font !== "object") return null;
  if (font.kind === "google") {
    const c = FONT_CHOICES.find(x => x.id === font.id);
    return c && c.id !== "italiana" ? { kind: "google", id: c.id, family: c.family } : null;
  }
  if (font.kind === "upload" && typeof font.path === "string" && /^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,80}$/.test(font.path)) {
    return { kind: "upload", path: font.path, name: String(font.name || "Your font").slice(0, 60) };
  }
  return null;
}

// Magic bytes satori/opentype.js can parse. WOFF2 is rejected on purpose.
export function fontKind(buf) {
  if (!buf || buf.length < 4) return null;
  const h = buf.subarray(0, 4);
  if (h[0] === 0 && h[1] === 1 && h[2] === 0 && h[3] === 0) return "ttf";
  const s = h.toString("latin1");
  if (s === "OTTO") return "otf";
  if (s === "true") return "ttf";
  if (s === "wOFF") return "woff";
  return null;
}

const FONT_CACHE = new Map();
async function fetchBytes(url, headers) {
  const r = await fetch(url, { headers: headers || {} });
  if (!r.ok) throw new Error("font fetch " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// Google Fonts hands back TTF URLs to a client that doesn't advertise woff2
// support; a plain UA does. Cached by family.
async function loadGoogleFont(family) {
  const key = "g:" + family;
  if (FONT_CACHE.has(key)) return FONT_CACHE.get(key);
  const css = await (await fetch("https://fonts.googleapis.com/css2?family=" + encodeURIComponent(family).replace(/%20/g, "+") + ":wght@400&display=swap", { headers: { "User-Agent": "curl/8" } })).text();
  const m = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/);
  if (!m) throw new Error("no ttf url for " + family);
  const data = await fetchBytes(m[1]);
  if (fontKind(data) !== "ttf" && fontKind(data) !== "otf") throw new Error("unexpected font format for " + family);
  FONT_CACHE.set(key, data);
  return data;
}

// A creator's own upload lives in the private brand-fonts bucket under
// <user id>/<file>. The server reads it with the service key; the client
// only ever writes its own prefix (see migration 031).
async function loadUploadedFont(path, env) {
  const key = "u:" + path;
  if (FONT_CACHE.has(key)) return FONT_CACHE.get(key);
  const data = await fetchBytes(env.SUPABASE_URL + "/storage/v1/object/brand-fonts/" + path.split("/").map(encodeURIComponent).join("/"), { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY });
  if (!fontKind(data)) throw new Error("uploaded file is not a TTF, OTF or WOFF");
  if (data.length > 2 * 1024 * 1024) throw new Error("uploaded font over 2 MB");
  FONT_CACHE.set(key, data);
  return data;
}

// Returns { fonts, headlineFamily } for a resolved brand. Any failure falls
// back to Italiana so a broken font never blocks the post.
export async function fontsForBrand(brand, env) {
  const base = fonts().slice();
  const choice = brand && brand.font;
  if (!choice) return { fonts: base, headlineFamily: "Italiana", fallback: false };
  try {
    const e = env || process.env;
    const data = choice.kind === "google" ? await loadGoogleFont(choice.family) : await loadUploadedFont(choice.path, e);
    const family = choice.kind === "google" ? choice.family : "BrandUpload";
    base.push({ name: family, data, weight: 400, style: "normal" });
    return { fonts: base, headlineFamily: family, fallback: false };
  } catch (e) {
    console.warn("[render] brand font fell back to Italiana:", e && e.message);
    return { fonts: base, headlineFamily: "Italiana", fallback: true };
  }
}

const IMG = { w: 1080, h: 1350 };
const PIN = { w: 1000, h: 1500 };

function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function slideTree({ kicker, headline, body, footer, index, total, quote, attribution }, brand, size, headlineFamily) {
  const hf = headlineFamily || "Italiana";
  const pad = Math.round(size.w * 0.089);
  const headSize = headline && headline.length > 70 ? 68 : headline && headline.length > 40 ? 80 : 92;
  const children = [];
  children.push({ type: "div", props: { style: { display: "flex", justifyContent: "space-between", fontSize: 28, letterSpacing: 6, textTransform: "uppercase", color: brand.accent, fontWeight: 600 },
    children: [ { type: "div", props: { children: clip(kicker || "", 40) } }, { type: "div", props: { children: total > 1 ? index + " / " + total : "" } } ] } });
  const middle = [];
  if (quote) {
    middle.push({ type: "div", props: { style: { fontFamily: hf, fontSize: quote.length > 80 ? 72 : 88, lineHeight: 1.1 }, children: "“" + clip(quote, 160) + "”" } });
    if (attribution) middle.push({ type: "div", props: { style: { fontSize: 34, opacity: 0.85 }, children: "— " + clip(attribution, 60) } });
  } else {
    if (headline) middle.push({ type: "div", props: { style: { fontFamily: hf, fontSize: headSize, lineHeight: 1.05 }, children: clip(headline, 120) } });
    if (body)     middle.push({ type: "div", props: { style: { fontSize: 40, lineHeight: 1.5, opacity: 0.92 }, children: clip(body, 420) } });
  }
  children.push({ type: "div", props: { style: { display: "flex", flexDirection: "column", gap: 40 }, children: middle } });
  children.push({ type: "div", props: { style: { fontSize: 30, opacity: 0.8 }, children: clip(footer || "", 60) } });
  return { type: "div", props: { style: { width: size.w, height: size.h, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: pad, background: brand.bg, color: brand.fg, fontFamily: "Jost" }, children } };
}

async function toPng(tree, size, fontList) {
  const svg = await satori(tree, { width: size.w, height: size.h, fonts: fontList || fonts() });
  return new Resvg(svg, { fitTo: { mode: "width", value: size.w } }).render().asPng();
}

// slides: [{ headline, body }] (3-5) or a single [{ quote, attribution }]
export async function renderSlides(slides, opts) {
  const o = opts || {};
  const brand = resolveBrand(o.brand);
  const list = (Array.isArray(slides) ? slides : []).slice(0, 5);
  const f = await fontsForBrand(brand, o.env);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    out.push(await toPng(slideTree(Object.assign({}, list[i], { kicker: o.kicker, footer: o.footer, index: i + 1, total: list.length }), brand, IMG, f.headlineFamily), IMG, f.fonts));
  }
  return out;
}

export async function renderPin(slide, opts) {
  const o = opts || {};
  const brand = resolveBrand(o.brand);
  const f = await fontsForBrand(brand, o.env);
  return toPng(slideTree(Object.assign({}, slide, { kicker: o.kicker, footer: o.footer, index: 1, total: 1 }), brand, PIN, f.headlineFamily), PIN, f.fonts);
}

export async function renderPdf(pngs) {
  const pdf = await PDFDocument.create();
  for (const png of pngs) {
    const img = await pdf.embedPng(png);
    const page = pdf.addPage([IMG.w, IMG.h]);
    page.drawImage(img, { x: 0, y: 0, width: IMG.w, height: IMG.h });
  }
  return Buffer.from(await pdf.save());
}

// A plan card → the slides to render. Carousel cards carry slides; quote
// cards carry a quote; anything else becomes a single headline card from
// the hook or title.
export function slidesFromCard(card) {
  const c = card || {};
  if (Array.isArray(c.slides) && c.slides.length) {
    return c.slides.slice(0, 5).map(s => ({ headline: s.headline || "", body: s.body || "" }));
  }
  if (c.quote) return [{ quote: c.quote, attribution: c.attribution || "" }];
  return [{ headline: c.hook || c.title || "", body: c.description || "" }];
}
