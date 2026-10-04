# Task Tracker API

A REST backend for team task tracking: accounts, teams, tasks with assignment, comments, file attachments, real-time notifications (SSE) and optional AI-generated task descriptions.

**Stack:** Node.js 20+ (22 LTS recommended), Express 5, SQLite (`better-sqlite3`), JWT + bcrypt, zod validation, multer uploads.

## Quick start

```bash
npm install
cp .env.example .env     # set JWT_SECRET; optionally ANTHROPIC_API_KEY
npm start                # http://localhost:3000
npm test                 # integration tests (in-memory DB)
```

> `better-sqlite3` ships prebuilt binaries for even-numbered Node releases (20, 22, 24). On an odd release (e.g. 21) it has no prebuild and needs a C++ toolchain; use an LTS version.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `JWT_SECRET` | dev value | Token signing key. **Required when `NODE_ENV=production`** |
| `JWT_EXPIRES_IN` | 2h | Token lifetime |
| `DB_PATH` | ./data/app.db | SQLite file |
| `UPLOAD_DIR` / `MAX_UPLOAD_MB` | ./uploads / 5 | Attachment storage and size cap |
| `ANTHROPIC_API_KEY` / `AI_MODEL` | empty | Enables generative AI; without a key a template is returned |

## Design notes

- **Auth:** passwords hashed with bcrypt (cost 12). Login returns a JWT with a unique `jti`; **logout** stores the `jti` in a revocation table, so the token is rejected immediately. Login errors are generic and timing-equalised, and `/api/auth` is rate-limited (20/min/IP, in-memory).
- **Authorization:** every task, comment and attachment is scoped to a team. Non-members get `404` (not `403`) so ids are not leaked. Only owners can invite/remove members or delete a team.
- **Teams:** the owner can add users by email, or share the team's `invite_code` so others can join.
- **Tasks:** statuses `open | in_progress | completed`, priority `low | medium | high`. Assignees must be team members. `completed_at` is set automatically.
- **Safety:** all SQL is parameterized; sort columns are whitelisted; `LIKE` wildcards in search are escaped; uploads get random stored names and are served with `Content-Disposition: attachment`.
- **Errors:** JSON `{ "error": "...", "details": [...] }` with `400` validation, `401`, `403`, `404`, `409`, `413`, `429`.

## API

All routes are under `/api`. Send `Authorization: Bearer <token>` except register/login/health.

### Auth & profile
| Method | Path | Description |
|---|---|---|
| POST | `/auth/register` | `{name, email, password(min 8)}` → `{user, token}` |
| POST | `/auth/login` | `{email, password}` → `{user, token}` |
| POST | `/auth/logout` | Revokes the current token (204) |
| GET | `/users/me` | View profile |
| PATCH | `/users/me` | Update `name`, `email`, `bio`; change password with `currentPassword` + `newPassword` |

### Teams
| Method | Path | Description |
|---|---|---|
| POST | `/teams` | Create a team `{name, description?}` (you become owner) |
| GET | `/teams` | Teams you belong to |
| GET | `/teams/:id` | Team + members (`invite_code` visible to owner only) |
| POST | `/teams/join` | `{inviteCode}` |
| POST | `/teams/:id/members` | Owner adds a user `{email}` |
| DELETE | `/teams/:id/members/:userId` | Owner removes a member, or a member leaves (own id) |
| DELETE | `/teams/:id` | Owner deletes the team |

### Tasks
| Method | Path | Description |
|---|---|---|
| POST | `/tasks` | `{title, teamId, description?, assigneeId?, priority?, dueDate?}` |
| GET | `/tasks` | List with filters (below) |
| GET | `/tasks/:id` | Task details |
| PATCH | `/tasks/:id` | Any of `title, description, status, priority, dueDate, assigneeId` (set `status: "completed"` to complete; `assigneeId` to reassign) |
| DELETE | `/tasks/:id` | Creator or team owner |
| POST | `/tasks/:id/summary` | AI summary of the task and its comments |

**List query params:** `status`, `priority`, `teamId`, `assignee` (`me` \| `unassigned` \| user id), `q` (title/description search), `dueBefore`, `dueAfter`, `sort` (`createdAt|updatedAt|dueDate|title|priority`), `order` (`asc|desc`), `page`, `limit` (max 100). Returns `{data, page, limit, total}`.

Examples: my open tasks — `GET /tasks?assignee=me&status=open`; search — `GET /tasks?q=invoice&sort=dueDate&order=asc`.

### Comments & attachments
| Method | Path | Description |
|---|---|---|
| GET / POST | `/tasks/:id/comments` | List / add `{body}` |
| DELETE | `/tasks/:id/comments/:commentId` | Author only |
| GET | `/tasks/:id/attachments` | List metadata |
| POST | `/tasks/:id/attachments` | `multipart/form-data`, field `file` |
| GET | `/tasks/:id/attachments/:attachmentId/download` | Download |
| DELETE | `/tasks/:id/attachments/:attachmentId` | Uploader or team owner |

### Notifications (real-time)
| Method | Path | Description |
|---|---|---|
| GET | `/notifications?unread=true` | Latest 100 |
| PATCH | `/notifications/:id/read` | Mark one read |
| POST | `/notifications/read-all` | Mark all read |
| GET | `/notifications/stream` | **Server-Sent Events**; emits `notification` events. Browsers' `EventSource` can't set headers, so this route also accepts `?token=<jwt>` |

Notifications fire when you are assigned a task, when a task you own/are assigned is updated or completed, on new comments/attachments, and when you are added to (or someone joins) a team.

```js
const es = new EventSource(`/api/notifications/stream?token=${token}`);
es.addEventListener('notification', (e) => console.log(JSON.parse(e.data)));
```

### Generative AI
| Method | Path | Description |
|---|---|---|
| POST | `/ai/task-description` | `{prompt}` (e.g. "fix login bug on mobile") → `{description, generated_by}` |
| POST | `/tasks/:id/summary` | `{summary, generated_by}` |

Uses the Anthropic Messages API when `ANTHROPIC_API_KEY` is set; otherwise `generated_by` is `"template"`.

## Quick walkthrough

```bash
curl -s localhost:3000/api/auth/register -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","password":"password123"}'
# export TOKEN=<token from response>
curl -s localhost:3000/api/teams -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"name":"Platform"}'
curl -s localhost:3000/api/tasks -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Ship v1","teamId":1,"dueDate":"2026-12-01"}'
```

## Project layout

```
src/
  app.js, server.js, config.js, db.js (schema), errors.js, utils.js
  middleware/  auth (JWT + revocation), validate (zod), error
  routes/      auth, users, teams, tasks, comments, attachments, notifications, ai
  services/    access (team authorization), notifications (persist + SSE), ai
test/          end-to-end API tests (node:test)
```

## Possible next steps

Refresh tokens, a shared rate-limit store, email invitations, pagination on comments, and swapping SQLite for Postgres (all SQL lives in the route files).
