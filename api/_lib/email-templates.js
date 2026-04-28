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

function unsubscribeFooter(unsubscribeToken) {
  if (!unsubscribeToken) return ""; // transactional — no unsub
  const url = `${UNSUBSCRIBE_BASE}?t=${encodeURIComponent(unsubscribeToken)}`;
  return `
    <tr><td style="padding:24px 32px;border-top:1px solid ${COLOR.border};font-family:Helvetica,Arial,sans-serif;font-size:11px;color:${COLOR.muted};line-height:1.6;text-align:center">
      You're receiving this because you signed up for VIRL.
      <br/>
      <a href="${url}" style="color:${COLOR.muted};text-decoration:underline">Unsubscribe from updates like this</a>
      &nbsp;·&nbsp;
      Account &amp; billing emails will still be sent.
    </td></tr>`;
}

function unsubscribeFooterText(unsubscribeToken) {
  if (!unsubscribeToken) return "";
  const url = `${UNSUBSCRIBE_BASE}?t=${encodeURIComponent(unsubscribeToken)}`;
  return `\n\n---\nYou're receiving this because you signed up for VIRL.\nUnsubscribe: ${url}\nAccount & billing emails will still be sent.`;
}

// Wraps a single content block in the standard frame so every email shares
// the same visual signature. `body` is raw HTML; the helper handles header,
// padding, and footer (including unsubscribe link when provided).
function layout({ headline, body, primaryCta, unsubscribeToken }) {
  const cta = primaryCta
    ? `<tr><td style="padding:0 32px 32px"><a href="${primaryCta.href}" style="display:inline-block;background:${COLOR.blue};color:${COLOR.white};font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;text-decoration:none;padding:14px 28px;border-radius:99px">${primaryCta.label}</a></td></tr>`
    : "";

  return `<!doctype html>
<html><body style="margin:0;padding:24px 12px;background:${COLOR.bg};font-family:Helvetica,Arial,sans-serif;color:${COLOR.ink}">
  <table role="presentation" cellpadding="0" cellspacing="0" align="center" width="100%" style="max-width:600px;background:${COLOR.card};border-radius:14px;overflow:hidden;border:1px solid ${COLOR.border}">
    <tr><td style="padding:28px 32px 8px"><div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:24px;color:${COLOR.navy};letter-spacing:0.04em">VIRL</div></td></tr>
    <tr><td style="padding:0 32px 8px"><div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.2;color:${COLOR.ink}">${headline}</div></td></tr>
    <tr><td style="padding:8px 32px 24px;font-size:15px;line-height:1.7;color:${COLOR.sub}">${body}</td></tr>
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
    html:    layout({ headline, body, primaryCta: { href: APP_URL, label: "Open VIRL" } }),
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
    html:    layout({ headline, body, primaryCta: { href: `${APP_URL}/?upgrade=1`, label: "See plans" }, unsubscribeToken }),
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
    html:    layout({ headline, body, primaryCta: { href: `${APP_URL}/?upgrade=1`, label: "Lock in founding rate" }, unsubscribeToken }),
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
    html:    layout({ headline, body, primaryCta: { href: `${APP_URL}/?upgrade=1`, label: "Upgrade to Standard" }, unsubscribeToken }),
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
    html:    layout({ headline, body, primaryCta: { href: APP_URL, label: "Open VIRL" } }),
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
    html:    layout({ headline, body, primaryCta: { href: APP_URL, label: "Update payment" } }),
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
    html:    layout({ headline, body, primaryCta: { href: APP_URL, label: "Open VIRL" } }),
    text:    `${headline}\n\nWe're sorry to see you go.\n\nYour account stays open. Vault, saved plans, profile — all yours to keep. Resubscribe any time.\n\nReply to tell us what didn't work — feedback is gold this early.\n\n${APP_URL}`,
  };
}

// 8. Weekly Monday reset — re-engagement nudge for active users.
export function weeklyReset({ name, unsubscribeToken }) {
  const headline = "Fresh credits, fresh week.";
  const body = `
    <p style="margin:0 0 12px">${name ? "Happy Monday, " + name + "." : "Happy Monday."} Your VIRL credits just refreshed.</p>
    <p style="margin:0 0 12px">A 60-second plan generation now sets the next seven days. The earlier you draft it, the more time you have to actually post it.</p>
    <p style="margin:0">If your audience expanded last week — or anything changed about how you sound — update your profile first, then generate.</p>`;
  return {
    subject: "Fresh week, fresh VIRL credits",
    html:    layout({ headline, body, primaryCta: { href: APP_URL, label: "Generate this week's plan" }, unsubscribeToken }),
    text:    `${headline}\n\nHappy Monday. Your VIRL credits just refreshed.\n\nA 60-second plan generation sets the next seven days.\n\n${APP_URL}${unsubscribeFooterText(unsubscribeToken)}`,
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
    html:    layout({ headline, body, primaryCta: { href: APP_URL + "/?tab=admin", label: "Review drafts" } }),
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
    html:    layout({ headline, body, primaryCta: { href: APP_URL + "/?tab=plan", label: "Generate my first plan" }, unsubscribeToken }),
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
    html:    layout({ headline, body, primaryCta: { href: APP_URL + "/?tab=plan", label: "Open the plan" } }),
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
    html:    layout({ headline, body, primaryCta: { href: APP_URL, label: "Open VIRL" }, unsubscribeToken }),
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
    html:    layout({ headline, body, primaryCta: { href: APP_URL + "/?tab=results", label: "Log results" }, unsubscribeToken }),
    text:    `${headline}\n\nYou have ${unloggedCount} ${noun} from this week's plan that need results logged. Takes 90 seconds.\n\nVIRL learns what's working for your audience from these numbers.\n\n${APP_URL}/?tab=results${unsubscribeFooterText(unsubscribeToken)}`,
  };
}


