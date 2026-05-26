# VIRL-app-login
Full VIRL app

## Operations

### Safer-defaults floor for regulated niches (internal note)

VIRL applies a small set of conservative phrase-level checks to model
output for users in the Real Estate and Wellness niches so the default
copy steers clear of well-known phrasing pitfalls (Fair Housing red
flags, disease-claim verbs). **This is an internal product-quality
feature, not a customer-facing compliance service.** Do not market it
as one — the public surface is intentionally silent.

**What runs in production**

- `api/_lib/compliance.js#FLOOR_RULES` — a short, conservative denylist
  + per-niche prompt block, hardcoded in the module.
- The loader reads from a Supabase `compliance_rules` table if present
  (none ships today). When the table is missing or returns no
  `status='approved'` rows, the loader falls through to `FLOOR_RULES`.
  That is the steady state.
- The block is gated to `locale === 'US'` and the Real Estate or
  Wellness niches via `nicheCategory()`. Every other user / niche skips
  the module entirely.

**What is intentionally absent**

- No weekly ingestion cron. The previously-shipped
  `compliance-refresh` cron and its supporting pipeline
  (`compliance-research.js`, `ingest-compliance.mjs`, migration 003)
  were removed because a scheduled "compliance refresh" implies a
  vendor SLA the product is not positioned to offer.
- No customer-facing UI labelled "compliance" or "guardrails." If a
  card-level "heads up" footer is ever shipped, the wording should
  describe behavior ("worth a second look") rather than claim
  compliance.

**Tests**

```
node scripts/check-compliance.mjs    # floor + scrubber spot-checks
node scripts/check-index-syntax.mjs  # index.html JSX parse
```

**Re-enabling the full ingestion pipeline**

The pipeline files were deleted, not feature-flagged — re-enabling
means restoring them from git history (`git show 42c3530`) and
re-creating the Supabase tables (`migrations/003-…`). Do not do this
without a counsel-reviewed marketing position; the engineering work
is the easy part, and the liability shape is what was paused.
