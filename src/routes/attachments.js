// Mounted at /api/tasks/:id/attachments (auth is applied by the parent router).
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Router } = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const { requireTask, requireTeam } = require('../services/access');
const { notify } = require('../services/notifications');
const { badRequest, forbidden, notFound } = require('../errors');
const { idParam } = require('../utils');

const router = Router({ mergeParams: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

// Files are stored under random names so user-supplied names never touch the filesystem.
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname).slice(0, 10).replace(/[^.\w]/g, '')),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

const COLUMNS = 'id, task_id, user_id, original_name, mime_type, size, created_at';

router.get('/', (req, res) => {
  const task = requireTask(idParam(req.params.id), req.user.id);
  res.json(db.prepare(`SELECT ${COLUMNS} FROM attachments WHERE task_id = ? ORDER BY id`).all(task.id));
});

// Membership is verified before multer writes anything to disk. Send as multipart/form-data, field "file".
router.post(
  '/',
  (req, _res, next) => {
    req.task = requireTask(idParam(req.params.id), req.user.id);
    next();
  },
  upload.single('file'),
  (req, res) => {
    if (!req.file) throw badRequest('Attach a file in the "file" form field');
    const { lastInsertRowid } = db
      .prepare('INSERT INTO attachments (task_id, user_id, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.task.id, req.user.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size);
    const assignee = req.task.assignee_id;
    if (assignee && assignee !== req.user.id) {
      notify(assignee, 'attachment_added', `${req.user.name} attached a file to "${req.task.title}"`, req.task.id);
    }
    res.status(201).json(db.prepare(`SELECT ${COLUMNS} FROM attachments WHERE id = ?`).get(lastInsertRowid));
  },
);

function findAttachment(req) {
  const task = requireTask(idParam(req.params.id), req.user.id);
  const row = db.prepare('SELECT * FROM attachments WHERE id = ? AND task_id = ?').get(idParam(req.params.attachmentId), task.id);
  if (!row) throw notFound('Attachment not found');
  return { task, row };
}

router.get('/:attachmentId/download', (req, res, next) => {
  const { row } = findAttachment(req);
  // `download` forces Content-Disposition: attachment so uploaded HTML is never rendered inline.
  res.download(path.join(config.uploadDir, row.stored_name), row.original_name, (err) => err && next(notFound('File missing')));
});

router.delete('/:attachmentId', (req, res) => {
  const { task, row } = findAttachment(req);
  if (row.user_id !== req.user.id && requireTeam(task.team_id, req.user.id).role !== 'owner') {
    throw forbidden('Only the uploader or team owner can delete this attachment');
  }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
  fs.rm(path.join(config.uploadDir, row.stored_name), { force: true }, () => {});
  res.status(204).end();
});

module.exports = router;
