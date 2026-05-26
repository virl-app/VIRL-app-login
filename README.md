# VIRL-app-login
Full VIRL app

## Operations

### Safer-defaults guardrails (internal note)

VIRL applies a small set of conservative phrase-level checks to model
output for users in regulated niches (Real Estate, Wellness) so the
default copy steers clear of well-known phrasing pitfalls. **This is an
internal product-quality feature, not a customer-facing compliance
service.** Do not market it as one.

**What runs in production today**

- **Floor rules.** `api/_lib/compliance.js#FLOOR_RULES` ships a short,
  conservative denylist of clearly-risky patterns (a handful of Fair
  Housing red flags, a short list of disease-claim verbs). These run
  silently on every generation for matching niches and either soften
  obvious mismatches or attach a short "heads up" note to the card.
- **Per-user locale gate.** `profiles.country` (migration 004, default
  `'US'`) gates whether the floor runs. Non-US users skip it cleanly.
- **In-app footer.** A `<ComplianceFooter>` component (in `index.html`)
  renders the model's optional `compliance_note` and any soft-flagged
  phrases under a "Heads up before you post" header on plan cards, the
  script modal, the caption result panel, and scan cards. Renders
  nothing when there's no note and no flag.

**What is *not* running in production**

- The weekly `api/cron/compliance-refresh` schedule has been removed
  from `vercel.json`. The route still exists and can be invoked manually
  via `node scripts/ingest-compliance.mjs`, but the automated refresh
  loop is paused. A scheduled "refresh" implies an SLA we don't intend
  to offer.
- The Supabase-backed `compliance_rules` / `compliance_sources` tables
  (migration 003) still exist; the loader still reads `status='approved'`
  rows if present and merges them on top of the floor. Drafts and the
  review loop are no longer a routine operational responsibility.

**Tests**

```
node scripts/check-compliance.mjs    # floor + scrubber spot-checks
node scripts/check-index-syntax.mjs  # index.html JSX parse
```

**Re-enabling the full pipeline**

If/when this becomes a commercial feature with appropriate legal
review, re-add the cron entry to `vercel.json`:

```
{ "path": "/api/cron/compliance-refresh", "schedule": "0 8 * * 1" }
```

…and adopt a documented review process for moving drafts to
`status='approved'` in Supabase. **Do not re-enable without a
counsel-reviewed marketing position** — the engineering surface is the
easy part; the liability shape is what was paused.
