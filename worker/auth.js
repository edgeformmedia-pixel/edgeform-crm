import {
  json, HttpError, clean, now, addMinutes, readJson, randomToken, randomCode,
  sha256, hashPassword, verifyPassword, timingSafeEqual, isEmail
} from './lib.js';
import { sendEmail } from './email.js';

const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

export function leadHunterUrl(request, user) {
  return `${new URL(request.url).origin}/api/leadhunter/${user.lead_key}`;
}

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

function signupAllowed(env, email) {
  const list = (env.SIGNUP_ALLOWLIST || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const lower = email.toLowerCase();
  return list.some(entry => entry.startsWith('@') ? lower.endsWith(entry) : lower === entry);
}

async function createSession(env, user) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(user.id, now()),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), user.id, now(), expires)
  ]);
  return token;
}

async function sendCode(env, user) {
  const existing = await env.DB.prepare('SELECT sent_at FROM verification_codes WHERE user_id = ?').bind(user.id).first();
  if (existing && Date.now() - Date.parse(existing.sent_at) < 45000) {
    throw new HttpError(429, 'Please wait a minute before requesting another code.');
  }
  const code = randomCode();
  await env.DB.prepare(
    `INSERT INTO verification_codes (user_id, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`
  ).bind(user.id, await sha256(`${user.id}:${code}`), addMinutes(CODE_MINUTES), now()).run();

  await sendEmail(env, {
    to: user.email,
    subject: `Your CRM verification code: ${code}`,
    text: `Your Edgeform CRM verification code is:\n\n${code}\n\nThis code expires in ${CODE_MINUTES} minutes.\n\nIf you did not request this, you can safely ignore this email.\n\n— Edgeform`
  });
}

const findUser = (env, email) => env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();

async function checkEmail(request, env, headers) {
  const email = clean((await readJson(request)).email, 254);
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  const user = await findUser(env, email);
  return json({ ok: true, exists: !!user?.verified }, 200, headers);
}

async function signup(request, env, headers) {
  const body = await readJson(request);
  const name = clean(body.name, 120);
  const email = clean(body.email, 254).toLowerCase();
  const password = String(body.password || '');
  if (!name) throw new HttpError(400, 'Enter your full name.');
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email.');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (password.length > 256) throw new HttpError(400, 'Password is too long.');
  if (!signupAllowed(env, email)) throw new HttpError(403, 'This email is not allowed to create a CRM account.');

  let user = await findUser(env, email);
  if (user?.verified) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');

  const passwordHash = await hashPassword(password);
  if (user) {
    await env.DB.prepare('UPDATE users SET name = ?, password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(name, passwordHash, now(), user.id).run();
    user = { ...user, name };
  } else {
    const { n } = await env.DB.prepare('SELECT COUNT(*) n FROM users WHERE verified = 1').first();
    user = { id: crypto.randomUUID(), email, name, role: n === 0 ? 'admin' : 'member' };
    await env.DB.prepare(
      `INSERT INTO users (id, created_at, updated_at, email, name, role, password_hash, verified, lead_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).bind(user.id, now(), now(), email, name, user.role, passwordHash, randomToken(18)).run();
  }
  await sendCode(env, user);
  return json({ ok: true }, 200, headers);
}

async function resend(request, env, headers) {
  const email = clean((await readJson(request)).email, 254);
  const user = await findUser(env, email);
  if (user && !user.verified) await sendCode(env, user);
  return json({ ok: true }, 200, headers);
}

async function verify(request, env, headers) {
  const body = await readJson(request);
  const user = await findUser(env, clean(body.email, 254));
  const code = clean(body.code, 6);
  const row = user && await env.DB.prepare('SELECT * FROM verification_codes WHERE user_id = ?').bind(user.id).first();
  if (!row || row.expires_at <= now() || row.attempts >= MAX_CODE_ATTEMPTS) {
    throw new HttpError(400, 'Invalid or expired code. Request a new one.');
  }
  if (!timingSafeEqual(await sha256(`${user.id}:${code}`), row.code_hash)) {
    await env.DB.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE user_id = ?').bind(user.id).run();
    throw new HttpError(400, 'Invalid or expired code.');
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET verified = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?').bind(now(), user.id),
    env.DB.prepare('DELETE FROM verification_codes WHERE user_id = ?').bind(user.id)
  ]);
  const token = await createSession(env, user);
  return json({ ok: true, token, name: user.name, email: user.email }, 200, headers);
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
  if (!user.verified) {
    await sendCode(env, user).catch(() => {});
    return json({ ok: false, needsVerification: true, error: 'Verify your email to finish signing up.' }, 200, headers);
  }
  const token = await createSession(env, user);
  return json({ ok: true, token, name: user.name, email: user.email }, 200, headers);
}

async function me(request, env, headers) {
  const user = await requireUser(request, env);
  return json({ ok: true, user: publicUser(user), leadhunter_url: leadHunterUrl(request, user) }, 200, headers);
}

async function logout(request, env, headers) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, headers);
}

export const authRoutes = {
  'POST /api/auth/check-email': checkEmail,
  'POST /api/auth/signup': signup,
  'POST /api/auth/resend': resend,
  'POST /api/auth/verify': verify,
  'POST /api/auth/login': login,
  'GET /api/auth/me': me,
  'POST /api/auth/logout': logout
};
