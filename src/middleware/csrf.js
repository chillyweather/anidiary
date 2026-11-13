const crypto = require('crypto');

function newCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// An anonymous session exists only to carry the login/register form token.
const ANONYMOUS_SESSION_MAX_AGE_MS = 60 * 60 * 1000;

// Exposes the session's token to views without creating a session: with
// saveUninitialized off, an untouched anonymous session is never stored.
function exposeCsrfToken(req, res, next) {
  if (req.session?.userId && !req.session.csrfToken) req.session.csrfToken = newCsrfToken();
  if (req.session?.csrfToken) res.locals.csrfToken = req.session.csrfToken;
  next();
}

// Called by handlers that render a form to an anonymous visitor. Creates the
// session (shortened to an hour unless logged in) on first use.
function issueCsrfToken(req, res) {
  if (!req.session.csrfToken) {
    if (!req.session.userId) req.session.cookie.maxAge = ANONYMOUS_SESSION_MAX_AGE_MS;
    req.session.csrfToken = newCsrfToken();
  }
  res.locals.csrfToken = req.session.csrfToken;
  return req.session.csrfToken;
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

module.exports = {
  exposeCsrfToken, issueCsrfToken, csrfProtection, newCsrfToken, ANONYMOUS_SESSION_MAX_AGE_MS
};
