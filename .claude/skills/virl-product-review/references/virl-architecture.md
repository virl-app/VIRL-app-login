# VIRL architecture map — for the product-review skill

A map, not a source of truth. Verify against the code; line numbers drift.

## Contents

- Shape of the app
- Generation surfaces
- The strategist signal stack
- The voice signal stack
- Enforcement points
- Known precedence rules
- Where breaks have historically hidden

## Shape of the app

- `index.html` — the entire frontend. Single-file React via Babel standalone,
  ~885KB. Components are `function` declarations. No optional chaining in JSX,
  no template literals in JSX, no em-dashes in raw JSX text.
- `api/` — Vercel serverless functions. `api/chat.js` is the generation
  orchestrator; `api/_lib/prompts.js` builds every prompt.
- `api/_lib/` — the signal modules. Each one owns one input to the prompt.
- `migrations/` — Supabase schema.
- Checks: `npm run check` (index parse, compliance, voice, strategist).
  `check-voice.mjs` guards the voice half; `check-strategist.mjs` guards the
  strategist half (trend grounding, niche layer, live playbook values,
  staleness bounds) across every prose surface.

## Generation surfaces

Dispatch table is `BUILDERS` in `api/_lib/prompts.js`. Each builder returns
`{ systemPrompt, userPrompt, model, maxTokens, cost }`.

| Surface | Builder | Notes |
|---|---|---|
| `plan` | `buildPlan` | Flagship. Streams. Highest credit cost. |
| `plan_partial` | `buildPlanPartial` | Regenerates N cards. Reuses plan's *system* prompt only. |
| `script` | `buildScript` | |
| `long_post` | `buildLongPost` | |
| `blog_post` | `buildBlogPost` | |
| `caption` | `buildCaption` | |
| `caption_remix` | `buildCaptionRemix` | |
| `scan_image` | `buildScanImage` | Vision. Emits caption + hashtags. |
| `scan_video_frame` | `buildScanVideoFrame` | Vision. |
| `log_metrics` | `buildLogMetrics` | Extraction, not generation. No voice needed. |
| `voice_sample_extract` | `buildVoiceSampleExtract` | Extraction. No voice needed. |

`plan_strategy` was removed deliberately (see the note above `buildScript`);
`check-voice.mjs` asserts it stays gone.

The critical structural fact: **the system prompt is shared and cacheable; the
user prompt is per-request.** Signals that live in the *user* prompt are NOT
inherited by a builder that reuses another's system prompt. This is the single
most common source of false "yes" cells in a coverage matrix.

Two rules that used to live in a user prompt were moved to the shared tier
precisely because of it, and both are now inherited by every surface built
through `composeSystemPrompt` (plus `buildPlan`, which composes its own pair):
`TREND_SOURCE_RULE`, and `formatNicheModelForPrompt`'s per-niche success model.
The pattern is worth copying: split a signal's per-niche/per-surface half (→
shared) from its per-request half (→ user), rather than choosing one tier for
all of it. What still rides the user prompt: the trend BLOCK itself, the
platform playbook, the full niche playbook with goal tactics and follower tier,
and everything week-specific.

## The strategist signal stack

- `_lib/playbook.js` — per-platform mechanics from the `playbook` table:
  `cadence`, `peak_times`, `duration`, `hook_window`, `hashtag_count`,
  `hashtag_mix`, `caption_limit`, `top_signals`, `format_priority`, `notes`.
  Refreshed monthly by `cron/playbook-refresh.js` → staged in `playbook_drafts`
  with per-field diffs, source URLs, and reasoning → admin approves.
- Renderers in `prompts.js`, and they expose different subsets — this is where
  coverage differs by surface:
  - `platformPlaybookBlock` — the full entry. Only reached via
    `planPlaybookContext`.
  - `scriptPlaybookContext` — duration, hook window, signals, formats.
  - `captionPlaybookContext` — caption limit, hashtag count, signals.
  - `scanPlaybookContext` — every platform: signals, formats, hashtag count,
    caption limit, peak times.
  - `hashtagSlots` — derives the schema's hashtag array length (caption,
    long_post).
  - `playbookAuthorityFraming` / `playbookStaleNote` — how a block introduces
    itself, derived from `playbookAge(entry.updated_at)`. Past
    `PLAYBOOK_STALE_DAYS` (90) the authority claim is withdrawn. `blog_post`
    takes no playbook at all, by recorded decision.
- `_lib/trend-context.js` — DB-backed trends (`trend_items`), freshness floor 7
  days, niche-fit floor 0.6, max 5 items, TikTok as cross-platform fallback.
  Fails open to an empty block. **This describes the OBSERVED path only.** A
  second path — the weekly `trends` research — feeds generation whenever the
  observed pipeline returns nothing, which is the state the system is in
  whenever the ingest has no vendor token. It has different filters, a
  different freshness window (14 days), no lifecycle status, and a
  *conditional* cross-platform fallback rather than the unconditional one
  above. Treating the two as interchangeable is a live source of error; see the
  `virl-trend-dataflow` skill before reasoning about how trend data reaches a
  prompt. One renderer, `trendsContext` in prompts.js,
  serves every surface and never returns "" — the empty state is named, not
  silent. `FRESH_TRENDS_TYPE` + `pickInlinePlatforms` in chat.js decide which
  surfaces COLLECT; `caption_remix` is the one deliberate exclusion.
- `_lib/niche-playbook.js` — two renderers.
  `formatNicheModelForPrompt` is per-niche only (success model, funnel intent,
  KPIs) and rides the shared tier on every non-plan surface.
  `formatNichePlaybookForPrompt` adds the per-request layer (follower-tier
  baseline, per-goal tactics) and stays on plan / plan_partial, the only
  surfaces whose params carry a goal and a follower count.
- `_lib/optimal-days.js` — best posting weekday from the creator's own results.
- `_lib/holidays.js`, `_lib/listing-research.js` — opt-in observances, fetched
  link context.
- Cadence caveat: total card count comes from `computeCardRange` using
  `profile.postFreq × platform count`. The playbook's `cadence` only influences
  distribution across platforms. Creator capacity overrides platform ideal by
  design — confirm that's still the intended call.

## The voice signal stack

`buildVoiceBlocks` in `prompts.js` is the single source of truth, assembling in
priority order:

1. `buildVoiceSamplesBlock` — the creator's own writing: `sampleCaption`,
   `voiceSamples`, `handlePostExcerpts`.
2. `buildVaultExemplarsBlock` — saved/shipped posts (`_lib/vault-exemplars.js`).
   Voice references, explicitly not content to reuse.
3. `formatPerformanceForPrompt` — what has worked (`_lib/performance-insights.js`),
   gated behind the `learn_from_results` opt-in.
4. `buildVoiceFingerprintBlock` — stylometry (`_lib/voice-drift.js`). Derived
   only from creator-authored text so the client can mirror the computation in
   the Profile panel.
5. `formatDenylistForPrompt` — mined personal denylist.

Plus, separately:
- `buildCriticalFactsBlock` — personal facts, never-assume, love-to-reference.
  Placed first in the per-user block; relevance-gated, not a checklist.
- `formatVoiceLearning` — edit diffs (`_lib/edit-examples.js`) + reaction chips
  (`_lib/voice-reactions.js`). Surfaces listed in `VOICE_LEARNING_TYPES`.
- `STYLE_GUARD` — anti-AI-tell rules. `VOICE_ANCHOR` — final recency-slot line.
- `virl-persona.js` — VIRL's own register, the rationale rules, and the register
  split naming which output fields are creator-voice vs VIRL-voice.

Windows worth knowing: edit diffs cap at 8 from the last 12 events; reactions
expire at 60 days across a 3-chip vocabulary; the fingerprint never updates from
observed output. Voice learning is a rolling window, not an accumulating asset.

## Enforcement points

- `computeVoiceDrift` (`_lib/voice-drift.js`) scores generated prose against the
  creator's reference corpus.
- `api/chat.js` applies a corrective retry above `DRIFT_RETRY_THRESHOLD` — on the
  **non-streaming** path only. `handleStreamingPlan` computes drift, writes it to
  the usage row, logs telemetry, and takes no action.
- A post-stream event channel exists and is already used for the compliance
  scrub — the mechanism for post-stream voice repair is present.
- `_lib/compliance.js` — conservative phrase floor for Real Estate / Wellness,
  US locale only. Internal quality feature, never marketed.
- `scripts/persona-eval.mjs`, `scripts/voice-eval-nightly.mjs`,
  `scripts/check-voice.mjs` — offline eval harnesses.

## Known precedence rules

Inverting any of these is promise-critical:

- Creator's stated facts > machine-gathered research (`handleResearch` is
  labelled observational, not authoritative).
- `researchCorrections` > everything machine-gathered.
- Edit diffs (evidence of what they wrote) > reaction chips (a verdict on what
  they didn't want).
- Creator's logged results > follower-tier baselines.
- Trend data wins on *what* is trending; the playbook wins on *format and specs*.
- Only the retrieved trend block may ground a trend claim — training data may
  not, in any field.

## Where breaks have historically hidden

- A builder reusing another's **system** prompt and silently losing everything
  that lived in the **user** prompt.
- A signal threaded into a builder and discarded (derived from, then dropped).
- A prompt instructing the model to obey data that isn't in that prompt.
- A signal measured and recorded but never acted on.
- Static in-prompt tables duplicating live playbook values, so the surface uses
  the stale copy.
- A signal with no freshness bound, framed as authoritative forever.
- An alert whose only trigger is the success path, so failure is silent.
- Missing data interpreted as negative data ("never logged" read as "didn't
  work").
- Consent gates nulling a signal upstream, so a surface that looks wired is dark
  for most users.
