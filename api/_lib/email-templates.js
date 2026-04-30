// VIRL email templates. Each export returns `{ subject, html, text }` so the
// send wrapper can render either format. Keep markup simple — many email
// clients strip CSS aggressively. Inline styles only, single-column 600px
// layout, italic-serif headlines (matching the app), navy/blue/coral palette.

const APP_URL          = process.env.APP_URL || "https://app.govirl.ai";
const UNSUBSCRIBE_BASE = `${APP_URL}/api/email/unsubscribe`;

// Brand colours mirror index.html's `B` palette.
const COLOR = {
  bg:      "#F8FAFC",
  card:    "#FFFFFF",
  ink:     "#0F172A",
  sub:     "#334155",
  muted:   "#64748B",
  navy:    "#1F3A8A",
  blue:    "#2563EB",
  sky:     "#3B82F6",
  coral:   "#F43F5E",
  border:  "#E2E8F0",
  white:   "#FFFFFF",
};

// Brand tagline — repeated in the header band and the footer so the
// emails read distinctly VIRL even when forwarded.
const BRAND_TAGLINE = "Finally, a strategy that sounds like you.";

function unsubscribeFooter(unsubscribeToken) {
  // Branded footer block. Always shows the navy tagline + small VIRL
  // mark; unsubscribe link only renders for marketing sends. Account &
  // billing emails still get the brand foot but no unsub.
  const unsubLink = unsubscribeToken
    ? `<a href="${UNSUBSCRIBE_BASE}?t=${encodeURIComponent(unsubscribeToken)}" style="color:${COLOR.muted};text-decoration:underline">Unsubscribe from updates like this</a> &nbsp;·&nbsp; Account &amp; billing emails will still be sent.`
    : `Account &amp; billing receipts only — no unsubscribe needed.`;
  return `
    <tr><td style="padding:32px 32px 28px;border-top:1px solid ${COLOR.border};text-align:center">
      <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:18px;color:${COLOR.navy};letter-spacing:0.05em;margin-bottom:4px">VIRL</div>
      <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:11px;color:${COLOR.sky};letter-spacing:0.02em;margin-bottom:14px">${BRAND_TAGLINE}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:${COLOR.muted};line-height:1.65">
        ${unsubLink}
      </div>
    </td></tr>`;
}

function unsubscribeFooterText(unsubscribeToken) {
  if (!unsubscribeToken) return "";
  const url = `${UNSUBSCRIBE_BASE}?t=${encodeURIComponent(unsubscribeToken)}`;
  return `\n\n---\nVIRL — ${BRAND_TAGLINE}\nUnsubscribe: ${url}\nAccount & billing emails will still be sent.`;
}

// Email frame. Every template renders through this so a single-line
// styling change cascades. Constraints: inline styles only (Outlook +
// Gmail strip <style> blocks aggressively), table-based layout for
// older clients, web-safe fonts (Georgia for italic-serif, Helvetica
// for body), 600px max width.
//
// `accent` flips the CTA pill + the eyebrow color from navy/blue (the
// default, used for transactional + neutral emails) to coral (used for
// celebration moments — welcome, first plan, milestone). Pass
// accent: "coral" for those.
function layout({ headline, body, primaryCta, eyebrow, unsubscribeToken, accent }) {
  const accentColor      = accent === "coral" ? COLOR.coral : COLOR.blue;
  const accentEyebrow    = accent === "coral" ? COLOR.coral : COLOR.navy;
  const accentShadowRGB  = accent === "coral" ? "244,63,94" : "37,99,235";

  const eyebrowBlock = eyebrow
    ? `<tr><td style="padding:0 36px 6px"><div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:${accentEyebrow}">${eyebrow}</div></td></tr>`
    : "";

  const cta = primaryCta
    ? `<tr><td style="padding:8px 36px 36px">
        <a href="${primaryCta.href}" style="display:inline-block;background:${accentColor};color:${COLOR.white};font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;text-decoration:none;padding:15px 30px;border-radius:99px;box-shadow:0 6px 18px rgba(${accentShadowRGB},0.35)">${primaryCta.label}</a>
      </td></tr>`
    : `<tr><td style="padding:0 36px 32px"></td></tr>`;

  return `<!doctype html>
<html><body style="margin:0;padding:32px 12px;background:${COLOR.bg};font-family:Helvetica,Arial,sans-serif;color:${COLOR.ink}">
  <table role="presentation" cellpadding="0" cellspacing="0" align="center" width="100%" style="max-width:600px;background:${COLOR.card};border-radius:18px;overflow:hidden;border:1px solid ${COLOR.border};box-shadow:0 4px 30px rgba(15,23,42,0.06)">
    <!-- Navy header band — mirrors the in-app top nav. VIRL mark + italic tagline. -->
    <tr><td style="background:${COLOR.navy};padding:22px 36px 20px">
      <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:26px;color:${COLOR.white};letter-spacing:0.06em;line-height:1">VIRL</div>
      <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:11px;color:${COLOR.sky};letter-spacing:0.02em;margin-top:4px">${BRAND_TAGLINE}</div>
    </td></tr>
    ${eyebrowBlock}
    <tr><td style="padding:${eyebrow ? "4px" : "32px"} 36px 16px"><div style="font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.2;color:${COLOR.ink};letter-spacing:-0.005em">${headline}</div></td></tr>
    <tr><td style="padding:0 36px 22px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.75;color:${COLOR.sub}">${body}</td></tr>
    ${cta}
    ${unsubscribeFooter(unsubscribeToken)}
  </table>
</body></html>`;
}

// ── Templates ─────────────────────────────────────────────────────────────

// 1. Welcome — fired on first sign-in (and as cron safety net).
export function welcome({ name }) {
  const headline = name ? `Welcome to VIRL, ${name}.` : "Welcome to VIRL.";
  const body = `
    <p style="margin:0 0 12px">You have 14 days and 20 credits per week to put VIRL through its paces — no card needed.</p>
    <p style="margin:0 0 12px">Three things to try first:</p>
    <ol style="margin:0 0 16px;padding-left:18px">
      <li>Finish your creator profile (the more detail, the more the plans sound like <em>you</em>).</li>
      <li>Generate your first weekly plan.</li>
      <li>Run one of your existing photos through VIRL Scan to see how it would score.</li>
    </ol>
    <p style="margin:0">Reply to this email if anything's confusing — a real person reads every reply.</p>`;
  return {
    subject: "Welcome to VIRL — let's build your first plan",
    html:    layout({ eyebrow: "Welcome", accent: "coral", headline, body, primaryCta: { href: APP_URL, label: "Open VIRL" } }),
    text:    `${headline}\n\nYou have 14 days and 20 credits per week to put VIRL through its paces — no card needed.\n\nThree things to try first:\n  1. Finish your creator profile.\n  2. Generate your first weekly plan.\n  3. Run a photo through VIRL Scan.\n\nReply to this email if anything's confusing.\n\n${APP_URL}`,
  };
}

// 2. Trial day 11 — three days left, soft urgency.
export function trialDay11({ name, unsubscribeToken }) {
  const headline = "Three days left in your free trial.";
  const body = `
    <p style="margin:0 0 12px">${name ? name + ", you've" : "You've"} had ${"&nbsp;"}11 days with VIRL. Three more before the trial ends.</p>
    <p style="margin:0 0 12px">If VIRL is helping, the founding rate locks in 20% off year one — that ends with the trial too.</p>
    <p style="margin:0">No pressure if it's not the right fit. Either way, your plans and vault stay safe.</p>`;
  return {
    subject: "3 days left in your VIRL trial",
    html:    layout({ eyebrow: "Reminder", headline, body, primaryCta: { href: `${APP_URL}/?upgrade=1`, label: "See plans" }, unsubscribeToken }),
    text:    `${headline}\n\nYou've had 11 days with VIRL. Three more before the trial ends.\n\nIf VIRL is helping, the founding rate locks in 20% off year one — that ends with the trial too.\n\n${APP_URL}/?upgrade=1${unsubscribeFooterText(unsubscribeToken)}`,
  };
}

// 3. Trial day 13 — last day, harder ask.
export function trialDay13({ name, unsubscribeToken }) {
  const headline = "Last day of your VIRL trial.";
  const body = `
    <p style="margin:0 0 12px">${name ? name + ", today" : "Today"} is day 14 — your trial ends tonight.</p>
    <p style="margin:0 0 12px">If you've found VIRL useful, lock in the founding rate before midnight: $20/mo or $225/yr (saves $75 vs monthly). Standard pricing kicks in tomorrow.</p>
    <p style="margin:0">If it's not the fit, that's totally fine — your account stays open, your vault and saved plans are yours to keep.</p>`;
  return {
    subject: "Last day of your VIRL trial",
    html:    layout({ eyebrow: "Last day", accent: "coral", headline, body, primaryCta: { href: `${APP_URL}/?upgrade=1`, label: "Lock in founding rate" }, unsubscribeToken }),
    text:    `${headline}\n\nToday is day 14 — your trial ends tonight.\n\nIf you've found VIRL useful, lock in the founding rate before midnight: $20/mo or $225/yr.\n\n${APP_URL}/?upgrade=1${unsubscribeFooterText(unsubscribeToken)}`,
  };
}

// 4. Trial expired — trial is over, soft pitch.
export function trialExpired({ name, unsubscribeToken }) {
  const headline = "Your free trial ended.";
  const body = `
    <p style="margin:0 0 12px">${name ? name + ", your" : "Your"} 14-day trial is over. Your profile, vault, and saved plans are still here — they don't go anywhere.</p>
    <p style="margin:0 0 12px">If you'd like to keep generating new plans, captions, scripts, and scans, here's how:</p>
    <ul style="margin:0 0 16px;padding-left:18px">
      <li><strong>Standard</strong> — $25/mo or $249/yr (2 months free). 150 credits/week, every feature.</li>
    </ul>
    <p style="margin:0">No hard feelings if not — reply and tell me why VIRL didn't fit. That feedback is gold this early.</p>`;
  return {
    subject: "Your VIRL free trial has ended",
    html:    layout({ eyebrow: "Trial ended", headline, body, primaryCta: { href: `${APP_URL}/?upgrade=1`, label: "Upgrade to Standard" }, unsubscribeToken }),
    text:    `${headline}\n\nYour 14-day trial is over. Your profile, vault, and saved plans stay safe.\n\nStandard: $25/mo or $249/yr — 150 credits/week, every feature.\n\n${APP_URL}/?upgrade=1${unsubscribeFooterText(unsubscribeToken)}`,
  };
}

// 5. Subscription welcome — fires on Stripe checkout.session.completed.
export function subscriptionWelcome({ name, plan }) {
  const planLabel = plan === "founding" ? "VIRL Founding" : "VIRL Standard";
  const headline = `Welcome to ${planLabel}.`;
  const body = `
    <p style="margin:0 0 12px">${name ? name + ", thank" : "Thank"} you. Your subscription is live and 150 credits a week are now yours.</p>
    <p style="margin:0 0 12px">A few habits that compound on a paid plan:</p>
    <ul style="margin:0 0 16px;padding-left:18px">
      <li>Generate a fresh plan every Monday morning.</li>
      <li>Run VIRL Scan on anything sitting in your camera roll before you delete it.</li>
      <li>Log results on every post — VIRL learns what's working for <em>your</em> audience.</li>
    </ul>
    <p style="margin:0">Billing receipts come from Stripe; this is the human note.</p>`;
  return {
    subject: `Welcome to ${planLabel}`,
    html:    layout({ eyebrow: "Welcome aboard", accent: "coral", headline, body, primaryCta: { href: APP_URL, label: "Open VIRL" } }),
    text:    `${headline}\n\nThank you. Your subscription is live and 150 credits a week are now yours.\n\nGenerate a fresh plan every Monday, run VIRL Scan often, log results on every post.\n\n${APP_URL}`,
  };
}

// 6. Payment failed — Stripe past_due.
export function paymentFailed({ name }) {
  const headline = "We couldn't charge your card.";
  const body = `
    <p style="margin:0 0 12px">${name ? name + ", Stripe" : "Stripe"} just told us your most recent charge for VIRL failed.</p>
    <p style="margin:0 0 12px">No drama yet — Stripe will retry over the next few days. If the card needs updating, here's the fastest way:</p>
    <p style="margin:0">Open the app and head to your billing settings, or reply to this email and we'll send a billing-portal link.</p>`;
  return {
    subject: "Payment failed on your VIRL subscription",
    html:    layout({ eyebrow: "Action needed", accent: "coral", headline, body, primaryCta: { href: APP_URL, label: "Update payment" } }),
    text:    `${headline}\n\nStripe just told us your most recent charge for VIRL failed.\n\nStripe will retry. To update your card, open the app or reply for a billing-portal link.\n\n${APP_URL}`,
  };
}

// 7. Subscription cancelled — Stripe customer.subscription.deleted.
export function subscriptionCancelled({ name }) {
  const headline = "Your VIRL subscription was cancelled.";
  const body = `
    <p style="margin:0 0 12px">${name ? name + ", we" : "We"}'re sorry to see you go.</p>
    <p style="margin:0 0 12px">Your account stays open and your vault, saved plans, and profile are yours to keep — you can resubscribe at any time and pick up exactly where you left off.</p>
    <p style="margin:0">If there's something specific that didn't work, reply to this email. Founder-stage feedback is the most valuable thing you could send us.</p>`;
  return {
    subject: "Sorry to see you go — VIRL subscription cancelled",
    html:    layout({ eyebrow: "Confirmation", headline, body, primaryCta: { href: APP_URL, label: "Open VIRL" } }),
    text:    `${headline}\n\nWe're sorry to see you go.\n\nYour account stays open. Vault, saved plans, profile — all yours to keep. Resubscribe any time.\n\nReply to tell us what didn't work — feedback is gold this early.\n\n${APP_URL}`,
  };
}

// 8. Weekly Monday reset — re-engagement nudge for active users.
export function weeklyReset({ name, unsubscribeToken }) {
  const headline = "Fresh week, fresh momentum.";
  const body = `
    <p style="margin:0 0 12px">${name ? "Happy Monday, " + name + "." : "Happy Monday."} A new week — perfect time to draft your next plan and ship it before the week gets ahead of you.</p>
    <p style="margin:0 0 12px">A 60-second plan generation sets the next seven days. The earlier you draft it, the more room you have to actually post it.</p>
    <p style="margin:0">If your audience expanded last week — or anything changed about how you sound — update your profile first, then generate.</p>`;
  return {
    subject: "Fresh week, fresh VIRL plan",
    html:    layout({ eyebrow: "Fresh week", headline, body, primaryCta: { href: APP_URL, label: "Generate this week's plan" }, unsubscribeToken }),
    text:    `${headline}\n\nHappy Monday. A new week — perfect time to draft your next plan.\n\nA 60-second generation sets the next seven days.\n\n${APP_URL}${unsubscribeFooterText(unsubscribeToken)}`,
  };
}

// 9. Playbook drafts ready — admin-only notification fired by the monthly
// playbook-refresh cron when one or more drafts are pending review.
export function playbookDraftsReady({ count, summaries }) {
  const headline = count === 1
    ? "One playbook draft is ready for review."
    : `${count} playbook drafts are ready for review.`;
  const summaryList = (summaries || [])
    .map(s => `<li style="margin:6px 0"><strong>${s.platform}:</strong> ${s.summary || "Updates proposed."}</li>`)
    .join("");
  const summaryText = (summaries || [])
    .map(s => `  - ${s.platform}: ${s.summary || "Updates proposed."}`)
    .join("\n");
  const body = `
    <p style="margin:0 0 12px">VIRL's monthly playbook research surfaced ${count === 1 ? "a change" : "changes"} from trusted sources you should review before ${count === 1 ? "it" : "they"} reach the LLM.</p>
    ${summaryList ? `<ul style="margin:0 0 16px;padding-left:18px">${summaryList}</ul>` : ""}
    <p style="margin:0">Open the Dashboard to approve or reject each draft. Drafts that aren't approved stay archived without affecting the live playbook.</p>`;
  return {
    subject: count === 1 ? "1 VIRL playbook draft pending" : `${count} VIRL playbook drafts pending`,
    html:    layout({ eyebrow: "Admin", headline, body, primaryCta: { href: APP_URL + "/?tab=admin", label: "Review drafts" } }),
    text:    `${headline}\n\nVIRL's monthly playbook research surfaced ${count === 1 ? "a change" : "changes"} from trusted sources.\n\n${summaryText}\n\nOpen ${APP_URL} → Dashboard to review.`,
  };
}

// 10. Profile saved, no plan generated within 24h — activation nudge.
export function phase1NoPlan({ name, unsubscribeToken }) {
  const headline = "Your profile's set. Now build your week.";
  const body = `
    <p style="margin:0 0 12px">${name ? name + ", you" : "You"}'ve given VIRL the foundation. The next step is the one that pays off — generating your first 7-day plan.</p>
    <p style="margin:0 0 12px">It takes about 60 seconds. VIRL writes it in your voice, scoped to your audience, and timed to each platform's peak window.</p>
    <p style="margin:0">If something's stopping you from clicking generate, hit reply and tell me why. Real person reads every reply.</p>`;
  return {
    subject: "Your VIRL profile's set — generate your first plan",
    html:    layout({ eyebrow: "Activation", headline, body, primaryCta: { href: APP_URL + "/?tab=plan", label: "Generate my first plan" }, unsubscribeToken }),
    text:    `${headline}\n\nYou've given VIRL the foundation. Generating your first plan is the next step.\n\nTakes about 60 seconds.\n\n${APP_URL}/?tab=plan${unsubscribeFooterText(unsubscribeToken)}`,
  };
}

// 11. First plan generated — onboarding reinforcement, fired inline by /api/chat.
export function firstPlanGenerated({ name }) {
  const headline = name ? `Your first plan, ${name}.` : "Your first plan.";
  const body = `
    <p style="margin:0 0 12px">It's live. A few things to know now that you have one:</p>
    <ul style="margin:0 0 16px;padding-left:18px">
      <li><strong>Save the posts you love</strong> to your Vault — VIRL learns your taste from what you save and weights similar styles in next week's plan.</li>
      <li><strong>Generate scripts</strong> from any plan card. The hook + sections + CTA all stay in your voice.</li>
      <li><strong>Log results after you post</strong> (views, likes, saves). The Results tab is how VIRL learns what's actually working for <em>your</em> audience, not generic best practices.</li>
    </ul>
    <p style="margin:0">Plans reset Monday morning. Until then, this one's yours to refine and ship.</p>`;
  return {
    subject: "Your first VIRL plan, decoded",
    html:    layout({ eyebrow: "Milestone", accent: "coral", headline, body, primaryCta: { href: APP_URL + "/?tab=plan", label: "Open the plan" } }),
    text:    `${headline}\n\nIt's live. Save posts you love to your Vault, generate scripts from any card, and log results once you post.\n\nPlans reset Monday morning.\n\n${APP_URL}/?tab=plan`,
  };
}

// 12. 7-day inactivity — re-engagement.
export function inactive7Day({ name, unsubscribeToken }) {
  const headline = "Your VIRL plan's been waiting.";
  const body = `
    <p style="margin:0 0 12px">${name ? "Hey " + name + " — it" : "It"}'s been a week since you signed in. Your plan, vault, and saved scripts are still here exactly as you left them.</p>
    <p style="margin:0 0 12px">If life got in the way, no judgment. If something about VIRL didn't click, I'd love to hear it — reply to this email.</p>
    <p style="margin:0">Otherwise, the Monday reset is right around the corner. Worth a 60-second plan generation to put a fresh week on the calendar.</p>`;
  return {
    subject: "Your VIRL plan is waiting",
    html:    layout({ eyebrow: "Check-in", headline, body, primaryCta: { href: APP_URL, label: "Open VIRL" }, unsubscribeToken }),
    text:    `${headline}\n\nA week since you signed in. Your plan, vault, and saved scripts are still here.\n\n${APP_URL}${unsubscribeFooterText(unsubscribeToken)}`,
  };
}

// 13. Sunday batch-log nudge — mirrors the in-app SundayLogModal for users
// who didn't open the app on Sunday. Marketing-opt-out-able.
export function sundayLogNudge({ name, unloggedCount, unsubscribeToken }) {
  const noun = unloggedCount === 1 ? "post" : "posts";
  const headline = "How did this week go?";
  const body = `
    <p style="margin:0 0 12px">${name ? name + ", you" : "You"} have ${unloggedCount} ${noun} from this week's plan that ${unloggedCount === 1 ? "still needs" : "still need"} results logged. It takes 90 seconds.</p>
    <p style="margin:0 0 12px">Why bother: VIRL learns what's working for <em>your</em> audience from these numbers. Logged results sharpen next week's plan in ways generic best practices can't.</p>
    <p style="margin:0">Plans reset tomorrow morning, so this is the last good window to log this week.</p>`;
  return {
    subject: `Log this week's ${noun} — ${unloggedCount} pending`,
    html:    layout({ eyebrow: "Weekly wrap", headline, body, primaryCta: { href: APP_URL + "/?tab=results", label: "Log results" }, unsubscribeToken }),
    text:    `${headline}\n\nYou have ${unloggedCount} ${noun} from this week's plan that need results logged. Takes 90 seconds.\n\nVIRL learns what's working for your audience from these numbers.\n\n${APP_URL}/?tab=results${unsubscribeFooterText(unsubscribeToken)}`,
  };
}

// 14. Trial day 7 mid-trial check-in — friendly, no urgency yet.
export function trialDay7({ name, unsubscribeToken }) {
  const headline = "A week with VIRL.";
  const body = `
    <p style="margin:0 0 12px">${name ? name + ", you" : "You"}'re halfway through the free trial. Most creators discover by day 7 that the saved-to-vault loop is where VIRL actually starts working — once VIRL has 3-5 saved posts to learn from, the next plan starts feeling pointed.</p>
    <p style="margin:0 0 12px">If you haven't yet, two quick things to try this week:</p>
    <ul style="margin:0 0 16px;padding-left:18px">
      <li><strong>Save 3 posts</strong> from your plan to your vault. Future plans will weight similar styles higher.</li>
      <li><strong>Log results</strong> on anything you've actually posted. The Results tab is how VIRL learns what's landing for <em>your</em> audience, not generic best practices.</li>
    </ul>
    <p style="margin:0">If something's not clicking, hit reply — real person reads every reply.</p>`;
  return {
    subject: "How VIRL gets sharper after this week",
    html:    layout({ eyebrow: "Mid-trial", headline, body, primaryCta: { href: APP_URL, label: "Open VIRL" }, unsubscribeToken }),
    text:    `${headline}\n\nYou're halfway through the trial. Two things to try this week: save 3 posts to your vault, and log results on anything you've posted.\n\n${APP_URL}${unsubscribeFooterText(unsubscribeToken)}`,
  };
}

// 15. 30-day inactivity — softer than 7-day, more honest.
export function inactive30Day({ name, unsubscribeToken }) {
  const headline = "Honest check-in.";
  const body = `
    <p style="margin:0 0 12px">${name ? "Hey " + name + " — it" : "It"}'s been 30 days since you last opened VIRL. Either life got in the way (totally fine) or VIRL didn't end up clicking. I'd love to know which.</p>
    <p style="margin:0 0 12px">If something specific bounced you, reply with one line — even a curt one. That kind of feedback at this stage shapes what VIRL becomes.</p>
    <p style="margin:0">If you do come back: your vault, profile, and any saved scripts are exactly where you left them.</p>`;
  return {
    subject: "Did VIRL drop the ball?",
    html:    layout({ eyebrow: "Check-in", headline, body, primaryCta: { href: APP_URL, label: "Reopen VIRL" }, unsubscribeToken }),
    text:    `${headline}\n\nIt's been 30 days since you last opened VIRL. If something bounced you, reply with one line — that feedback shapes what VIRL becomes.\n\nIf you do come back: vault, profile, saved scripts all where you left them.\n\n${APP_URL}${unsubscribeFooterText(unsubscribeToken)}`,
  };
}

// 16. Renewal upcoming — fired by Stripe's invoice.upcoming webhook.
// Transparency cuts down "I didn't know I'd be charged" support tickets.
export function renewalUpcoming({ name, plan, amountUsd, renewalDate }) {
  const planLabel = plan === "founding" ? "Founding" : plan === "pro" ? "Pro" : "Standard";
  const headline = "Heads up — your VIRL renews soon.";
  const dateText = renewalDate ? new Date(renewalDate).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "shortly";
  const amountText = amountUsd ? `$${amountUsd.toFixed(2)}` : "your usual rate";
  const body = `
    <p style="margin:0 0 12px">${name ? name + ", a" : "A"} quick heads-up: your VIRL ${planLabel} subscription renews on <strong>${dateText}</strong> at ${amountText}.</p>
    <p style="margin:0 0 12px">Nothing you need to do — same card, same plan, same 150 credits/week. This is just a transparency note so the charge isn't a surprise.</p>
    <p style="margin:0">If you'd like to make changes (cancel, switch annual ↔ monthly, update your card), open the app's billing settings or reply and I'll sort it.</p>`;
  return {
    subject: `VIRL ${planLabel} renews ${dateText}`,
    html:    layout({ eyebrow: "Heads up", headline, body, primaryCta: { href: APP_URL, label: "Open VIRL" } }),
    text:    `${headline}\n\nYour VIRL ${planLabel} subscription renews on ${dateText} at ${amountText}.\n\nNothing you need to do — this is just a transparency note. To change anything, open the app's billing settings or reply.\n\n${APP_URL}`,
  };
}

// 17. Account deleted — last email the address gets from VIRL. Trust signal.
export function accountDeleted({ name }) {
  const headline = "Your VIRL account is closed.";
  const body = `
    <p style="margin:0 0 12px">${name ? name + ", we've" : "We've"} closed your VIRL account and deleted your data:</p>
    <ul style="margin:0 0 16px;padding-left:18px">
      <li>Your auth record</li>
      <li>Your profile, vault, and saved plans</li>
      <li>Your weekly credits and trial state</li>
      <li>Your activity history</li>
    </ul>
    <p style="margin:0 0 12px">Your Stripe billing history (invoices, payment methods) is governed by Stripe's retention policy and is outside our control.</p>
    <p style="margin:0">If this wasn't you, reply immediately. Otherwise, thanks for trying VIRL.</p>`;
  return {
    subject: "VIRL account closed",
    html:    layout({ eyebrow: "Receipt", headline, body }),
    text:    `${headline}\n\nWe've closed your account and deleted your auth record, profile, vault, saved plans, credits, trial state, and activity history.\n\nStripe billing history is governed by Stripe's retention policy.\n\nIf this wasn't you, reply immediately.\n\nThanks for trying VIRL.`,
  };
}

// 18. Referral milestone — mirrors the in-app modal at 3/7/15 plans.
export function referralMilestone({ name, milestone, unsubscribeToken }) {
  const headline = milestone === 3   ? "You're three plans in."
                 : milestone === 7   ? "Seven plans deep."
                 : milestone === 15  ? "Fifteen plans. Real momentum."
                 :                     `${milestone} plans generated.`;
  const body = `
    <p style="margin:0 0 12px">${name ? name + ", you" : "You"}'ve generated ${milestone} VIRL plans now. The data shows that creators who hit ${milestone} plans are the ones VIRL gets sharpest for — your vault, your logged results, and your week-over-week strategy are starting to compound.</p>
    <p style="margin:0 0 12px">If a friend of yours is building too, the founding rate is still open and a referral from someone like you carries more weight than any ad.</p>
    <p style="margin:0">Forward this email, or send them straight to ${APP_URL}.</p>`;
  return {
    subject: `${milestone} plans in — keep going`,
    html:    layout({ eyebrow: "Milestone", accent: "coral", headline, body, primaryCta: { href: APP_URL, label: "Open VIRL" }, unsubscribeToken }),
    text:    `${headline}\n\nYou've generated ${milestone} VIRL plans. Your vault + logged results are starting to compound.\n\nIf a friend's building too: ${APP_URL}${unsubscribeFooterText(unsubscribeToken)}`,
  };
}


