// Weekly trends refresh. Auto-publishes — no admin approval. Each row in
// public.trends is dated and lists the URLs the model cited; users see the
// freshness on the Algo tab and can form their own judgment. Plan / scan /
// caption prompts pull the latest row per platform and weave the items in.
//
// Auth: CRON_SECRET-gated (Vercel sends `Authorization: Bearer ${CRON_SECRET}`).

import { researchTrends } from "../_lib/trends-research.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET          = process.env.CRON_SECRET;

const PLATFORMS = ["TikTok","Instagram","Facebook","YouTube","LinkedIn","X","Pinterest"];

const SUPABASE_HEADERS = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function insertTrend(platform, summary, items, sources) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/trends`, {
    method:  "POST",
    headers: Object.assign({}, SUPABASE_HEADERS, { Prefer: "return=minimal" }),
    body: JSON.stringify({
      platform,
      summary: summary || "",
      items:   items   || [],
      sources: sources || [],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[cron/trends-refresh] insert failed for", platform, res.status, text);
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  let published = 0;
  let skipped   = 0;
  let errored   = 0;

  for (const platform of PLATFORMS) {
    let result;
    try { result = await researchTrends(platform); }
    catch (e) {
      console.error("[cron/trends-refresh] research threw for", platform, e.message);
      errored++;
      continue;
    }
    if (!result) { errored++; continue; }
    // Always insert a row (even with zero items) so the Algo tab shows the
    // freshness — "we checked, nothing notable" is information too.
    const ok = await insertTrend(platform, result.summary, result.items, result.sources);
    if (ok) { published++; }
    else    { errored++;   }
    if (result.items.length === 0) skipped++;
  }

  return res.status(200).json({ ok: true, published, errored, quiet: skipped });
}
