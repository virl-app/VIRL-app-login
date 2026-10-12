// scripts/check-rating-upsert.mjs
//
// Guards the ways the thumbs up/down can break silently.
//
// 1. The upsert must name its conflict target.
//    PostgREST defaults ON CONFLICT to the PRIMARY KEY. content_ratings'
//    primary key is the surrogate `id`, which api/rate.js never sends, so
//    nothing conflicts on it — the insert proceeds and violates the real
//    key, UNIQUE (user_id, generation_type, target_ref), and PostgREST
//    answers 409. The visible symptom is narrow enough to be misread as a
//    schema problem: the FIRST rating on an item inserts fine, and only
//    re-rates on that same item fail.
//
// 2. Ratings are vote-only (PR 0): no reason chips, no reason columns
//    written.
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

// ── 2. A rating is a vote only ─────────────────────────────────────────────
// [PR0] The thumbs-down reason chips were removed. Nothing may reintroduce a
// reason vocabulary on the server or chip buttons on the client, and the
// upsert body must not write the (still nullable) reason columns.
assert(!/ALLOWED_REASONS/.test(rateSrc), "api/rate.js reintroduced ALLOWED_REASONS — ratings are vote-only");
assert(!/reason_at/.test(rateSrc), "api/rate.js writes reason_at — ratings are vote-only");
assert(!/\{\s*\[[^\]]*"Too formal"[^\]]*\]\.map\(/.test(indexSrc), "index.html reintroduced the reaction chips");
assert(!/sendChip\(/.test(indexSrc), "index.html still has sendChip");

if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("OK: rating upsert names its conflict target; ratings are vote-only.");
