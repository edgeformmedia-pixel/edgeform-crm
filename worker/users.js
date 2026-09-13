import { json, HttpError, clean, now, readJson, randomToken, sha256, hashPassword, isEmail } from './lib.js';
import { requireAdmin, outranks, publicUser, createSession } from './auth.js';
import { sendEmail } from './email.js';

const INVITE_DAYS = 7;

async function listUsers(request, env, headers) {
  await requireAdmin(request, env);
  const [users, invites] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, email, role, created_at FROM users WHERE verified = 1
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name`),
    env.DB.prepare(`SELECT i.id, i.email, i.first_name, i.last_name, i.role, i.created_at, i.expires_at, u.name invited_by
      FROM invites i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`).bind(now())
  ]);
  return json({ ok: true, users: users.results, invites: invites.results }, 200, headers);
}

async function createInvite(request, env, headers) {
  const admin = await requireAdmin(request, env);
  const body = await readJson(request);
  const firstName = clean(body.firstName, 60);
  const lastName = clean(body.lastName, 60);
  const email = clean(body.email, 254).toLowerCase();
  const role = body.role === 'admin' ? 'admin' : 'member';
  if (!firstName || !lastName) throw new HttpError(400, 'Enter a first and last name.');
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email.');
  if (!outranks(admin, role)) throw new HttpError(403, 'Only the owner can invite admins.');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    throw new HttpError(409, 'That email already has an account.');
  }

  const token = randomToken(32);
  const invite = { id: crypto.randomUUID(), expires_at: new Date(Date.now() + INVITE_DAYS * 86400000).toISOString() };
  // A new invite replaces any outstanding one for the same email.
  await env.DB.batch([
    env.DB.prepare('UPDATE invites SET revoked_at = ? WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL').bind(now(), email),
    env.DB.prepare(`INSERT INTO invites (id, token_hash, created_at, expires_at, email, first_name, last_name, role, invited_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(invite.id, await sha256(token), now(), invite.expires_at, email, firstName, lastName, role, admin.id)
  ]);

  const link = `${env.APP_URL}/login/index.html?invite=${token}`;
  try {
    await sendEmail(env, {
      to: email,
      subject: `${admin.name} invited you to Edgeform CRM`,
      text: `Hi ${firstName},\n\n${admin.name} invited you to the Edgeform CRM.\n\nCreate your account here (this link works once and expires in ${INVITE_DAYS} days):\n${link}\n\nIf you weren't expecting this, you can ignore this email.\n\n— Edgeform`
    });
  } catch (error) {
    await env.DB.prepare('UPDATE invites SET revoked_at = ? WHERE id = ?').bind(now(), invite.id).run();
    throw error;
  }
  return json({ ok: true, id: invite.id }, 201, headers);
}

async function revokeInvite(request, env, headers, [id]) {
  await requireAdmin(request, env);
  const result = await env.DB.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL')
    .bind(now(), id).run();
  if (!result.meta.changes) throw new HttpError(404, 'Invite not found.');
  return json({ ok: true }, 200, headers);
}

async function removeUser(request, env, headers, [id]) {
  const admin = await requireAdmin(request, env);
  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(id).first();
  if (!target) throw new HttpError(404, 'User not found.');
  if (target.id === admin.id) throw new HttpError(400, "You can't remove yourself.");
  if (!outranks(admin, target.role)) throw new HttpError(403, "You can't remove someone at your level or above.");
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id)
  ]);
  return json({ ok: true }, 200, headers);
}

async function findInvite(env, token) {
  const invite = await env.DB.prepare('SELECT * FROM invites WHERE token_hash = ?').bind(await sha256(clean(token, 128))).first();
  if (!invite || invite.used_at || invite.revoked_at || invite.expires_at <= now()) {
    throw new HttpError(410, 'This invite link is invalid, already used, or expired. Ask your admin for a new one.');
  }
  return invite;
}

async function getInvite(request, env, headers, [token]) {
  const invite = await findInvite(env, token);
  return json({ ok: true, email: invite.email, firstName: invite.first_name, lastName: invite.last_name }, 200, headers);
}

async function acceptInvite(request, env, headers) {
  const body = await readJson(request);
  const invite = await findInvite(env, body.token);
  const password = String(body.password || '');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (password.length > 256) throw new HttpError(400, 'Password is too long.');

  // Claim the invite first so the link can't be used twice concurrently.
  const claim = await env.DB.prepare('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now(), invite.id).run();
  if (!claim.meta.changes) throw new HttpError(410, 'This invite link was already used.');

  const user = {
    id: crypto.randomUUID(), email: invite.email, name: `${invite.first_name} ${invite.last_name}`, role: invite.role
  };
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, created_at, updated_at, email, name, role, password_hash, verified, lead_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).bind(user.id, now(), now(), user.email, user.name, user.role, await hashPassword(password), randomToken(18)).run();
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) throw new HttpError(409, 'That email already has an account. Sign in instead.');
    throw error;
  }
  const token = await createSession(env, user);
  return json({ ok: true, token, ...publicUser(user) }, 201, headers);
}

export const userRoutes = {
  'GET /api/users': listUsers,
  'POST /api/users/invites': createInvite,
  'DELETE /api/users/invites/:id': revokeInvite,
  'DELETE /api/users/:id': removeUser,
  'GET /api/invites/:token': getInvite,
  'POST /api/invites/accept': acceptInvite
};
