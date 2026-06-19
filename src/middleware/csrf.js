const crypto = require('crypto');

function newCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = newCsrfToken();
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function csrfProtection(req, res, next) {
  const expected = req.session?.csrfToken;
  const supplied = req.get('x-csrf-token') || req.body?._csrf;
  const valid = typeof expected === 'string' && typeof supplied === 'string'
    && expected.length === supplied.length
    && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  if (valid) return next();

  if (req.baseUrl === '/api' || req.is('application/json')) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  return res.status(403).render('error', { error: 'Your form expired. Please try again.' });
}

module.exports = { ensureCsrfToken, csrfProtection, newCsrfToken };
