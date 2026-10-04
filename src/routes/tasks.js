const { Router } = require('express');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { requireTeam, requireTask, isMember } = require('../services/access');
const { notify } = require('../services/notifications');
const { summarizeTask } = require('../services/ai');
const { badRequest, forbidden } = require('../errors');
const { idParam } = require('../utils');

const router = Router();
router.use(authenticate());

const STATUSES = ['open', 'in_progress', 'completed'];
const PRIORITIES = ['low', 'medium', 'high'];

const dueDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Must be a valid ISO date')
  .transform((s) => new Date(s).toISOString());

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  teamId: z.number().int().positive(),
  assigneeId: z.number().int().positive().nullable().optional(),
  priority: z.enum(PRIORITIES).default('medium'),
  dueDate: dueDate.nullable().optional(),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000),
    status: z.enum(STATUSES),
    priority: z.enum(PRIORITIES),
    dueDate: dueDate.nullable(),
    assigneeId: z.number().int().positive().nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const SORTS = { dueDate: 't.due_date', createdAt: 't.created_at', updatedAt: 't.updated_at', title: 't.title', priority: 'priority_rank' };

const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  teamId: z.coerce.number().int().positive().optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.coerce.number().int().positive()]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  dueBefore: dueDate.optional(),
  dueAfter: dueDate.optional(),
  sort: z.enum(Object.keys(SORTS)).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const SELECT = `
  SELECT t.*, a.name AS assignee_name, c.name AS creator_name,
         CASE t.priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END AS priority_rank
  FROM tasks t
  LEFT JOIN users a ON a.id = t.assignee_id
  JOIN users c ON c.id = t.creator_id`;

const present = ({ priority_rank, ...task }) => task;
const fetchTask = (id) => present(db.prepare(`${SELECT} WHERE t.id = ?`).get(id));

/** Assignees must belong to the task's team. */
function checkAssignee(teamId, assigneeId) {
  if (assigneeId != null && !isMember(teamId, assigneeId)) throw badRequest('Assignee must be a member of the team');
}

router.post('/', validate(createSchema), (req, res) => {
  const { title, description, teamId, assigneeId = null, priority, dueDate: due = null } = req.valid.body;
  requireTeam(teamId, req.user.id);
  checkAssignee(teamId, assigneeId);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO tasks (title, description, team_id, creator_id, assignee_id, priority, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(title, description, teamId, req.user.id, assigneeId, priority, due);
  const id = Number(lastInsertRowid);
  if (assigneeId && assigneeId !== req.user.id) {
    notify(assigneeId, 'task_assigned', `${req.user.name} assigned you "${title}"`, id);
  }
  res.status(201).json(fetchTask(id));
});

// Lists tasks across all of the caller's teams, with filtering, search, sorting and pagination.
router.get('/', validate(listSchema, 'query'), (req, res) => {
  const f = req.valid.query;
  const where = ['t.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)'];
  const params = [req.user.id];
  const add = (clause, ...values) => { where.push(clause); params.push(...values); };

  if (f.status) add('t.status = ?', f.status);
  if (f.priority) add('t.priority = ?', f.priority);
  if (f.teamId) add('t.team_id = ?', f.teamId);
  if (f.assignee === 'me') add('t.assignee_id = ?', req.user.id);
  else if (f.assignee === 'unassigned') where.push('t.assignee_id IS NULL');
  else if (f.assignee) add('t.assignee_id = ?', f.assignee);
  if (f.dueBefore) add('t.due_date <= ?', f.dueBefore);
  if (f.dueAfter) add('t.due_date >= ?', f.dueAfter);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`;
    add("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')", like, like);
  }

  const clause = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${clause}`).get(...params).n;
  // Column and direction come from whitelists, never from raw input.
  const orderBy = `${SORTS[f.sort]} ${f.order === 'asc' ? 'ASC' : 'DESC'}, t.id DESC`;
  const rows = db
    .prepare(`${SELECT} WHERE ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, f.limit, (f.page - 1) * f.limit);
  res.json({ data: rows.map(present), page: f.page, limit: f.limit, total });
});

router.get('/:id', (req, res) => {
  res.json(fetchTask(requireTask(idParam(req.params.id), req.user.id).id));
});

router.patch('/:id', validate(updateSchema), (req, res) => {
  const task = requireTask(idParam(req.params.id), req.user.id);
  const b = req.valid.body;
  if ('assigneeId' in b) checkAssignee(task.team_id, b.assigneeId);

  const status = b.status ?? task.status;
  const completedAt = status === 'completed' ? (task.completed_at ?? new Date().toISOString()) : null;
  db.prepare(
    `UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, due_date = ?, assignee_id = ?,
       completed_at = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(
    b.title ?? task.title,
    b.description ?? task.description,
    status,
    b.priority ?? task.priority,
    'dueDate' in b ? b.dueDate : task.due_date,
    'assigneeId' in b ? b.assigneeId : task.assignee_id,
    completedAt,
    task.id,
  );

  // Notify the new assignee about assignment, and the current assignee/creator about other changes.
  const newAssignee = 'assigneeId' in b ? b.assigneeId : task.assignee_id;
  if (newAssignee && newAssignee !== task.assignee_id && newAssignee !== req.user.id) {
    notify(newAssignee, 'task_assigned', `${req.user.name} assigned you "${task.title}"`, task.id);
  }
  const recipients = new Set([newAssignee === task.assignee_id ? newAssignee : null, task.creator_id]);
  recipients.delete(null);
  recipients.delete(req.user.id);
  const verb = status === 'completed' && task.status !== 'completed' ? 'completed' : 'updated';
  for (const uid of recipients) notify(uid, `task_${verb}`, `${req.user.name} ${verb} "${b.title ?? task.title}"`, task.id);

  res.json(fetchTask(task.id));
});

router.delete('/:id', (req, res) => {
  const task = requireTask(idParam(req.params.id), req.user.id);
  const team = requireTeam(task.team_id, req.user.id);
  if (task.creator_id !== req.user.id && team.role !== 'owner') {
    throw forbidden('Only the task creator or team owner can delete a task');
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  res.status(204).end();
});

// AI-generated summary of a task and its comment thread.
router.post('/:id/summary', async (req, res) => {
  const task = requireTask(idParam(req.params.id), req.user.id);
  const comments = db
    .prepare('SELECT c.body, u.name AS author FROM comments c JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.id')
    .all(task.id);
  res.json(await summarizeTask(task, comments));
});

router.use('/:id/comments', require('./comments'));
router.use('/:id/attachments', require('./attachments'));

module.exports = router;
