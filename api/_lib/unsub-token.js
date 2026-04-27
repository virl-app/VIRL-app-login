// Lightweight signed unsubscribe tokens. We sign `userId` with HMAC-SHA256
// using a server secret so a one-click link can't be forged. URL-safe base64
// keeps the token tidy in mailto/?t= params. No DB lookup is required to
// verify — the secret-keyed signature is the proof.
//
// Token format: <userId>.<base64url-hmac>

import crypto from "crypto";

const SECRET = process.env.EMAIL_UNSUB_SECRET || process.env.SUPABASE_SERVICE_KEY || "";

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sign(payload) {
  return b64url(crypto.createHmac("sha256", SECRET).update(payload).digest());
}

export function makeUnsubToken(userId) {
  if (!userId || !SECRET) return null;
  return `${userId}.${sign(userId)}`;
}

export function verifyUnsubToken(token) {
  if (!token || typeof token !== "string" || !SECRET) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const userId = token.slice(0, dot);
  const sig    = token.slice(dot + 1);
  const expect = sign(userId);
  // Constant-time compare
  if (sig.length !== expect.length) return null;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) mismatch |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
  return mismatch === 0 ? userId : null;
}
