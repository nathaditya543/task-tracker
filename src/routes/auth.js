const { Router } = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { z } = require('zod');
const config = require('../config');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { conflict, unauthorized } = require('../errors');

const router = Router();

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  password: z.string().min(8).max(128),
});
const loginSchema = z.object({ email: z.email(), password: z.string().min(1) });

const signToken = (user) =>
  jwt.sign({ sub: String(user.id) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn, jwtid: randomUUID() });

router.post('/register', validate(registerSchema), async (req, res) => {
  const { name, email, password } = req.valid.body;
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw conflict('Email already registered');
  const hash = await bcrypt.hash(password, 12);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name, email, hash);
  const user = { id: Number(lastInsertRowid), name, email };
  res.status(201).json({ user, token: signToken(user) });
});

// A dummy hash keeps response time similar whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

router.post('/login', validate(loginSchema), async (req, res) => {
  const { email, password } = req.valid.body;
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) throw unauthorized('Invalid email or password');
  const user = { id: row.id, name: row.name, email: row.email };
  res.json({ user, token: signToken(user) });
});

/** Revokes the presented token so it cannot be reused before it expires. */
router.post('/logout', authenticate(), (req, res) => {
  db.prepare('INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)').run(req.token.jti, req.token.exp);
  db.prepare('DELETE FROM revoked_tokens WHERE expires_at < ?').run(Math.floor(Date.now() / 1000));
  res.status(204).end();
});

module.exports = router;
