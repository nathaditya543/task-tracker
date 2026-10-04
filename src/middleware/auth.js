const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { unauthorized } = require('../errors');

const isRevoked = db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?');
const getUser = db.prepare('SELECT id, name, email FROM users WHERE id = ?');

/**
 * Verifies the Bearer JWT, rejects logged-out tokens and attaches req.user / req.token.
 * `allowQueryToken` lets SSE clients (EventSource cannot set headers) pass ?token=.
 */
function authenticate({ allowQueryToken = false } = {}) {
  return (req, _res, next) => {
    const header = req.headers.authorization || '';
    let raw = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!raw && allowQueryToken && typeof req.query.token === 'string') raw = req.query.token;
    if (!raw) throw unauthorized();

    let payload;
    try {
      payload = jwt.verify(raw, config.jwtSecret);
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    if (isRevoked.get(payload.jti)) throw unauthorized('Token has been revoked');
    const user = getUser.get(Number(payload.sub));
    if (!user) throw unauthorized('User no longer exists');

    req.user = user;
    req.token = payload;
    next();
  };
}

module.exports = { authenticate };
