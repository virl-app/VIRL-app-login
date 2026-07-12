// [REFERRAL] Shared helpers for the give-a-month/get-a-month program.
//
// Design notes:
// - The ?ref= code is captured at signup into auth user_metadata (the
//   GateScreen attribution block already stamps it), so claiming is a
//   pure server-side read – no extra client round-trip at signup.
// - claimReferralIfAny is idempotent and called lazily from two
//   touchpoints: GET /api/referral (user opens the share card) and
//   create-checkout (so the friend's discount applies even if they
//   never opened the card).
// - Reward flow (webhook): referred user's first successful checkout
//   marks the row 'converted'; if the referrer already has a Stripe
//   customer, a -$25 balance credit lands on their next invoice and the
//   row becomes 'referrer_rewarded'. Referrers still on trial bank the
//   'converted' row and redeem it as a coupon at their own checkout.

import crypto from "node:crypto";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HDRS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// Yearly cap on rewarded referrals per referrer – abuse ceiling, and a
// bound on revenue giveback. Converted-but-uncapped rows stay 'converted'.
export const REFERRAL_REWARD_CAP_PER_YEAR = 12;

// Stable, human-friendly 8-char code (no 0/O/1/I ambiguity).
function generateCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export async function getOrCreateCode(userId) {
  const got = await fetch(
    `${SUPABASE_URL}/rest/v1/referral_codes?user_id=eq.${userId}&select=code`,
    { headers: HDRS }
  );
  if (got.ok) {
    const rows = await got.json();
    if (rows[0] && rows[0].code) return rows[0].code;
  }
  // Insert with retry on the (vanishingly unlikely) code collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/referral_codes`, {
      method: "POST",
      headers: { ...HDRS, Prefer: "return=representation" },
      body: JSON.stringify({ user_id: userId, code }),
    });
    if (ins.ok) return code;
    if (ins.status === 409) {
      // Either the user row already exists (concurrent request – re-read)
      // or the code collided (retry with a fresh one).
      const re = await fetch(
        `${SUPABASE_URL}/rest/v1/referral_codes?user_id=eq.${userId}&select=code`,
        { headers: HDRS }
      );
      if (re.ok) { const rows = await re.json(); if (rows[0]) return rows[0].code; }
      continue;
    }
    break;
  }
  return null;
}

// Reads the user's signup metadata for a ?ref= code and records the
// referral if valid. Idempotent; fail-open (returns null on any miss).
export async function claimReferralIfAny(userId) {
  try {
    // Already claimed?
    const existing = await fetch(
      `${SUPABASE_URL}/rest/v1/referrals?referred_user_id=eq.${userId}&select=id,status,referrer_user_id`,
      { headers: HDRS }
    );
    if (existing.ok) {
      const rows = await existing.json();
      if (rows[0]) return rows[0];
    }
    // Signup metadata via the admin endpoint.
    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: HDRS });
    if (!uRes.ok) return null;
    const u = await uRes.json();
    const meta = (u && u.user_metadata) || {};
    const code = String(meta.ref || "").trim().toUpperCase();
    if (!code || !/^[A-Z2-9]{8}$/.test(code)) return null;
    // 30-day claim window: referrals attribute new accounts, not archaeology.
    if (u.created_at && Date.now() - Date.parse(u.created_at) > 30 * 24 * 3600 * 1000) return null;
    const cRes = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_codes?code=eq.${code}&select=user_id`,
      { headers: HDRS }
    );
    if (!cRes.ok) return null;
    const cRows = await cRes.json();
    const referrer = cRows[0] && cRows[0].user_id;
    if (!referrer || referrer === userId) return null; // no self-referral
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/referrals`, {
      method: "POST",
      headers: { ...HDRS, Prefer: "return=representation" },
      body: JSON.stringify({ code, referrer_user_id: referrer, referred_user_id: userId }),
    });
    if (!ins.ok) return null; // 409 = raced concurrent claim; fine
    const rows = await ins.json();
    return rows[0] || null;
  } catch (e) {
    console.warn("[referral] claim failed (fail-open):", e.message);
    return null;
  }
}

export async function getReferralStats(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/referrals?referrer_user_id=eq.${userId}&select=status`,
      { headers: HDRS }
    );
    if (!res.ok) return { signedUp: 0, converted: 0, rewarded: 0 };
    const rows = await res.json();
    const count = (s) => rows.filter((r) => r && r.status === s).length;
    return { signedUp: count("signed_up"), converted: count("converted"), rewarded: count("referrer_rewarded") };
  } catch (e) { return { signedUp: 0, converted: 0, rewarded: 0 }; }
}

// The friend's discount: valid while their referral hasn't converted yet.
export async function getPendingReferralForReferred(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/referrals?referred_user_id=eq.${userId}&status=eq.signed_up&select=id,referrer_user_id`,
      { headers: HDRS }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } catch (e) { return null; }
}

// A banked reward: the referrer's friend converted while the referrer
// wasn't a paying Stripe customer yet – redeemed at the referrer's own
// checkout as a coupon.
export async function getBankedRewardForReferrer(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/referrals?referrer_user_id=eq.${userId}&status=eq.converted&select=id&order=converted_at.asc&limit=1`,
      { headers: HDRS }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } catch (e) { return null; }
}

export async function updateReferral(id, patch) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/referrals?id=eq.${id}`, {
      method: "PATCH", headers: HDRS, body: JSON.stringify(patch),
    });
    return res.ok;
  } catch (e) { return false; }
}

// A "free month" matches what the person actually pays: Founder Circle
// months are $20, Standard months are $25. One idempotent coupon per
// amount; created on first use – no Stripe dashboard setup required.
export function referralMonthCents(foundingTier) {
  return foundingTier === "founder_circle" ? 2000 : 2500;
}
export async function ensureReferralCoupon(stripe, amountCents) {
  const cents = amountCents === 2000 ? 2000 : 2500;
  const id = `virl-referral-month-${cents}`;
  try {
    await stripe.coupons.retrieve(id);
    return id;
  } catch (e) {
    try {
      await stripe.coupons.create({
        id,
        amount_off: cents,
        currency: "usd",
        duration: "once",
        name: `VIRL referral – one month on us ($${cents / 100})`,
      });
      return id;
    } catch (e2) {
      if (e2 && e2.code === "resource_already_exists") return id;
      console.warn("[referral] coupon ensure failed:", e2.message);
      return null;
    }
  }
}
