// scripts/build.mjs — `npm run build`
//
// [PR C] Ship precompiled JavaScript instead of compiling the app in the
// browser. Authoring is unchanged: index.html stays the one file Lauren
// edits, with the app in a single <script type="text/babel"> block. Before
// this, every page load downloaded Babel Standalone (~3 MB) and compiled
// ~1 MB of JSX on the visitor's phone.
//
// What it writes to dist/ (Vercel's outputDirectory, see vercel.json):
//   app.<hash>.js   the text/babel block, compiled at build time by the SAME
//                   Babel the browser used to run: @babel/standalone 7.23.2
//                   (pinned, matching the CDN tag) with the options its
//                   script-tag loader applies — presets ["react", "env"] plus
//                   its three default plugins. So the shipped code is what
//                   visitors' browsers produced before, just made once: ES5,
//                   strict mode, const/let as var. (Sucrase, which
//                   check-index-syntax.mjs uses as a fast parse check, keeps
//                   real const/let and sloppy mode; a read before declaration
//                   that is silently undefined today would throw.) Content-
//                   hashed, so it can be cached for a year (vercel.json).
//   index.html      the same page with the text/babel block replaced by
//                   <script defer src="/app.<hash>.js"> and the
//                   babel.min.js tag removed. `defer` keeps Babel's timing:
//                   Babel ran text/babel blocks after the document parsed.
//   STATIC_FILES    copied as-is. dist/ is an allowlist: anything not
//                   listed here is no longer served. Before PR C the whole
//                   repo root was public, including the internal briefs.
//
// api/, middleware.js and the crons are untouched: Vercel builds functions
// from the project root whatever the output directory is.
//
// The build fails loudly (non-zero exit, no partial dist/) if the page does
// not have exactly one text/babel block, the compile fails, or the output
// does not parse.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRequire } from "node:module";

const Babel = createRequire(import.meta.url)("@babel/standalone");

// Babel Standalone's buildBabelOptions() for a classic <script type="text/babel">
// (@babel/standalone 7.23.2, src/transformScriptTags.ts). Inline source maps
// are left out: they would roughly double the file.
export const BABEL_OPTIONS = {
  filename: "app.js",
  presets: ["react", "env"],
  plugins: ["transform-class-properties", "transform-object-rest-spread", "transform-flow-strip-types"],
  compact: false,
  retainLines: false,
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist");

// Everything the app serves from its root besides index.html. Add a file
// here when something starts linking to it (emails link the wordmarks;
// og:image and robots.txt are fetched by crawlers).
export const STATIC_FILES = ["robots.txt", "og-image.png", "virl-wordmark.png", "virl-wordmark-navy.png"];

const BABEL_BLOCK_RE = /<script\s+type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/g;
const BABEL_STANDALONE_RE = /[ \t]*<script\s+src=["'][^"']*babel-standalone[^"']*babel(?:\.min)?\.js["']\s*><\/script>[ \t]*\r?\n?/g;

export function buildPage(html) {
  const blocks = [...html.matchAll(BABEL_BLOCK_RE)];
  if (blocks.length !== 1) throw new Error(`expected exactly one <script type="text/babel"> block, found ${blocks.length}`);
  const babelTags = html.match(BABEL_STANDALONE_RE) || [];
  if (babelTags.length !== 1) throw new Error(`expected exactly one babel-standalone <script> tag, found ${babelTags.length}`);

  const source = blocks[0][1];
  const { code } = Babel.transform(source, BABEL_OPTIONS);
  new vm.Script(code, { filename: "app.js" }); // throws on a syntax error

  const hash = createHash("sha256").update(code).digest("hex").slice(0, 12);
  const appFile = `app.${hash}.js`;
  const page = html
    .replace(BABEL_STANDALONE_RE, "")
    .replace(blocks[0][0], `<script defer src="/${appFile}"></script>`);
  if (/text\/babel|babel-standalone/.test(page)) throw new Error("output page still references Babel");
  return { page, appFile, code };
}

function main() {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const { page, appFile, code } = buildPage(html);
  for (const f of STATIC_FILES) if (!existsSync(join(ROOT, f))) throw new Error("missing static file: " + f);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, appFile), code);
  writeFileSync(join(OUT, "index.html"), page);
  for (const f of STATIC_FILES) copyFileSync(join(ROOT, f), join(OUT, f));

  const kb = (n) => (n / 1024).toFixed(0) + " KB";
  console.log(`build: dist/index.html ${kb(Buffer.byteLength(page))} (was ${kb(Buffer.byteLength(html))}), dist/${appFile} ${kb(Buffer.byteLength(code))}, ${STATIC_FILES.length} static files`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
