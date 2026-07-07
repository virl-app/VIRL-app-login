// Supabase OAuth/PKCE redirect shim: bounces the provider callback to the SPA
// origin, preserving the `code` so the client can exchange it for a session.
//
// The destination host is hardcoded (no open-redirect surface). `code` is
// URL-encoded before it's placed in the Location header so a hostile value
// can't inject extra query params or CRLF into the redirect. Supabase auth
// codes are opaque URL-safe strings, so a strict character allowlist also
// rejects anything that isn't plausibly a real code before we reflect it.
const APP_ORIGIN = 'https://app.govirl.ai';
const CODE_RE = /^[A-Za-z0-9._~-]{1,512}$/;

export default function handler(req, res) {
  const { code } = req.query;
  const single = Array.isArray(code) ? code[0] : code;
  if (single && CODE_RE.test(single)) {
    res.redirect(302, `${APP_ORIGIN}/?code=${encodeURIComponent(single)}`);
  } else {
    res.redirect(302, APP_ORIGIN);
  }
}
