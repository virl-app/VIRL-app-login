// scripts/check-rating-upsert.mjs
//
// Guards the two ways the thumbs-down reaction loop can break silently —
// both of which have already happened once, and neither of which surfaces
// as anything more informative than "Didn't save — tap again" in the UI.
//
// 1. The upsert must name its conflict target.
//    PostgREST defaults ON CONFLICT to the PRIMARY KEY. content_ratings'
//    primary key is the surrogate `id`, which api/rate.js never sends, so
//    nothing conflicts on it — the insert proceeds and violates the real
//    key, UNIQUE (user_id, generation_type, target_ref), and PostgREST
//    answers 409. The visible symptom is narrow enough to be misread as a
//    schema problem: the FIRST rating on an item inserts fine, and only
//    re-rates and reaction chips on that same item fail.
//
// 2. The chip labels must match the server's closed vocabulary.
//    api/rate.js rejects an unrecognized reason with 400 rather than
//    storing NULL (that silent-NULL write is the original bug this loop was
//    built to fix). So a chip label that drifts from ALLOWED_REASONS turns
//    every tap into a 400 — same dead end, different cause.
//
// Static checks only: no Supabase, no network. Mirrors the other check
// scripts — Node ES module, prints OK / errors, exits 1 on failure.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rateSrc  = readFileSync(join(root, "api/rate.js"), "utf8");
const indexSrc = readFileSync(join(root, "index.html"), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error("FAIL:", msg);
}

// ── 1. Every merge-duplicates upsert in api/rate.js names on_conflict ──────
// The unique constraint, as defined in the database. Order matters only for
// readability; PostgREST matches the column set.
const CONFLICT_COLUMNS = ["user_id", "generation_type", "target_ref"];

const upserts = rateSrc
  .split("\n")
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => line.includes("rest/v1/content_ratings") && line.includes("fetch("));

assert(upserts.length > 0, "found no content_ratings fetch calls in api/rate.js — did the endpoint move?");

for (const { line, n } of upserts) {
  // The DELETE that clears a rating filters by the same columns and has no
  // conflict target to name.
  if (line.includes("user_id=eq.")) continue;
  assert(
    line.includes("on_conflict="),
    `api/rate.js:${n} upserts content_ratings without on_conflict — PostgREST will ` +
    `default to the surrogate primary key and 409 on every re-rate`
  );
  for (const col of CONFLICT_COLUMNS) {
    assert(
      new RegExp(`on_conflict=[^\`"']*${col}`).test(line) || line.includes("RATING_CONFLICT_TARGET"),
      `api/rate.js:${n} on_conflict target is missing "${col}"`
    );
  }
}

// Whichever form the call sites use, the constant has to spell out the real
// constraint.
const targetMatch = rateSrc.match(/RATING_CONFLICT_TARGET\s*=\s*"([^"]+)"/);
if (targetMatch) {
  const cols = targetMatch[1].split(",").map(s => s.trim()).filter(Boolean);
  for (const col of CONFLICT_COLUMNS) {
    assert(cols.includes(col), `RATING_CONFLICT_TARGET is missing "${col}" — got "${targetMatch[1]}"`);
  }
  assert(
    cols.length === CONFLICT_COLUMNS.length,
    `RATING_CONFLICT_TARGET names columns outside the unique constraint — got "${targetMatch[1]}"`
  );
}

// ── 2. Chip labels match the server's closed reason vocabulary ─────────────
const allowedMatch = rateSrc.match(/ALLOWED_REASONS\s*=\s*new Set\(\[([^\]]*)\]\)/);
assert(allowedMatch, "could not find ALLOWED_REASONS in api/rate.js");

const chipMatch = indexSrc.match(/\{\s*\[([^\]]*)\]\.map\(function\(c\)\{ return \(/);
assert(chipMatch, "could not find the reaction chip labels in index.html");

if (allowedMatch && chipMatch) {
  const parse = s => (s.match(/"([^"]*)"/g) || []).map(q => q.slice(1, -1));
  const allowed = parse(allowedMatch[1]).sort();
  const chips   = parse(chipMatch[1]).sort();

  assert(chips.length > 0, "parsed no chip labels out of index.html");
  assert(
    JSON.stringify(allowed) === JSON.stringify(chips),
    `reaction chips in index.html do not match ALLOWED_REASONS in api/rate.js — ` +
    `chips ${JSON.stringify(chips)} vs allowed ${JSON.stringify(allowed)}. ` +
    `Any chip outside the server's set is rejected with 400.`
  );
}

if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("OK: rating upsert names its conflict target; chip vocabulary matches the server.");
