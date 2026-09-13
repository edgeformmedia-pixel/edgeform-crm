import { json, HttpError, clean, now, addMinutes, readJson, randomToken, sha256, verifyPassword, isEmail } from './lib.js';

const SESSION_DAYS = 30;
const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

// owner = master admin; admins can invite members.
const ROLE_RANK = { member: 1, admin: 2, owner: 3 };
export const isAdmin = (user) => ROLE_RANK[user.role] >= ROLE_RANK.admin;
export const outranks = (user, role) => ROLE_RANK[user.role] > (ROLE_RANK[role] || 0);

export const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

export async function requireUser(request, env) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new HttpError(401, 'Unauthorized');
  const user = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.verified = 1`
  ).bind(await sha256(token), now()).first();
  if (!user) throw new HttpError(401, 'Unauthorized');
  return user;
}

export async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (!isAdmin(user)) throw new HttpError(403, 'Only admins can do that.');
  return user;
}

export async function createSession(env, user) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(user.id, now()),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), user.id, now(), expires)
  ]);
  return token;
}

const findUser = (env, email) => env.DB.prepare('SELECT * FROM users WHERE email = ? AND verified = 1').bind(email).first();

async function checkEmail(request, env, headers) {
  const email = clean((await readJson(request)).email, 254);
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  return json({ ok: true, exists: !!await findUser(env, email) }, 200, headers);
}

async function login(request, env, headers) {
  const body = await readJson(request);
  const user = await findUser(env, clean(body.email, 254));
  const password = String(body.password || '');
  if (!user) throw new HttpError(401, 'Incorrect email or password.');
  if (user.locked_until && user.locked_until > now()) {
    throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
  }
  if (!await verifyPassword(password, user.password_hash)) {
    const failed = user.failed_logins + 1;
    const locked = failed >= MAX_FAILED_LOGINS ? addMinutes(LOCK_MINUTES) : null;
    await env.DB.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
      .bind(locked ? 0 : failed, locked, user.id).run();
    throw new HttpError(401, 'Incorrect email or password.');
  }
  await env.DB.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(user.id).run();
  const token = await createSession(env, user);
  return json({ ok: true, token, name: user.name, email: user.email }, 200, headers);
}

async function me(request, env, headers) {
  const user = await requireUser(request, env);
  return json({ ok: true, user: publicUser(user) }, 200, headers);
}

async function logout(request, env, headers) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, headers);
}

export const authRoutes = {
  'POST /api/auth/check-email': checkEmail,
  'POST /api/auth/login': login,
  'GET /api/auth/me': me,
  'POST /api/auth/logout': logout
};
