# VIRL — Step-by-step execution guide

Companion to `AUDIT.md`. That document says what's wrong; this one says what to do, in order, starting now.

**Sequencing principle:** three of the five build briefs in `AUDIT.md` §9 are M-to-L effort, and which one is correct depends on a question you can answer in an afternoon. Diagnose first. Then ship the two things that are right regardless. Then branch.

---

## Step 0 — Diagnose (today, ~2 hours)

Nothing here is a build. It changes what you build.

### 0.1 Run the queries (20 min)

Open the Supabase SQL editor and run `scripts/audit-queries.sql` section by section. Write the answers down somewhere you'll see them — these are your baseline.

**The one that matters most is Q1: average `drift_score_after` by week.** Interpretation:

| avg drift | Read | What it means for sequencing |
|---|---|---|
| **< 35** | Voice fidelity is working | The moat is real. Go to Track A. |
| **35–50** | Mixed | Ship the cheap voice wins (Step 2), then re-measure before Track A. |
| **> 50** | The differentiator is not yet real | Go to Track B. Nothing else matters. |
| **too few rows** | Not measurable | See 0.2 — this is itself the finding. |

Q1c is the trap to watch for: drift is only computed when the user **has a voice reference** (`sample_caption`, `voice_samples`, or research excerpts). Production snapshot at audit time: **10 of 29 users had a `sample_caption`**. If most users have no reference, most generations are unmeasured *and* unanchored — the model is writing from adjectives, not from their actual writing. That single number may explain more about output quality than anything else in `AUDIT.md`.

### 0.2 Read ten generated plans (60 min)

No telemetry substitutes for this, and you are the only person who can do it.

Pull ten recent plans. For each, read the `caption` and `hook` fields — the copy a creator would actually publish — and score them one of three ways:

- **Would post as-is**
- **Would post after a small edit**
- **Would not post**

Then do it once for yourself: fill your own profile properly, generate a plan, and ask *does this sound like me?*

If "would post as-is + small edit" is under ~60%, treat that as authoritative and go to **Track B**, regardless of what the drift score said. Drift is a stylometric proxy; your judgment is the actual bar.

### 0.3 Write down the baseline (10 min)

```
Date: ______
Signups / saved profile / generated a plan:  __ / __ / __
Users with any voice reference:              __ / __
Avg drift (plan):                            ____
Would-post rate from the 10-plan read:       ____%
post_marked events / users:                  __ / __
Second-plan users:                           __
```

You will re-run this after Step 2 and after each track. Without it you cannot tell whether any of the work helped.

---

## Step 1 — Instrument the publish signal (half a day)

**Do this before anything else, because it takes hours and every later decision reads from it.**

`AUDIT.md` §12.3 originally proposed measuring publishing via `user_data.results`. **That was wrong.** Results logging is a manual multi-step flow (`SundayLogModal`, `index.html:8931` — remember to return, open the modal, then per card either screenshot the platform's insights panel or type three numbers, verify, save, ×7 cards). A low number there measures friction, not behaviour. Corrected in `scripts/audit-queries.sql` Q2c.

What to do instead:

### 1.1 Instrument `CopyBtn` (1 line + a prop)

`index.html:3064-3078`. `doCopy()` currently fires no event. Copying a caption is the single highest-intent action in the product — it is the moment immediately before posting — and it is invisible today.

```js
function CopyBtn({text, label, surface, platform}) {
  label = label || "Copy";
  const [copied, setCopied] = useState(false);
  function doCopy() {
    navigator.clipboard && navigator.clipboard.writeText(text).then(function() {
      setCopied(true); setTimeout(function(){ setCopied(false); }, 1800);
      try {
        logEvent(window.__virlUserId || null, "content_copied", {
          surface:  surface  || "unknown",   // plan_card | caption | script | scan | post
          platform: platform || null,
          length:   (text || "").length,
        });
      } catch (e) {}
    });
  }
  // ...unchanged render
}
```

Then pass `surface` at each call site. Grep for `<CopyBtn` and fill them in — mechanical, ~15 minutes.

### 1.2 Make "mark as posted" impossible to miss

`post_marked` already exists and is already instrumented (`index.html:4577`) — a one-tap toggle. It is the right signal and it's under-used because it's a small affordance competing with everything else on the card.

Two cheap changes:
- Raise it visually on the card — a real button, not a subtle checkmark.
- When a user copies a caption (1.1), show an inline "Posted it?" one-tap confirm ~30 seconds later. Copy → post is the natural sequence; asking at the moment of intent costs nothing.

**Do not** expand results logging to chase this. Numbers are a nice-to-have; *did you post it* is the retention question, and it should cost one tap forever.

### 1.3 Acceptance

Within a week you can answer: **of the cards VIRL generated, what fraction did a human copy, and what fraction did they mark as posted?** That ratio is your product-market-fit dial from here on.

---

## Step 2 — The two builds that are right regardless (1 week)

Neither depends on Step 0's answer. Do both.

### 2.1 Close the reaction loop (`AUDIT.md` F2 / Brief 2 — S–M)

Your UI says *"Noted — I'll learn from this"* (`index.html:1570`) and nothing does. The chips POST to a support table and are never read back. This is a false statement to the user about the exact thing you're selling.

**Order of work:**

1. **Migration** `migrations/024-voice-signals.sql`:
   ```sql
   alter table profiles
     add column voice_signals jsonb not null default '[]'::jsonb;
   ```
   Element shape: `{ kind, value, gen_type, target_ref, weight, created_at }`.

2. **Endpoint** `api/voice-signal.js`. Copy the auth + rate-limit preamble from `api/feedback.js` verbatim (bearer verify → `check_and_record_rate_limits` RPC → service-role write). Append one element; trim to the newest 50 server-side.

3. **Repoint the chips.** `index.html:1558-1570`, `sendChip()` → `/api/voice-signal` with `kind: "reaction"`. While you're there, fix the bug: it posts `sentiment: "negative"`, which isn't in `ALLOWED_SENTIMENTS` (`api/feedback.js:14`), so every chip has been stored with `sentiment: null`.

4. **Also write from 👎** in `api/rate.js`, and from `captureEditDiff` (`index.html:11365`) with `kind: "edit"`, so reactions and edits share one store.

5. **Render it.** New `buildVoiceSignalsBlock(profile)` in `api/_lib/prompts.js`, called from `buildVoiceBlocks()` (`prompts.js:104`) so **every** voice surface gets it. Render as directives, not counts:
   > *"This creator has flagged output as too formal 4 times in the last month. Loosen the register: more contractions, shorter sentences, fewer subordinate clauses."*

   Weight recent signals higher; decay past 90 days.

6. **Acceptance:** tap "Too formal" three times, generate, and confirm the instruction appears in the system prompt. Existing edit-diff behaviour unchanged (`node scripts/check-voice.mjs` still passes).

### 2.2 Add a real build step (`AUDIT.md` §12.5 — S–M)

`index.html` is 862KB of JSX compiled **in the browser** by Babel standalone from a CDN (`index.html:21`, `:70`). Consequences: seconds of blank screen on mobile cold load; no error boundary is even possible (`index.html:8733`: *"ErrorBoundary removed — static class methods not supported in Babel standalone"*), so one render error white-screens the app; and every change you make from here pays the tax.

**This does not require rewriting the app.**

1. `npm i -D vite @vitejs/plugin-react`
2. Move the `<script type="text/babel">` body (`index.html:70`–end) into `src/app.jsx` unchanged. Keep the surrounding HTML shell.
3. `vite.config.js` with the React plugin; output to `dist/`. Point `vercel.json` at the build output.
4. Drop the CDN `<script>` for Babel. React/ReactDOM become real imports.
5. **Restore the error boundary** — the reason it was deleted no longer applies. Wrap `<App/>`; on catch, render a recovery screen and fire the existing `render_error` event (`index.html:14582`).
6. Verify `scripts/check-index-syntax.mjs` still runs (it uses sucrase — may need repointing at `src/app.jsx`).

**Acceptance:** cold-load time-to-interactive on a throttled 4G profile, before vs. after. Expect a large improvement. A thrown render error shows a recovery screen instead of a white page.

**Then, incrementally:** extract components out of `src/app.jsx` one at a time as you touch them. Do not do a big-bang split.

---

## Step 3 — Branch on what Step 0 told you

### Track A — voice is good (drift < 35, would-post > 60%)

The moat is real; the problem is that almost nobody reaches it. **Build Brief 1 (`AUDIT.md` §9) — the one-field first run.**

Order:
1. `POST /api/seed-profile` — verify token, normalize handle, write `profiles.handles` + `learn_from_public_posts = true`, call `fetchHandleResearch()` (`api/_lib/handle-research.js:336`), then **persist** the result into profile columns. Today research is injected into the prompt and never saved. One Haiku call structures the paragraph into `voice` / `topics` / `pillars` / `audience` / `known_for`; `postExcerpts` go straight into `voice_samples[]`.
2. Pack defaults for `platforms` / `formats` / `goal` / `niche` — hardcode a single `creator` default set now, refactor into packs later (Step 4).
3. `FirstRun` component: one input (handle, or 3–5 post links), one button. Replaces the Profile-tab default at `index.html:9397-9401`.
4. Fire the existing streaming plan immediately. **Streaming cards are the first thing a new user ever sees.**
5. After it renders, show the voice-confirm strip — move `VoiceExcerptSuggestions` (`index.html:7291`) and `PostSampleFeeder` (`index.html:6975`) up from profile section 6 of 7.
6. Demote the 7-section wizard to "Sharpen your voice," reachable from the existing `nextSharperField` hint (`index.html:6643`).

**Do not touch the plan prompt builders.** Every field they read is already optional and skipped cleanly when empty.

**Acceptance:** a new account reaches rendered cards with one user-supplied value. Log `first_output_reached` with elapsed seconds. Re-run the Step 0.3 baseline after two weeks.

### Track B — voice is not good (drift > 50, or would-post < 60%)

Stop everything else. Onboarding more people into mediocre output makes things worse, not better.

1. **Universal rubric first** (`AUDIT.md` F6 — S, cached, near-zero token cost). `RATIONALE_RULES` and `SELF_CHECK_RUBRIC` currently run on **plan only** (`prompts.js:1117`, `:1199`). Move both into `composeSystemPrompt` (`prompts.js:891`) with a per-surface rationale-field list. Scan's `why_format` / `tip` / `analysis` are rationale fields getting no rationale rules at all today.
2. **Fix the voice-reference gap** (Q1c). If most users have no `sample_caption` or `voice_samples`, the model is writing from adjectives. This is the highest-leverage voice fix available and it is mostly a placement problem — see Track A step 5, which is worth doing on its own even in Track B.
3. **Iterate prompts against the drift score.** You now have a metric. Change one thing, generate 20, compare. `scripts/voice-eval-nightly.mjs` and `scripts/persona-eval.mjs` already exist — wire them into this loop.
4. **Re-run Step 0.2** (the ten-plan read) after each iteration. Ship Track A only when the would-post rate clears 60%.

---

## Step 4 — Structural work (after a track lands)

In order:

1. **Brief 4 — niche packs** (`AUDIT.md` §7, M). Five disagreeing taxonomies today; 6 of 17 niches have no trend segment and silently degrade to `creator`. Do this before Brief 3, because Brief 3 needs the `defaults` block.
2. **Brief 5 — cost cleanup** (M, mostly S-sized items): 1-hour cache TTL (cache-read share is 11.6% against a 60–80% design target, so caching is currently *net-negative*); Haiku for `log_metrics` + `voice_sample_extract` (both silently coerced to Sonnet today — `prompts.js:2152` vs `ALLOWED_MODELS` at `:188`); fence untrusted blocks; cap Pro's credits.
3. **Brief 3 Phase A only** — the 5 columns persisting plan inputs (`formats`, `goal`, `goal_secondary`, `followers`, `niche`). Cheap, safe, unblocks everything later, and fixes the "second device re-asks the wizard" bug on its own.

---

## Step 5 — The proactive weekly plan (gated, not scheduled)

`AUDIT.md` Brief 3 Phases B and C. **Do not ship until:**

- Would-post rate ≥ 60% (Step 0.2, re-measured)
- Publish rate from Step 1.3 shows people posting what VIRL generates
- Track A has landed and activation has actually moved

Weekly unprompted email **amplifies whatever quality you have**. Below that bar it converts "I forgot about VIRL" into "VIRL sends me things I don't use," which is a harder state to recover from than silence.

When you do build it: batch the cron (≤10 users per invocation with a cursor) so it never approaches the Vercel function limit, write results to the existing `plan_jobs` table, and make the subject line carry a specific hook from the actual plan — *"Your week: the Franklin market-myth post is Tuesday's opener"* — never *"Your weekly plan is ready."*

---

## What is deliberately not on this list

**Distribution.** At 29 lifetime signups and 6 monthly actives, it is the binding constraint, and nothing in `AUDIT.md` or this guide addresses it — the audit brief didn't ask. Everything here makes the product better for the people who arrive. None of it makes more people arrive.

Track A moves activation from ~31% to maybe 80%, which at current volume is roughly **9 activated users → 23**. Worth doing, and not the thing that decides the outcome. That decision is being made somewhere outside this repo, and it deserves its own plan.
