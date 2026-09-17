import { json, HttpError, clean, now, readJson } from './lib.js';
import { requireUser } from './auth.js';

// Keeps the same action names and response shapes the dialer used with its
// Apps Script backend, so the page only swaps the transport.

const NUMBERS_LIST = 'NUMBERS';
const MAX_IMPORT_ROWS = 5000;
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

async function getList(env, user, name) {
  const list = await env.DB.prepare('SELECT * FROM dialer_lists WHERE owner_id = ? AND name = ?').bind(user.id, clean(name, 120)).first();
  if (!list) throw new HttpError(404, `List "${name}" not found.`);
  return list;
}

async function listTabs(env, user) {
  const lists = await env.DB.prepare(
    `SELECT l.id, l.name, (SELECT COUNT(*) FROM dialer_rows r WHERE r.list_id = l.id AND r.deleted = 0) count
     FROM dialer_lists l WHERE l.owner_id = ? ORDER BY l.updated_at DESC`
  ).bind(user.id).all();
  let numbers = [];
  const numberList = lists.results.find(l => l.name.toUpperCase() === NUMBERS_LIST);
  if (numberList) {
    const rows = await env.DB.prepare('SELECT cells FROM dialer_rows WHERE list_id = ? AND deleted = 0 ORDER BY row_idx').bind(numberList.id).all();
    numbers = rows.results
      .map(r => parse(r.cells, []).map(c => String(c).trim()).find(c => c.replace(/\D/g, '').length >= 10))
      .filter(Boolean)
      .map(n => ({ n: n.startsWith('+') ? n : `+1${n.replace(/\D/g, '').slice(-10)}` }));
  }
  return {
    fileName: 'Edgeform CRM',
    tabs: lists.results.filter(l => l !== numberList).map(l => ({ name: l.name, count: l.count })),
    numbers
  };
}

async function loadTab(env, user, { tab }) {
  const list = await getList(env, user, tab);
  const rows = await env.DB.prepare('SELECT cells, outcomes, deleted FROM dialer_rows WHERE list_id = ? ORDER BY row_idx').bind(list.id).all();
  const headers = parse(list.headers, []);
  return {
    headers,
    rows: rows.results.map(r => {
      const cells = parse(r.cells, []);
      while (cells.length < headers.length) cells.push('');
      return [...cells.slice(0, headers.length), ...parse(r.outcomes, []), ...(r.deleted ? ['DELETED'] : [])];
    })
  };
}

async function logOutcomes(env, user, { items }) {
  if (!Array.isArray(items)) throw new HttpError(400, 'Expected items.');
  const listIds = new Map();
  for (const item of items.slice(0, 50)) {
    const name = clean(item.tab, 120);
    if (!listIds.has(name)) listIds.set(name, (await getList(env, user, name).catch(() => null))?.id);
    const listId = listIds.get(name);
    if (!listId) continue;
    // json_insert appends to the stored array in one statement, so concurrent agents don't overwrite each other.
    await env.DB.prepare(`UPDATE dialer_rows SET outcomes = json_insert(outcomes, '$[#]', ?) WHERE list_id = ? AND row_idx = ?`)
      .bind(clean(item.outcome, 300), listId, Number(item.rowIdx)).run();
  }
  return {};
}

async function markDeleted(env, user, { tab, rowIdx }) {
  const list = await getList(env, user, tab);
  const result = await env.DB.prepare('UPDATE dialer_rows SET deleted = 1 WHERE list_id = ? AND row_idx = ?').bind(list.id, Number(rowIdx)).run();
  if (!result.meta.changes) throw new HttpError(404, 'Row not found.');
  return {};
}

async function upsertTracker(env, user, { items }) {
  if (!Array.isArray(items)) throw new HttpError(400, 'Expected items.');
  const valid = items.filter(i => /^\d{4}-\d{2}-\d{2}$/.test(i.date)).slice(0, 60);
  if (valid.length) {
    await env.DB.batch(valid.map(i => env.DB.prepare(
      `INSERT INTO dialer_tracker (user_id, day, dials, pickups, booked, ni, cb, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET dials = excluded.dials, pickups = excluded.pickups, booked = excluded.booked,
         ni = excluded.ni, cb = excluded.cb, updated_at = excluded.updated_at`
    ).bind(user.id, i.date, i.dials | 0, i.pickups | 0, i.booked | 0, i.ni | 0, i.cb | 0, now())));
  }
  return {};
}

async function importList(env, user, { name, headers, rows, replace }) {
  name = clean(name, 120);
  if (!name) throw new HttpError(400, 'List name is required.');
  if (!Array.isArray(headers) || !headers.length || !Array.isArray(rows)) throw new HttpError(400, 'Expected headers and rows.');
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(413, `Import at most ${MAX_IMPORT_ROWS} rows at a time.`);
  const cleanHeaders = headers.map(h => clean(h, 120));
  if (name.toUpperCase() !== NUMBERS_LIST && !cleanHeaders.some(h => h.toUpperCase() === 'NAME')) {
    throw new HttpError(400, 'The CSV must have a column named NAME.');
  }
  let list = await env.DB.prepare('SELECT * FROM dialer_lists WHERE owner_id = ? AND name = ?').bind(user.id, name).first();
  if (list && !replace) throw new HttpError(409, `A list named "${name}" already exists.`);
  if (list) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM dialer_rows WHERE list_id = ?').bind(list.id),
      env.DB.prepare('UPDATE dialer_lists SET headers = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(cleanHeaders), now(), list.id)
    ]);
  } else {
    list = { id: crypto.randomUUID() };
    await env.DB.prepare('INSERT INTO dialer_lists (id, created_at, updated_at, owner_id, name, headers) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(list.id, now(), now(), user.id, name, JSON.stringify(cleanHeaders)).run();
  }
  const stmt = env.DB.prepare('INSERT INTO dialer_rows (list_id, row_idx, cells, outcomes) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < rows.length; i += 100) {
    await env.DB.batch(rows.slice(i, i + 100).map((row, j) => {
      const cells = (Array.isArray(row) ? row : []).map(c => clean(c, 2000));
      // Columns past the headers were outcome history in the old sheets.
      return stmt.bind(list.id, i + j + 2, JSON.stringify(cells.slice(0, cleanHeaders.length)),
        JSON.stringify(cells.slice(cleanHeaders.length).filter(Boolean)));
    }));
  }
  return { name, count: rows.length };
}

async function deleteList(env, user, { name }) {
  const list = await getList(env, user, name);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM dialer_rows WHERE list_id = ?').bind(list.id),
    env.DB.prepare('DELETE FROM dialer_lists WHERE id = ?').bind(list.id)
  ]);
  return {};
}

// ── Caller-ID health ──────────────────────────────────────────────────────
// The dialer records one row per dial so it can score each caller ID the way
// carrier analytics engines do (volume, burst rate, short calls, answer rate)
// and stop handing out numbers that are about to get flagged.

const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_DIAL_EVENTS = 200;
const MAX_HEALTH_ROWS = 5000;

async function logDials(env, user, { items }) {
  if (!Array.isArray(items)) throw new HttpError(400, 'Expected items.');
  const rows = items.slice(0, MAX_DIAL_EVENTS)
    .filter(i => i && typeof i.id === 'string' && i.id.length <= 64 && i.callerId && Number.isFinite(Number(i.at)))
    .map(i => env.DB.prepare(
      `INSERT INTO dialer_number_calls (id, owner_id, caller_id, day, started_at, talk_sec, answered, agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET talk_sec = excluded.talk_sec, answered = excluded.answered`
    ).bind(
      clean(i.id, 64), user.id, clean(i.callerId, 24),
      /^\d{4}-\d{2}-\d{2}$/.test(i.day) ? i.day : new Date(Number(i.at)).toISOString().slice(0, 10),
      Math.round(Number(i.at)), Math.max(0, Math.min(86400, Number(i.talkSec) | 0)),
      i.answered ? 1 : 0, clean(i.agent, 60)
    ));
  if (rows.length) await env.DB.batch(rows);
  return { count: rows.length };
}

async function numberHealth(env, user) {
  const since = Date.now() - HEALTH_WINDOW_MS;
  const weekStart = Date.now() - 7 * HEALTH_WINDOW_MS;
  const [recent, week, rest] = await env.DB.batch([
    // Raw events for the scoring window, so the browser can compute gaps and
    // per-hour velocity exactly instead of re-deriving them from averages.
    env.DB.prepare(
      `SELECT id, caller_id, day, started_at, talk_sec, answered FROM dialer_number_calls
       WHERE owner_id = ? AND started_at >= ? ORDER BY started_at LIMIT ${MAX_HEALTH_ROWS}`
    ).bind(user.id, since),
    env.DB.prepare(
      `SELECT caller_id, COUNT(*) dials, SUM(answered) answered, SUM(talk_sec) talk_sec,
              SUM(CASE WHEN answered = 1 AND talk_sec < 6 THEN 1 ELSE 0 END) short_calls, COUNT(DISTINCT day) days
       FROM dialer_number_calls WHERE owner_id = ? AND started_at >= ? GROUP BY caller_id`
    ).bind(user.id, weekStart),
    env.DB.prepare('SELECT caller_id, resting_until, reason FROM dialer_number_rest WHERE owner_id = ?').bind(user.id)
  ]);
  return {
    asOf: Date.now(),
    // Short keys keep this payload small enough to poll while a shift is running.
    events: recent.results.map(r => ({ i: r.id, c: r.caller_id, d: r.day, a: r.started_at, t: r.talk_sec, s: r.answered })),
    week: week.results.map(r => ({
      callerId: r.caller_id, dials: r.dials, answered: r.answered,
      talkSec: r.talk_sec, shortCalls: r.short_calls, days: r.days
    })),
    rest: rest.results.map(r => ({ callerId: r.caller_id, until: r.resting_until, reason: r.reason }))
  };
}

async function restNumber(env, user, { callerId, until, reason }) {
  callerId = clean(callerId, 24);
  if (!callerId) throw new HttpError(400, 'callerId is required.');
  if (!until) {
    await env.DB.prepare('DELETE FROM dialer_number_rest WHERE owner_id = ? AND caller_id = ?').bind(user.id, callerId).run();
    return { callerId, until: null };
  }
  const restingUntil = new Date(until);
  if (isNaN(restingUntil)) throw new HttpError(400, 'until must be a timestamp.');
  await env.DB.prepare(
    `INSERT INTO dialer_number_rest (owner_id, caller_id, resting_until, reason, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, caller_id) DO UPDATE SET resting_until = excluded.resting_until,
       reason = excluded.reason, updated_at = excluded.updated_at`
  ).bind(user.id, callerId, restingUntil.toISOString(), clean(reason, 200), now()).run();
  return { callerId, until: restingUntil.toISOString() };
}

const ACTIONS = { listTabs, loadTab, logOutcomes, markDeleted, upsertTracker, importList, deleteList,
  logDials, numberHealth, restNumber };

async function dialer(request, env, headers) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const action = ACTIONS[body.action];
  if (!action) throw new HttpError(400, `Unknown dialer action: ${body.action}`);
  return json({ ok: true, ...(await action(env, user, body)) }, 200, headers);
}

export const dialerRoutes = { 'POST /api/dialer': dialer };
