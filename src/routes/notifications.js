const { Router } = require('express');
const { z } = require('zod');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { addClient, removeClient } = require('../services/notifications');
const { notFound } = require('../errors');
const { idParam } = require('../utils');

const router = Router();

/**
 * Real-time stream (Server-Sent Events). Browsers' EventSource cannot set an Authorization
 * header, so this one route also accepts ?token=<jwt>.
 */
router.get('/stream', authenticate({ allowQueryToken: true }), (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('event: ready\ndata: {}\n\n');
  addClient(req.user.id, res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(req.user.id, res);
  });
});

router.use(authenticate());

const listSchema = z.object({ unread: z.enum(['true', 'false']).optional() });

router.get('/', validate(listSchema, 'query'), (req, res) => {
  const unreadOnly = req.valid.query.unread === 'true';
  const rows = db
    .prepare(`SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND is_read = 0' : ''} ORDER BY id DESC LIMIT 100`)
    .all(req.user.id);
  res.json(rows);
});

router.post('/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.status(204).end();
});

router.patch('/:id/read', (req, res) => {
  const info = db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(idParam(req.params.id), req.user.id);
  if (!info.changes) throw notFound('Notification not found');
  res.status(204).end();
});

module.exports = router;
