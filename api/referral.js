// [REFERRAL] GET → the signed-in user's share code, link, and stats.
// Also lazily claims any inbound ?ref= from the user's own signup
// metadata, so simply opening the share card completes attribution.

import { getOrCreateCode, claimReferralIfAny, getReferralStats } from "./_lib/referrals.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_URL              = process.env.APP_URL || "https://app.govirl.ai";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: "Server misconfigured." });

  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!auth) return res.status(401).json({ error: "Sign in required." });
  let user;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${auth}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Sign in required." });
    user = await userRes.json();
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }

  await claimReferralIfAny(user.id); // idempotent, fail-open
  const code = await getOrCreateCode(user.id);
  if (!code) return res.status(500).json({ error: "Could not create referral code." });
  const stats = await getReferralStats(user.id);
  return res.status(200).json({ code, url: `${APP_URL}/?ref=${code}`, stats });
}
