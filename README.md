# VIRL-app-login
Full VIRL app

## Operations

### Compliance rules

VIRL ships niche-specific compliance guardrails for Real Estate (HUD Fair
Housing / NAR / FTC) and Wellness (FDA / FTC) creators. Rules live in
Supabase (`compliance_sources` + `compliance_rules`, migration 003) so the
marketing-page claim is backed by canonical agency sources rather than
text hardcoded in the prompt. The prompt builder reads only
`status='approved'` rows — drafts produced by the ingestion cron stay
invisible to generation until a human reviews them.

**Refresh cadence.** `api/cron/compliance-refresh.js` runs weekly
(`0 8 * * 1` UTC). For each row in the SOURCES manifest in
`api/_lib/compliance-research.js`, it:

1. Fetches the agency page (HTML or PDF — PDFs are sent to Claude as
   native `document` content blocks, no Node-side PDF parser needed).
2. Compares ETag / content hash to the row's `last_fetch_etag`. Unchanged
   pages are skipped.
3. Distills changed pages into a `{ rule_text, denylist, compliance_note }`
   draft via Claude Sonnet (HTML → text, PDF → attached document).
4. Upserts `compliance_sources` and inserts a new `compliance_rules` row at
   `version = max(version) + 1` with `status='draft'`.

Old approved rows are NEVER auto-retired — re-pulls only add drafts.

**Manual run.** Same code path, friendlier output:

```
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... ANTHROPIC_API_KEY=... \
  node scripts/ingest-compliance.mjs
```

**Review loop.** A reviewer opens the Supabase table editor, filters
`compliance_rules` by `status=draft`, and for each draft:

1. Reads `rule_text` — does it accurately summarize the source?
2. Reads `source_excerpt` — does the quote support the rule?
3. Reviews `denylist` regex entries — are they anchored on `\b`? Are
   they conservative enough to avoid false positives (e.g. "treats" in
   "treats from the bakery")?
4. Edits any field as needed.
5. Sets `status='approved'`, fills `reviewed_by` and `reviewed_at`.
6. (Optional) Sets the previous approved version's `status='retired'` if
   the new one supersedes it. The loader otherwise picks the highest
   approved version per source automatically.

The loader caches approved rules in-process for 10 minutes, so an approval
shows up in production within ~10 minutes of the status flip.

**Safe-defaults floor.** Even with an empty database, generation stays
safer than today: `api/_lib/compliance.js#FLOOR_RULES` ships a small,
conservative denylist of clear Fair Housing red flags and FDA disease-claim
verbs. The floor is always the minimum guardrail — DB-approved rules
augment it, never replace it.

**Tests.** `scripts/check-compliance.mjs` exercises the floor + scrubber
against known-bad and known-clean phrases. Run it before approving rules
that touch the floor:

```
node scripts/check-compliance.mjs
```

`scripts/check-index-syntax.mjs` runs the existing index.html JSX parse
check unchanged.

**Scope.**
- Locale gating is per-user from `profiles.country` (migration 004 —
  defaults to `'US'` for existing rows). Only `'US'` actually activates
  the compliance block today; every other value skips it cleanly until
  per-market coverage ships. Captured in the Phase 1 profile flow,
  editable on the Profile tab any time.
- Real Estate + Wellness niches only. Food & Recipes maps to the wellness
  bucket via `nicheCategory()`.
- Scans (`scan_image`, `scan_video_frame`) get the prompt-level block
  only; post-generation scrub stays wired to plan / script / caption
  paths.

**UI surfacing.** The `compliance_note` field the model attaches and
any phrases the post-generation scrub flagged render together as a
"Review before posting" footer on every creator-facing output:

- Plan cards (expanded view, above the day/time reminder bar)
- Script modal (above the save / copy / download row)
- Caption result panel (above the regenerate button)
- Scan result cards (above the share-score card)

Renders nothing when both `compliance_note` and `complianceFlags` are
empty, so clean generations and out-of-scope niches see no visual
change. Implementation: `ComplianceFooter` component in `index.html`.
