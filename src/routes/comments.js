// Mounted at /api/tasks/:id/comments (auth is applied by the parent router).
const { Router } = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { requireTask } = require('../services/access');
const { notify } = require('../services/notifications');
const { forbidden, notFound } = require('../errors');
const { idParam } = require('../utils');

const router = Router({ mergeParams: true });

const schema = z.object({ body: z.string().trim().min(1).max(2000) });
const SELECT = 'SELECT c.id, c.task_id, c.user_id, u.name AS author, c.body, c.created_at FROM comments c JOIN users u ON u.id = c.user_id';

router.get('/', (req, res) => {
  const task = requireTask(idParam(req.params.id), req.user.id);
  res.json(db.prepare(`${SELECT} WHERE c.task_id = ? ORDER BY c.id`).all(task.id));
});

router.post('/', validate(schema), (req, res) => {
  const task = requireTask(idParam(req.params.id), req.user.id);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)')
    .run(task.id, req.user.id, req.valid.body.body);
  for (const uid of new Set([task.assignee_id, task.creator_id])) {
    if (uid && uid !== req.user.id) notify(uid, 'comment_added', `${req.user.name} commented on "${task.title}"`, task.id);
  }
  res.status(201).json(db.prepare(`${SELECT} WHERE c.id = ?`).get(lastInsertRowid));
});

router.delete('/:commentId', (req, res) => {
  const task = requireTask(idParam(req.params.id), req.user.id);
  const comment = db.prepare('SELECT * FROM comments WHERE id = ? AND task_id = ?').get(idParam(req.params.commentId), task.id);
  if (!comment) throw notFound('Comment not found');
  if (comment.user_id !== req.user.id) throw forbidden('You can only delete your own comments');
  db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
  res.status(204).end();
});

module.exports = router;
