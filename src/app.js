const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { notFoundHandler, errorHandler } = require('./middleware/error');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', rateLimitAuth(require('./routes/auth')));
app.use('/api/users', require('./routes/users'));
app.use('/api/teams', require('./routes/teams'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/ai', require('./routes/ai'));

app.use(notFoundHandler);
app.use(errorHandler);

/**
 * Minimal in-memory limiter (20 requests / minute / IP) to blunt credential stuffing.
 * Swap for a shared store (e.g. Redis) if you run more than one instance.
 */
function rateLimitAuth(router) {
  const hits = new Map();
  const limiter = (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();
    const now = Date.now();
    const entry = hits.get(req.ip);
    if (!entry || entry.reset < now) hits.set(req.ip, { count: 1, reset: now + 60000 });
    else if (++entry.count > 20) return res.status(429).json({ error: 'Too many requests, try again later' });
    next();
  };
  const wrapper = express.Router();
  wrapper.use(limiter, router);
  return wrapper;
}

module.exports = app;
