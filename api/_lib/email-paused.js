// [EMAIL PAUSE — Jul 2026] Global kill switch for outbound email.
//
// Deliberately fail-safe: email is PAUSED unless EMAIL_PAUSED is explicitly
// the string "false". Deploying this file stops sending immediately, with no
// dashboard or env change required — which is the property you want from an
// incident switch, because the moment you need one you don't want to be
// hunting for a Vercel setting.
//
// To resume: set EMAIL_PAUSED=false in the Vercel project (Production scope),
// or delete this module and its call sites once the underlying issues are
// fixed. Prefer the env var while the pause is temporary — leaving the switch
// in place keeps the ability to stop again in seconds.
//
// WHAT THIS STOPS
//   - every Resend send (all of api/_lib/email-templates.js)
//   - every Loops event fired from this codebase
//   - the daily Loops contact-property sync
//
// WHAT THIS CANNOT STOP — these need action outside the repo:
//   - Loops automations that fire on their own audience filters rather than on
//     an event from us. Nothing in this codebase triggers those, so nothing in
//     this codebase can suppress them. They must be paused in the Loops
//     dashboard.
//   - Supabase Auth mail (signup confirmation, password reset, magic link),
//     configured in the Supabase dashboard.
//
// Callers log rather than throw: a pause should make the system quiet, not
// make it fail. Every skip is logged with its template or event name so the
// logs still show what WOULD have gone out.
export function emailPaused() {
  return process.env.EMAIL_PAUSED !== "false";
}
