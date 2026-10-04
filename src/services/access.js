const db = require('../db');
const { forbidden, notFound } = require('../errors');

const memberStmt = db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?');
const teamStmt = db.prepare('SELECT * FROM teams WHERE id = ?');
const taskStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');

const isMember = (teamId, userId) => !!memberStmt.get(teamId, userId);

/** Returns the team when the user belongs to it. Non-members get 404 so team ids are not leaked. */
function requireTeam(teamId, userId) {
  const team = teamStmt.get(teamId);
  const member = team && memberStmt.get(teamId, userId);
  if (!member) throw notFound('Team not found');
  return { ...team, role: member.role };
}

function requireOwner(teamId, userId) {
  const team = requireTeam(teamId, userId);
  if (team.role !== 'owner') throw forbidden('Only the team owner can do this');
  return team;
}

/** Returns the task when the user belongs to the task's team. */
function requireTask(taskId, userId) {
  const task = taskStmt.get(taskId);
  if (!task || !memberStmt.get(task.team_id, userId)) throw notFound('Task not found');
  return task;
}

module.exports = { isMember, requireTeam, requireOwner, requireTask };
