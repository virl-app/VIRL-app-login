# VIRL — Business & Go-to-Market Brief

**For business planning, pricing, and GTM strategy sessions**
**Last refreshed:** May 2026 (post PR #82 — inline fresh-trends launch)

---

## 🎯 How to use this brief with Claude

Save this file to your project and start a fresh Claude session with:

> *"Read the file at `virl-gtm-brief.md`. This is the canonical business snapshot for VIRL — product, value prop, unit economics, competitive landscape, and current pricing. Use it as ground truth, then help me work on [GTM topic / pricing question / launch plan]. Ask clarifying questions before making strategic recommendations."*

The brief is self-contained — a fresh session can reason about VIRL's business without needing the codebase loaded.

---

## 📦 What VIRL is

VIRL is a **premium AI content-strategy app for solo creators and small social-media operators.** It produces a personalized 7-day, multi-platform content plan plus on-demand captions, scripts, and viral-potential scans of uploaded media — every output grounded in a deep creator profile and *this week's* live algorithm signal from Perplexity.

The unit of value is **a finished plan the user can execute**, not a chatbot that produces drafts.

**Tech stack:** Single-page React frontend (Babel-standalone via `index.html`), Vercel serverless API in `/api`, Supabase for auth + data, Anthropic (Sonnet 4.6 for plan/script/scan, Haiku 4.5 for caption) for generation, Perplexity Sonar for live trend research, Stripe for payments, Loops for lifecycle email.

---

## 🧭 Product surface (feature inventory)

| Surface | What it does |
|---|---|
| **Plan** | 7-day, 10-14 card multi-platform plan with strategy block, hooks, format-specific bodies |
| **Plan partial regen** | Select N cards → swap only those (kept cards untouched) via streaming |
| **Plan strategy regen** | Re-frame the same week from a different strategic angle |
| **Caption** | Per-platform caption set with on-screen hook |
| **Caption remix** | One-click respin of an existing caption |
| **Script** | Long-form script for a selected plan card |
| **VIRL Scan** | Upload image/video → viral-potential score + per-platform recs |
| **Vault** | Save plan items for later reference |
| **Results** | Log post performance after publishing |
| **Algo** | Read-only view of the playbook + this-week's trends |
| **Demo plan** | One free plan before profile completion (conversion taste) |
| **Profile** | Voice, audience, personal facts, never-assume, love-to-reference |
| **Admin** | Founding count, usage / cost dashboard, playbook draft review |

---

## 💎 Value proposition

**"What should I post this week?" goes from an hour of guessing to a 60-second personalized plan that already knows your voice, your platforms, your algorithm constraints, and what's working *this* week.**

Solo creators and small operators don't need another generic AI text generator — they need a strategy partner that respects their constraints. VIRL is built so the first plan a user generates *feels like* it came from a creator strategist who's been watching them post for six months.

---

## 🌟 Key differentiators

1. **"Sounds like you" personalization.** Profile captures voice, audience, personal facts ("I have three sons, not daughters"), never-assume rules, and love-to-reference touchstones. The system prompt enforces these as canonical — eliminating the generic-AI feel that kills competing tools.
2. **Live trend signal per generation.** Every plan / scan / caption can fire Perplexity inline to pull today's TikTok / Instagram / LinkedIn / etc. signal. Most competitors lean on stale training data or hand-curated "tips."
3. **Algorithm-aware, per platform.** A server-side playbook table encodes cadence, peak times, hashtag rules, and format priorities for each platform — refreshed monthly via admin-approved Perplexity research. Plans respect platform cadence (not "post 1×/day across all").
4. **Multi-format native.** Plans intentionally diversify across video, single-image, carousel, story, quote-graphic, and long-form text — with format-specific output structure for each. Most tools default to video everything.
5. **Streaming + progressive UX.** Strategy block lands at ~2s, first card at ~3s, all cards through ~12s. Felt latency ≈ half of a typical 60s AI generation.
6. **Conversion engineering built into product.** Demo plan before profile, celebration overlays at plans #1/#5/#10, milestone Loops emails, founding-member capped tier, premium brand voice in every empty state.
7. **Cron-cached + inline-fresh hybrid.** Weekly cron caches trends in Supabase (cheap fallback); inline Perplexity fires per generation for paid users and once-per-week per gen type for trial users. Cost-bounded and graceful.

---

## 💰 Current pricing structure

| Tier | Price | Credits / week | Fresh-trends inline | Trial length |
|---|---|---|---|---|
| **Free trial** | $0 | 20 | 1× plan + 1× scan + 1× caption / week | 14 days |
| **Founding** (first 100 users) | $20/mo year 1 ($5 off) | 150 | Unlimited | n/a |
| **Standard** | $25/mo or $249/yr | 150 | Unlimited | n/a |
| **Pro** *(reserved tier — not currently sold)* | TBD | TBD | TBD | n/a |

**Per-gen credit costs:** plan=3, scan=2, script=2, caption=1, plan_partial=1, plan_strategy=1, regen=1.

**Reset cadence:** Per-user 7-day rolling window from each user's `credits.reset_at` timestamp. NOT calendar Mondays — a Wednesday signup gets a Wednesday-to-Wednesday wallet.

**Trial enforcement:** Server-side gate at 14 days post-signup; UI nudges from day 11 onward.

---

## 📊 Unit economics

### Cost inputs

| Component | Pricing | Notes |
|---|---|---|
| Anthropic Sonnet 4.6 | $3/M in, $15/M out, $0.30/M cache-read | Used for plan / script / scan |
| Anthropic Haiku 4.5 | $1/M in, $5/M out, $0.10/M cache-read | Used for caption |
| Perplexity Sonar | ~$1/M in, ~$1/M out | New: inline trends per generation |
| Supabase Pro | $25/mo flat | Auth + Postgres + storage |
| Vercel Pro | $20/mo flat | Hosting + serverless functions |

### Per-generation cost (current best estimates)

| Gen type | Anthropic | Perplexity (when inline) | Total |
|---|---|---|---|
| Plan (3 platforms typical) | ~$0.12 | ~$0.015 | ~$0.135 |
| Scan (3 platforms) | ~$0.04 | ~$0.015 | ~$0.055 |
| Caption (1 platform) | ~$0.003 | ~$0.005 | ~$0.008 |
| Script | ~$0.03 | (uses parent plan snapshot — $0) | ~$0.03 |
| Plan partial regen | ~$0.04 | (snapshot reuse — $0) | ~$0.04 |
| Plan strategy regen | ~$0.02 | (snapshot reuse — $0) | ~$0.02 |

### Cost per user per month (projected)

| User type | Anthropic | Perplexity | Infra (amort. @ 100 users) | **Total / mo** | Revenue | **Gross margin** |
|---|---|---|---|---|---|---|
| Free trial (light use over 14 days) | ~$0.30 | ~$0.07 | ~$0.45 | **~$0.82 trial** | $0 | acquisition cost only |
| Standard typical (~70% credit use) | $2.88 | $0.46 | $0.45 | **~$3.79** | $25 | **~85%** |
| Standard heavy (100% credit use) | $5.64 | $1.00 | $0.45 | **~$7.09** | $25 | **~72%** |
| Founding typical | $2.88 | $0.46 | $0.45 | **~$3.79** | $20 | **~81%** |
| Founding heavy | $5.64 | $1.00 | $0.45 | **~$7.09** | $20 | **~65%** |

**Infra amortization falls fast with scale:** $45/mo flat ÷ 500 paid users = $0.09/user. At 1000 users it drops below $0.05. The user-count dependent cost (Anthropic + Perplexity) is the load-bearing economics number.

### Implied LTV / CAC ceiling

Assuming 12-month average tenure × $22.50 blended ARPU × 75% blended margin ≈ **$203 LTV per paid user**. Healthy CAC budget: $50-70.

---

## 🏟️ Competitive landscape

| Tool | Starter | Mid | Scheduling? | AI plan-gen? | Live trend research? | Deep personalization? |
|---|---|---|---|---|---|---|
| **Buffer** | $6/mo | $12/mo | ✅ | Basic AI captions | ❌ | ❌ |
| **Later** | $18.75/mo | $45/mo | ✅ | AI captions + visual planner | ❌ | ❌ |
| **ContentStudio** | $19/mo | $49/mo | ✅ | 25k AI words/mo | ❌ | ❌ |
| **Predis.ai** | $19-25/mo | $49/mo | ✅ | Auto-post generation | ❌ | ❌ |
| **Captions AI** | $9.99/mo | $24.99/mo | ❌ | Caption-only | ❌ | ❌ |
| **Flick** | $14/mo | $68/mo | ✅ | AI captions + hashtags | ❌ | Light |
| **Simplified** | ~$12/mo | $30+/mo | ✅ | AI writer + design | ❌ | ❌ |
| **Hootsuite** | $99/mo | $249+/mo | ✅ | Enterprise AI | ❌ | ❌ |
| **VIRL** | **$20/mo** (founding) | **$25/mo** | **❌** | **✅ full weekly plan** | **✅** | **✅ canonical facts** |

### What the data says

- **VIRL is correctly positioned in the densest part of the solo-creator market** ($18-25). Sweet spot for "I'm serious about my content but I'm not an agency."
- **VIRL holds an outlier feature at standard-tier pricing.** No comp in the $18-25 band offers live per-generation trend research. The closest equivalents appear only at $99+/mo enterprise tiers.
- **Structural gap: scheduling.** Every comp from $6 to $250 includes auto-posting. VIRL plans but doesn't publish. A user paying $25 for VIRL + $6 for Buffer to actually post = $31/mo total — and all-in-one alternatives start looking reasonable around there.
- **Caption-only AI is commoditized.** Rytr at $9, Captions Pro at $9.99 set the floor. Caption-as-anchor can't justify $25; *plan + algorithm + trends + personalization* is what does.

---

## ✅ Profitability verdict

**Yes, current pricing is profitable, and margins are healthy.** Industry healthy-SaaS-margin is 70-80% gross; VIRL is at **72-85% typical, 65% worst-case heavy founding**. Every tier clears.

**One cohort to watch:** founding-tier heavy users at 65% margin. If they cluster toward heavy usage once you have 50+ paid users, the $5 founding discount is being paid back in real Anthropic spend. The 100-user founding cap is what protects you — it's well-designed.

---

## 🎯 Strategic pricing recommendations

### 1. Hold the current structure — it's correctly priced.

- **$20 founding → $25 standard** is bang-on for the segment.
- **$249/yr annual (2 months free)** is standard SaaS discount math; gets commitment.
- **14-day trial, 20 credits/week, 1-per-week fresh-trends freebie** is adequate runway with cost cap (~$0.82 max over the full trial).

### 2. Add — not replace — a "Pro" tier at $39-49/mo.

Comp data shows clear willingness-to-pay above $25 when the differentiation is concrete (Later Growth $45, Captions Max $69, Flick top tier $68). Right now VIRL has no upgrade path above $25 — heavy users hit the credit cap and stop, instead of paying more. A Pro tier could include:

- 300 credits/week (vs. 150)
- Priority generation (rate-limit floor bumped from 5/min to 15/min)
- Sunday Review weekly digest (from the cost/perf backlog, item 8)
- Possibly: basic Buffer/Later integration (publish from VIRL to your existing scheduler)
- Possibly: vault-as-content-bank with semantic search over past plans

Projected margin on Pro at ~$39: ~75-82% (same shape as Standard but capturing higher LTV from the cohort that wants to spend more).

### 3. Don't build native scheduling.

It's 3-6 months of OAuth flows, schedulers, rate limits, and post-failure handling for 7 platforms. Higher-leverage move: **one-click integration with Buffer or Later** ("VIRL plans, Buffer publishes"). Lower build cost, removes the structural pricing gap, keeps VIRL on the strategy side of the value chain.

### 4. Lean into trend research in marketing.

The chip ("✦ Fresh trends · 1 of 1 this week") and the badge ("✦ Fresh trend") shipped in PR #82 are walking marketing. "What's working this week on TikTok, baked into your plan" beats every generic-AI-content pitch in the price band.

### 5. Re-evaluate credit allotment after 30-50 paid users have telemetry.

The [COST 1] telemetry is logging per-generation cost. After 30-50 users × 4 weeks = 120-200 user-weeks of data, you'll know whether 150 credits/week is generous-as-a-moat or wasteful. The fact that founding-heavy is at 65% margin suggests there's room to either tighten the cap *or* leave it as a feature people brag about.

---

## ⚠️ Risk register

| Risk | Watch metric | Mitigation if it triggers |
|---|---|---|
| AI captioning commoditizes to $0 | Trial → paid conversion rate trending down | Drop standalone caption surface from positioning; lean fully into plan + trends |
| Heavy users break margin | 90th-percentile cost-per-user > $12 | Ship the Pro tier; introduce soft cap nudges before hard credit limits |
| Scheduling gap drives churn | "Reason for canceling" survey: publishing tools | Ship Buffer / Later integration as a v1 outbound link |
| Perplexity raises Sonar pricing | Per-plan Perplexity spend creeps past $0.03 | Re-evaluate the 1-per-week trial cap; cron-cached fallback already handles a worst-case rollback |
| Anthropic deprecates Sonnet 4.6 mid-cycle | Model availability notices | The `selectedModel` indirection in chat.js already handles model swaps; recheck output quality on the successor |
| Founding cohort over-uses below cost | Founding-tier cost per user > $7 | Cap is at 100 — already capped. Communicate "founding is locked" once cap hits. |
| Trial → paid conversion < 5% | Cohort funnel by signup week | Strengthen demo plan flow; A/B test trial length |

---

## 🛣️ Product roadmap that affects business strategy

From the existing cost/perf backlog and other briefs, these items intersect with GTM / business decisions:

1. **Cost telemetry** (live) — converts these projections to actuals.
2. **Cache expansion + message batches** (backlog) — another ~15% cost reduction; extends margin.
3. **Output tightening** (backlog) — data-driven `maxTokens` reduction once truncation rate is well below 5%.
4. **Predictive pre-generation** (backlog) — shifts plan cost to batch API (50% discount) for users who're consistent enough to forecast.
5. **Sunday Review weekly digest** (backlog) — unlocks a Pro-tier hook + a retention layer; quietly logged events are already in place.
6. **Buffer / Later integration** (proposed, not in backlog) — closes the scheduling gap without becoming a scheduler.

Net: PR #82 was likely the **last major cost-adding change for the foreseeable feature roadmap**. Everything else in the queue is net-negative on per-user spend.

---

## 🧠 Open strategic questions worth chewing on

A fresh GTM session might want to dig into:

1. **Positioning lane.** Strategy partner vs. AI content generator vs. social media operating system? Each implies a different marketing surface, different pricing power, different competitive set.
2. **Acquisition channel.** Solo creators are a fragmented audience. Where do they cluster? (Instagram creator forums, LinkedIn creator economy, niche newsletters, ConvertKit partners?) Each has different CAC and LTV implications.
3. **Trial length and shape.** 14 days + 20 credits is fine but unexamined. Would a 7-day trial with more credits convert better? Would no trial + money-back guarantee?
4. **Pro tier timing.** Wait until you have signal that heavy users want it, or build it pre-emptively to capture the willingness-to-pay you can already see in comps?
5. **Founding cap rollover.** When the 100 fills, do you grandfather them at $20 forever, or rotate to $25 at year-2 renewal? The latter recovers margin but feels less premium.
6. **Annual mix.** $249 annual vs. $25 monthly. What's the current annual:monthly ratio, and what's the target? Annual customers churn less and pay upfront but have higher refund-request risk.
7. **The "build vs. integrate" question.** Native scheduling, native analytics, native CRM — each is a build decision with cost/positioning implications.
8. **Co-marketing partners.** Buffer, Later, Loops, Stan Store, ConvertKit — who's the natural partner? Where can VIRL be the strategy layer that makes another tool's existing customers stickier?

---

## 📎 Sources & references

- Anthropic Sonnet 4.6 / Haiku 4.5 pricing — published at https://www.anthropic.com/pricing (sampled January 2026)
- Perplexity Sonar pricing — referenced in `api/_lib/perplexity.js` comments
- Competitor pricing — Later, Buffer, Hootsuite, ContentStudio, Predis.ai, Captions AI, Flick, Simplified, Metricool official pricing pages (May 2026)
- Per-generation cost telemetry: `usage_events` table (live as of [COST 1])
- Founding cap and trial enforcement: `api/chat.js`, `api/_lib/prompts.js`
- Fresh-trends gate: `api/chat.js` + `api/_lib/fresh-trends-inline.js` (PR #82, merged May 2026)
- Existing strategic briefs in repo: `virl-premium-brand-brief`, `virl-intelligence-brief`, `virl-cost-perf-backlog`, `virl-launch-brief.pdf`
