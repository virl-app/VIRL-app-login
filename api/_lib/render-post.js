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
// stacks PNGs into the LinkedIn document post. Fonts are read once per
// process from api/_fonts.

import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { PDFDocument } from "pdf-lib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "_fonts");
let FONTS = null;
function fonts() {
  if (FONTS) return FONTS;
  FONTS = [
    { name: "Italiana", data: fs.readFileSync(path.join(FONT_DIR, "Italiana-Regular.ttf")), weight: 400, style: "normal" },
    { name: "Jost",     data: fs.readFileSync(path.join(FONT_DIR, "Jost-Regular.ttf")),     weight: 400, style: "normal" },
    { name: "Jost",     data: fs.readFileSync(path.join(FONT_DIR, "Jost-SemiBold.ttf")),    weight: 600, style: "normal" },
  ];
  return FONTS;
}

export const DEFAULT_BRAND = { bg: "#1F3A8A", fg: "#FFFFFF", accent: "#93C5FD" };
const HEX = /^#[0-9a-fA-F]{6}$/;
export function resolveBrand(brand) {
  const b = brand && typeof brand === "object" ? brand : {};
  return {
    bg:     HEX.test(b.bg     || "") ? b.bg     : DEFAULT_BRAND.bg,
    fg:     HEX.test(b.fg     || "") ? b.fg     : DEFAULT_BRAND.fg,
    accent: HEX.test(b.accent || "") ? b.accent : DEFAULT_BRAND.accent,
  };
}

const IMG = { w: 1080, h: 1350 };
const PIN = { w: 1000, h: 1500 };

function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function slideTree({ kicker, headline, body, footer, index, total, quote, attribution }, brand, size) {
  const pad = Math.round(size.w * 0.089);
  const headSize = headline && headline.length > 70 ? 68 : headline && headline.length > 40 ? 80 : 92;
  const children = [];
  children.push({ type: "div", props: { style: { display: "flex", justifyContent: "space-between", fontSize: 28, letterSpacing: 6, textTransform: "uppercase", color: brand.accent, fontWeight: 600 },
    children: [ { type: "div", props: { children: clip(kicker || "", 40) } }, { type: "div", props: { children: total > 1 ? index + " / " + total : "" } } ] } });
  const middle = [];
  if (quote) {
    middle.push({ type: "div", props: { style: { fontFamily: "Italiana", fontSize: quote.length > 80 ? 72 : 88, lineHeight: 1.1 }, children: "“" + clip(quote, 160) + "”" } });
    if (attribution) middle.push({ type: "div", props: { style: { fontSize: 34, opacity: 0.85 }, children: "— " + clip(attribution, 60) } });
  } else {
    if (headline) middle.push({ type: "div", props: { style: { fontFamily: "Italiana", fontSize: headSize, lineHeight: 1.05 }, children: clip(headline, 120) } });
    if (body)     middle.push({ type: "div", props: { style: { fontSize: 40, lineHeight: 1.5, opacity: 0.92 }, children: clip(body, 420) } });
  }
  children.push({ type: "div", props: { style: { display: "flex", flexDirection: "column", gap: 40 }, children: middle } });
  children.push({ type: "div", props: { style: { fontSize: 30, opacity: 0.8 }, children: clip(footer || "", 60) } });
  return { type: "div", props: { style: { width: size.w, height: size.h, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: pad, background: brand.bg, color: brand.fg, fontFamily: "Jost" }, children } };
}

async function toPng(tree, size) {
  const svg = await satori(tree, { width: size.w, height: size.h, fonts: fonts() });
  return new Resvg(svg, { fitTo: { mode: "width", value: size.w } }).render().asPng();
}

// slides: [{ headline, body }] (3-5) or a single [{ quote, attribution }]
export async function renderSlides(slides, opts) {
  const o = opts || {};
  const brand = resolveBrand(o.brand);
  const list = (Array.isArray(slides) ? slides : []).slice(0, 5);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    out.push(await toPng(slideTree(Object.assign({}, list[i], { kicker: o.kicker, footer: o.footer, index: i + 1, total: list.length }), brand, IMG), IMG));
  }
  return out;
}

export async function renderPin(slide, opts) {
  const o = opts || {};
  const brand = resolveBrand(o.brand);
  return toPng(slideTree(Object.assign({}, slide, { kicker: o.kicker, footer: o.footer, index: 1, total: 1 }), brand, PIN), PIN);
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
