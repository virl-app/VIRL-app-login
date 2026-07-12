// [GEO-GATE] Vercel Edge Middleware that blocks non-US visitors from
// the app and returns a branded "VIRL isn't available outside the US
// yet" page with an email + marketing-consent waitlist form.
//
// Detection: x-vercel-ip-country header that Vercel adds on every
// request (all plan tiers).
//
// Allowlist:
//   - US                       – mainland US
//   - PR, GU, VI, AS, MP       – US territories (treated as US)
//   - null / missing country   – fail-open. Some legitimate US users
//                                are behind corporate VPNs or mobile
//                                networks where Vercel can't geolocate;
//                                blocking unknown would catch them too.
//
// Matcher: every route EXCEPT the waitlist endpoint itself (so non-US
// visitors can submit the form), favicon, and robots.txt. /api/* routes
// are otherwise gated, which is what we want – defense in depth against
// a curl client trying to hit /api/chat from outside the US.
//
// Bypass acceptability: this gate is NOT VPN-proof. Anyone with a US
// VPN gets through. For compliance defensibility, document the
// technical block + the captured intent (international_waitlist table)
// as evidence of good-faith effort.

export const config = {
  matcher: '/((?!api/international-waitlist|favicon|robots).*)',
};

const ALLOWED_COUNTRIES = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP']);

export default function middleware(request) {
  const country = request.headers.get('x-vercel-ip-country');
  // Fail-open: blank/unknown country → allow (US users behind VPNs/mobile)
  if (!country || ALLOWED_COUNTRIES.has(country)) {
    return; // continue to app
  }
  return new Response(unavailablePage(), {
    status: 200,
    headers: {
      'content-type':  'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function unavailablePage() {
  // Inline HTML – Edge runtime doesn't load template files, and a
  // single-string page keeps the bundle tiny (~3KB). Fonts loaded via
  // Google Fonts to match the rest of the app's typography (Italiana
  // for the editorial headline, Jost for body).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VIRL – Available in the US</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Italiana&family=Jost:wght@300;400;500;600;700&display=swap">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #1F3A8A;
    background-image: radial-gradient(circle at 1px 1px, rgba(255,255,255,0.06) 1px, transparent 0);
    background-size: 24px 24px;
    color: #0F172A;
    font-family: 'Jost', -apple-system, BlinkMacSystemFont, sans-serif;
    font-weight: 300;
    min-height: 100vh;
    padding: 64px 20px 80px;
    -webkit-font-smoothing: antialiased;
  }
  .wordmark {
    font-family: 'Italiana', Georgia, serif;
    font-size: 32px;
    letter-spacing: 0.14em;
    color: #FFFFFF;
    text-align: center;
    margin-bottom: 32px;
  }
  .card {
    max-width: 480px;
    margin: 0 auto;
    background: #FFFFFF;
    border-radius: 24px;
    padding: 44px 36px;
    box-shadow: 0 20px 60px rgba(15,23,42,0.18);
  }
  .headline {
    font-family: 'Italiana', Georgia, serif;
    font-size: 30px;
    line-height: 1.15;
    color: #1F3A8A;
    margin-bottom: 16px;
    letter-spacing: -0.005em;
  }
  .body {
    font-family: 'Jost', sans-serif;
    font-size: 15px;
    font-weight: 300;
    color: #334155;
    line-height: 1.7;
    margin-bottom: 28px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  input[type="email"] {
    padding: 14px 16px;
    border: 1px solid #E2E8F0;
    border-radius: 12px;
    font-family: 'Jost', sans-serif;
    font-size: 15px;
    font-weight: 400;
    color: #0F172A;
    background: #F8FAFC;
    outline: none;
    transition: border-color 0.15s, background 0.15s;
  }
  input[type="email"]:focus { border-color: #1F3A8A; background: #FFFFFF; }
  .consent {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    background: #F8FAFC;
    border: 1px solid #E2E8F0;
    border-radius: 10px;
    cursor: pointer;
    user-select: none;
  }
  .consent input { margin-top: 3px; cursor: pointer; flex-shrink: 0; }
  .consent label {
    font-family: 'Jost', sans-serif;
    font-size: 12px;
    font-weight: 300;
    color: #64748B;
    line-height: 1.55;
    cursor: pointer;
  }
  button {
    padding: 16px 20px;
    background: #F43F5E;
    color: #FFFFFF;
    border: none;
    border-radius: 99px;
    font-family: 'Jost', sans-serif;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: opacity 0.15s, transform 0.05s;
    margin-top: 4px;
  }
  button:hover:not(:disabled) { opacity: 0.92; }
  button:active:not(:disabled) { transform: translateY(1px); }
  button:disabled { opacity: 0.5; cursor: default; }
  .error {
    font-family: 'Jost', sans-serif;
    font-size: 13px;
    color: #F43F5E;
    margin-top: 4px;
    line-height: 1.5;
    min-height: 1.5em;
  }
  .success {
    text-align: center;
    padding: 16px 0 4px;
  }
  .success-icon {
    font-family: 'Italiana', serif;
    font-size: 36px;
    color: #1F3A8A;
    margin-bottom: 8px;
  }
  .success-headline {
    font-family: 'Italiana', serif;
    font-size: 24px;
    color: #1F3A8A;
    line-height: 1.2;
    margin-bottom: 10px;
  }
  .success-body {
    font-family: 'Jost', sans-serif;
    font-size: 14px;
    font-weight: 300;
    color: #64748B;
    line-height: 1.6;
  }
</style>
</head>
<body>
  <div class="wordmark">VIRL</div>
  <div class="card">
    <div id="form-state">
      <div class="headline">VIRL isn't available outside the US yet.</div>
      <div class="body">International expansion is on the roadmap &ndash; drop your email and we'll let you know the moment VIRL ships where you are.</div>
      <form id="waitlist-form" novalidate>
        <input id="email" type="email" placeholder="Your email" required autocomplete="email">
        <label class="consent">
          <input id="consent" type="checkbox">
          <span>Send me product updates and content tips from VIRL. Optional &ndash; unsubscribe any time.</span>
        </label>
        <button id="submit" type="submit">Notify me &rarr;</button>
        <div id="err" class="error"></div>
      </form>
    </div>
    <div id="success-state" class="success" style="display:none">
      <div class="success-headline">You're on the list.</div>
      <div class="success-body">We'll be in touch the moment VIRL ships where you are.</div>
    </div>
  </div>
<script>
(function(){
  var form    = document.getElementById('waitlist-form');
  var emailEl = document.getElementById('email');
  var consent = document.getElementById('consent');
  var submit  = document.getElementById('submit');
  var errEl   = document.getElementById('err');
  form.addEventListener('submit', function(e){
    e.preventDefault();
    errEl.textContent = '';
    var email = emailEl.value.trim();
    if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
      errEl.textContent = 'Please enter a valid email address.';
      emailEl.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Saving...';
    fetch('/api/international-waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, marketing_opt_in: consent.checked }),
    })
    .then(function(r){ return r.ok ? r.json() : r.json().then(function(d){ throw new Error((d && d.error) || 'Could not save – please try again.'); }); })
    .then(function(){
      document.getElementById('form-state').style.display = 'none';
      document.getElementById('success-state').style.display = 'block';
    })
    .catch(function(err){
      submit.disabled = false;
      submit.innerHTML = 'Notify me &rarr;';
      errEl.textContent = (err && err.message) || 'Could not save – please try again.';
    });
  });
})();
</script>
</body>
</html>`;
}
