export default function handler(req, res) {
  const { code, next } = req.query;
  if (code) {
    res.redirect(302, `https://app.govirl.ai?code=${code}`);
  } else {
    res.redirect(302, 'https://app.govirl.ai');
  }
}
