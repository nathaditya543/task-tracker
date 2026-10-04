const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { badRequest, conflict } = require('../errors');

const router = Router();
router.use(authenticate());

const profile = (id) => db.prepare('SELECT id, name, email, bio, created_at FROM users WHERE id = ?').get(id);

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.email().max(254),
    bio: z.string().max(500),
    currentPassword: z.string(),
    newPassword: z.string().min(8).max(128),
  })
  .partial()
  .refine((v) => !v.newPassword || v.currentPassword, { message: 'currentPassword is required to set newPassword', path: ['currentPassword'] });

router.get('/me', (req, res) => res.json(profile(req.user.id)));

router.patch('/me', validate(updateSchema), async (req, res) => {
  const { name, email, bio, currentPassword, newPassword } = req.valid.body;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (email && email.toLowerCase() !== row.email.toLowerCase()) {
    if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, row.id)) throw conflict('Email already in use');
  }
  let hash = row.password_hash;
  if (newPassword) {
    if (!(await bcrypt.compare(currentPassword, row.password_hash))) throw badRequest('Current password is incorrect');
    hash = await bcrypt.hash(newPassword, 12);
  }
  db.prepare('UPDATE users SET name = ?, email = ?, bio = ?, password_hash = ? WHERE id = ?').run(
    name ?? row.name, email ?? row.email, bio ?? row.bio, hash, row.id,
  );
  res.json(profile(row.id));
});

module.exports = router;
