const db = require('../db');

const insert = db.prepare('INSERT INTO notifications (user_id, type, message, task_id) VALUES (?, ?, ?, ?)');
const getOne = db.prepare('SELECT * FROM notifications WHERE id = ?');

/** Open Server-Sent-Events connections, keyed by user id. */
const clients = new Map();

function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
}

function removeClient(userId, res) {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(res);
  if (!set.size) clients.delete(userId);
}

/** Persists a notification and pushes it to the user's live SSE connections. */
function notify(userId, type, message, taskId = null) {
  const { lastInsertRowid } = insert.run(userId, type, message, taskId);
  const row = getOne.get(lastInsertRowid);
  for (const res of clients.get(userId) || []) {
    res.write(`event: notification\ndata: ${JSON.stringify(row)}\n\n`);
  }
  return row;
}

module.exports = { notify, addClient, removeClient };
