// [LINK PREVIEW] Regenerates /og-image.png — the 1200x630 card that X,
// LinkedIn, Facebook, iMessage, and Slack show when someone pastes a
// govirl.ai link. The image is committed to the repo (Vercel serves it as a
// static file); this script exists so the card can be re-rendered when the
// headline, offer, or brand palette changes, instead of being a mystery PNG
// nobody can edit.
//
//   npm run og:image        # writes og-image.png at the repo root
//
// Playwright is NOT a repo dependency — the card changes a couple of times a
// year and the browser download is ~150MB, which isn't worth adding to every
// `npm install`. Install it just when you need to re-render:
//
//   npm i --no-save playwright && npx playwright install chromium
//
// After regenerating, bump the ?v= query string on the og:image /
// twitter:image tags in index.html and re-scrape the URL in each platform's
// debugger — X, Facebook, and LinkedIn all cache aggressively.
//
// Brand: Editorial mode. Navy #253985 ground, one periwinkle #9DC3F8 italic
// accent, Italiana headline, light sans body. One idea, lots of whitespace.
//
// Fonts are downloaded and inlined as file:// @font-face rather than linked
// from fonts.googleapis.com: headless Chromium doesn't inherit the shell's
// HTTPS proxy in every environment, and when the webfont fetch silently fails
// the card renders in a fallback serif that looks nothing like the brand.

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'playwright not installed. Run:\n' +
      '  npm i --no-save playwright && npx playwright install chromium',
  );
  process.exit(1);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO_ROOT, 'og-image.png');

// A desktop Chrome UA is required — Google Fonts serves woff2 only to
// browsers it recognizes, and hands older formats to anything else.
const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Google Fonts URLs are version-stamped (…/italiana/v21/…) and change over
// time, so resolve them through the CSS API instead of hardcoding the files.
const FONTS = [
  { file: 'italiana.woff2', family: 'Italiana' },
  { file: 'jost.woff2', family: 'Jost:wght@300;600' },
  { file: 'playfair-italic.woff2', family: 'Playfair+Display:ital@1' },
];

async function downloadFonts(dir) {
  for (const font of FONTS) {
    const cssRes = await fetch(
      `https://fonts.googleapis.com/css2?family=${font.family}&display=swap`,
      { headers: { 'User-Agent': CHROME_UA } },
    );
    if (!cssRes.ok) throw new Error(`font CSS ${font.family}: HTTP ${cssRes.status}`);
    const css = await cssRes.text();
    // First src URL is the latin subset, which is all this card needs.
    const url = css.match(/https:\/\/fonts\.gstatic\.com[^)]+\.woff2/)?.[0];
    if (!url) throw new Error(`no woff2 URL in CSS for ${font.family}`);
    const fontRes = await fetch(url);
    if (!fontRes.ok) throw new Error(`font file ${font.family}: HTTP ${fontRes.status}`);
    await writeFile(join(dir, font.file), Buffer.from(await fontRes.arrayBuffer()));
  }
}

const CARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<style>
  @font-face{font-family:'Italiana';src:url('italiana.woff2') format('woff2');font-weight:400;font-style:normal}
  @font-face{font-family:'Jost';src:url('jost.woff2') format('woff2');font-weight:100 900;font-style:normal}
  @font-face{font-family:'PlayfairItalic';src:url('playfair-italic.woff2') format('woff2');font-weight:400 900;font-style:italic}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1200px;height:630px}
  body{
    background:linear-gradient(135deg,#253985 0%,#2A4292 100%);
    font-family:'Jost',sans-serif;
    color:#fff;
    display:flex;
    flex-direction:column;
    justify-content:space-between;
    padding:72px 90px 66px;
  }
  .wordmark{font-family:'Italiana',serif;font-size:40px;letter-spacing:.34em;text-indent:.34em}
  h1{font-family:'Italiana',serif;font-weight:400;font-size:96px;line-height:1.08;max-width:1000px}
  h1 em{font-family:'PlayfairItalic',serif;font-style:italic;font-size:92px;color:#9DC3F8}
  .sub{
    margin-top:28px;font-weight:300;font-size:29px;line-height:1.5;
    letter-spacing:.005em;color:#A7AFCD;max-width:790px;
  }
  footer{display:flex;align-items:center;justify-content:space-between}
  .domain{font-size:21px;letter-spacing:.24em;text-transform:uppercase;color:#A7AFCD}
  .pill{
    background:#fff;color:#253985;font-size:18px;font-weight:600;letter-spacing:.16em;
    text-transform:uppercase;padding:17px 40px;border-radius:999px;
  }
</style>
</head>
<body>
  <div class="wordmark">VIRL</div>
  <div>
    <h1>Finally, a strategy that <em>sounds like you.</em></h1>
    <p class="sub">The first AI content strategist — a full week of content in your actual voice, in about 60 seconds.</p>
  </div>
  <footer>
    <span class="domain">govirl.ai</span>
    <span class="pill">14-day free trial</span>
  </footer>
</body>
</html>`;

const workDir = await mkdtemp(join(tmpdir(), 'virl-og-'));
try {
  await downloadFonts(workDir);
  await writeFile(join(workDir, 'card.html'), CARD_HTML);

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(join(workDir, 'card.html')).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);

  // Fail loudly rather than shipping a card set in fallback serif.
  const unloaded = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status !== 'loaded').map((f) => f.family),
  );
  if (unloaded.length) throw new Error(`fonts failed to load: ${unloaded.join(', ')}`);

  await page.screenshot({ path: OUT });
  await browser.close();
  console.log(`OK: wrote ${OUT} (1200x630)`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
