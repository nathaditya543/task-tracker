const { Router } = require('express');
const { randomBytes } = require('crypto');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { requireTeam, requireOwner } = require('../services/access');
const { notify } = require('../services/notifications');
const { badRequest, conflict, notFound, forbidden } = require('../errors');
const { idParam } = require('../utils');

const router = Router();
router.use(authenticate());

const members = (teamId) =>
  db
    .prepare(
      `SELECT u.id, u.name, u.email, m.role, m.joined_at FROM team_members m
       JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.joined_at, u.id`,
    )
    .all(teamId);

const createSchema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(1000).default('') });
const joinSchema = z.object({ inviteCode: z.string().min(1) });
const inviteSchema = z.object({ email: z.email() });

router.post('/', validate(createSchema), (req, res) => {
  const { name, description } = req.valid.body;
  const create = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO teams (name, description, invite_code, owner_id) VALUES (?, ?, ?, ?)')
      .run(name, description, randomBytes(6).toString('hex'), req.user.id);
    db.prepare("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')").run(lastInsertRowid, req.user.id);
    return Number(lastInsertRowid);
  });
  const id = create();
  res.status(201).json({ ...requireTeam(id, req.user.id), members: members(id) });
});

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*, m.role FROM teams t JOIN team_members m ON m.team_id = t.id
       WHERE m.user_id = ? ORDER BY t.created_at DESC, t.id DESC`,
    )
    .all(req.user.id);
  res.json(rows.map((t) => (t.role === 'owner' ? t : { ...t, invite_code: undefined })));
});

// Join through an invite code shared by the owner. Declared before /:id so "join" is not parsed as an id.
router.post('/join', validate(joinSchema), (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE invite_code = ?').get(req.valid.body.inviteCode);
  if (!team) throw notFound('Invalid invite code');
  const info = db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)').run(team.id, req.user.id);
  if (info.changes) notify(team.owner_id, 'team_joined', `${req.user.name} joined ${team.name}`);
  res.status(info.changes ? 201 : 200).json({ id: team.id, name: team.name, members: members(team.id) });
});

router.get('/:id', (req, res) => {
  const team = requireTeam(idParam(req.params.id), req.user.id);
  if (team.role !== 'owner') delete team.invite_code;
  res.json({ ...team, members: members(team.id) });
});

// Owner invites an existing user by email; the user is notified.
router.post('/:id/members', validate(inviteSchema), (req, res) => {
  const team = requireOwner(idParam(req.params.id), req.user.id);
  const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(req.valid.body.email);
  if (!user) throw notFound('No user with that email');
  const info = db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)').run(team.id, user.id);
  if (!info.changes) throw conflict('User is already a member');
  notify(user.id, 'team_invited', `${req.user.name} added you to ${team.name}`);
  res.status(201).json({ members: members(team.id) });
});

// Owner removes a member, or a member leaves (userId === self). The owner cannot leave.
router.delete('/:id/members/:userId', (req, res) => {
  const team = requireTeam(idParam(req.params.id), req.user.id);
  const userId = idParam(req.params.userId);
  if (userId !== req.user.id && team.role !== 'owner') throw forbidden('Only the owner can remove other members');
  if (userId === team.owner_id) throw badRequest('The owner cannot leave; delete the team instead');
  const run = db.transaction(() => {
    const info = db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(team.id, userId);
    // Their open assignments return to the unassigned pool.
    db.prepare('UPDATE tasks SET assignee_id = NULL WHERE team_id = ? AND assignee_id = ?').run(team.id, userId);
    return info.changes;
  });
  if (!run()) throw notFound('Member not found');
  res.status(204).end();
});

router.delete('/:id', (req, res) => {
  const team = requireOwner(idParam(req.params.id), req.user.id);
  db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
  res.status(204).end();
});

module.exports = router;
