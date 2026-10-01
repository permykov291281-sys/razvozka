// «Развозка» — веб-сервис диспетчера развозок. Node.js 18+, без внешних зависимостей.
// Данные: DATA_DIR/db.json, резервные копии: DATA_DIR/backups (храним 14 последних).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { seed } = require('./seed');

const PORT = process.env.PORT || 3000;
// На Amvera постоянное хранилище смонтировано в /data.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ---------- хранилище ----------
let db;
const newId = () => crypto.randomBytes(5).toString('hex');
const now = () => new Date().toISOString();
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}
function checkPassword(u, password) {
  const { hash } = hashPassword(password, u.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'));
}
function load() {
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  else { db = seed(hashPassword); saveNow(); }
}
let timer = null;
function saveNow() {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}
function save() { clearTimeout(timer); timer = setTimeout(saveNow, 150); }

// ---------- даты ----------
// Сервис работает по местному времени заказчика (Тюмень, UTC+5), а не по времени сервера.
const TZ_OFFSET = Number(process.env.TZ_OFFSET_HOURS || 5);
function localNow() { return new Date(Date.now() + TZ_OFFSET * 3600000); }
const todayStr = () => localNow().toISOString().slice(0, 10);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const weekday = (d) => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w === 0 ? 7 : w; }; // 1 = пн … 7 = вс
function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const DIR_RU = { to: 'на работу', from: 'с работы' };

// ---------- предметная логика ----------
const activeRoutesFor = (date) => db.routes.filter((r) => r.active && r.days.includes(weekday(date)));
function getPlan(date) {
  return db.plans[date] || { date, buses: [], closed: false };
}
function ensurePlan(date) {
  if (!db.plans[date]) db.plans[date] = { date, buses: [], closed: false, updatedAt: now() };
  return db.plans[date];
}
function unassigned(date) {
  const plan = getPlan(date);
  const used = new Set(plan.buses.flatMap((b) => b.routeIds));
  return activeRoutesFor(date).filter((r) => !used.has(r.id));
}
const routeLabel = (r) => `${r.client} — ${DIR_RU[r.direction]} — ${r.time}`;
function report(date) {
  const plan = getPlan(date);
  return plan.buses.map((pb, i) => {
    const bus = db.buses.find((b) => b.id === pb.busId);
    const driver = db.drivers.find((d) => d.id === pb.driverId);
    const routes = pb.routeIds.map((id) => db.routes.find((r) => r.id === id)).filter(Boolean).sort((a, b) => a.time.localeCompare(b.time));
    return `${bus ? bus.name : 'Автобус ' + (i + 1)} · ${bus ? bus.plate : ''}\nВодитель: ${driver ? driver.name : 'не назначен'}\n` +
      (routes.length ? routes.map((r) => `- ${routeLabel(r)}`).join('\n') : '- нет развозок');
  }).join('\n\n');
}
function log(type, text, userId = null) {
  db.log.unshift({ id: newId(), type, text, userId, at: now() });
  if (db.log.length > 500) db.log.length = 500;
}

// ---------- уведомления ----------
async function sendTelegram(text) {
  const s = db.settings;
  if (!s.telegramToken || !s.telegramChatId) return { ok: false, error: 'Не указан токен бота или ID чата' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${s.telegramToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: s.telegramChatId, text }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    return j.ok ? { ok: true } : { ok: false, error: j.description || 'Telegram ответил ошибкой ' + r.status };
  } catch (e) { return { ok: false, error: 'Нет связи с Telegram: ' + e.message }; }
}
function reminderText(date) {
  const left = unassigned(date);
  return `⚠️ Развозки на ${date.split('-').reverse().join('.')}: день не завершён, не назначено ${left.length}:\n` +
    left.map((r) => '• ' + routeLabel(r)).join('\n');
}
// Раз в минуту: в заданное время проверяем день планирования (сегодня или завтра).
async function reminderTick() {
  const s = db.settings;
  if (!s.notifyEnabled) return;
  const hm = localNow().toISOString().slice(11, 16);
  if (hm !== s.notifyTime) return;
  const date = s.notifyFor === 'today' ? todayStr() : addDays(todayStr(), 1);
  const key = `${date}@${s.notifyTime}`;
  if (s.lastNotifyKey === key) return;
  s.lastNotifyKey = key;
  const plan = getPlan(date);
  if (plan.closed || !unassigned(date).length) { log('check', `Проверка ${date}: всё назначено или день завершён — уведомление не нужно`); save(); return; }
  const text = reminderText(date);
  const res = await sendTelegram(text);
  log('reminder', `${text}${res.ok ? '\n(отправлено в Telegram)' : `\n(Telegram: ${res.error})`}`);
  save();
}

// ---------- ежедневная резервная копия ----------
function backupTick() {
  const name = `db-${todayStr()}.json`;
  const file = path.join(BACKUP_DIR, name);
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, JSON.stringify(db));
  const all = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('db-')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 14))) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

// ---------- HTTP ----------
function send(res, code, data, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}
const fail = (res, code, msg) => send(res, code, { error: msg });
function readBody(req, limit = 5e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
  });
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
function currentUser(req) {
  const s = db.sessions[cookies(req).rz_session];
  const u = s && db.users.find((x) => x.id === s.userId);
  return u && u.active ? u : null;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
function serveStatic(res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
}
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const pub = (u) => { const { hash, salt, ...r } = u; return r; };

// ---------- API ----------
async function api(req, res, parts, me) {
  const m = req.method;
  const [what, id, sub] = parts;
  const body = m === 'GET' ? {} : await readBody(req);
  const isAdmin = me && me.role === 'admin';

  if (what === 'login' && m === 'POST') {
    const u = db.users.find((x) => x.login === str(body.login).toLowerCase());
    if (!u || !checkPassword(u, String(body.password || ''))) return fail(res, 401, 'Неверный логин или пароль');
    if (!u.active) return fail(res, 403, 'Учётная запись отключена. Обратитесь к администратору');
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = { userId: u.id, at: now() };
    save();
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'Set-Cookie': `rz_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${secure}` });
  }
  if (what === 'logout' && m === 'POST') {
    delete db.sessions[cookies(req).rz_session]; save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'rz_session=; Path=/; Max-Age=0' });
  }
  if (!me) return fail(res, 401, 'Нужно войти');

  // общие данные для интерфейса
  if (what === 'bootstrap' && m === 'GET') {
    return send(res, 200, {
      me: pub(me), today: todayStr(),
      routes: db.routes, buses: db.buses, drivers: db.drivers,
      ...(isAdmin ? { users: db.users.map(pub), defaultPlan: db.defaultPlan, settings: { ...db.settings, telegramToken: db.settings.telegramToken ? '••••' + db.settings.telegramToken.slice(-4) : '' } } : {}),
    });
  }

  // ----- план на дату -----
  if (what === 'plan' && isDate(id)) {
    const date = id;
    if (m === 'GET') {
      return send(res, 200, { plan: getPlan(date), active: activeRoutesFor(date).map((r) => r.id), unassigned: unassigned(date).map((r) => r.id), report: report(date) });
    }
    const plan = ensurePlan(date);
    const reopen = sub === 'reopen';
    if (plan.closed && !reopen) return fail(res, 409, 'День завершён. Открыть его может только администратор');
    const busIn = (busId) => plan.buses.find((b) => b.busId === busId);
    const done = (text) => { plan.updatedAt = now(); plan.updatedBy = me.id; if (text) log('plan', `${date}: ${text}`, me.id); save(); return send(res, 200, { plan, unassigned: unassigned(date).map((r) => r.id), report: report(date) }); };

    if (sub === 'bus' && m === 'POST') {
      const bus = db.buses.find((b) => b.id === body.busId && b.active);
      if (!bus) return fail(res, 400, 'Выберите автобус');
      if (busIn(bus.id)) return fail(res, 400, 'Этот автобус уже в плане');
      plan.buses.push({ busId: bus.id, driverId: bus.defaultDriverId && db.drivers.some((d) => d.id === bus.defaultDriverId && d.active) && !plan.buses.some((b) => b.driverId === bus.defaultDriverId) ? bus.defaultDriverId : null, routeIds: [] });
      return done(`добавлен ${bus.name}`);
    }
    if (sub === 'bus' && m === 'DELETE') {
      const i = plan.buses.findIndex((b) => b.busId === body.busId);
      if (i < 0) return fail(res, 404, 'Автобуса нет в плане');
      plan.buses.splice(i, 1);
      return done('автобус убран из плана');
    }
    if (sub === 'driver' && m === 'POST') {
      const pb = busIn(body.busId);
      if (!pb) return fail(res, 404, 'Автобуса нет в плане');
      if (body.driverId && !db.drivers.some((d) => d.id === body.driverId && d.active)) return fail(res, 400, 'Водитель не найден или отключён');
      const busy = body.driverId && plan.buses.find((b) => b.driverId === body.driverId && b.busId !== body.busId);
      if (busy) return fail(res, 400, `Этот водитель уже назначен на ${db.buses.find((b) => b.id === busy.busId)?.name}`);
      pb.driverId = body.driverId || null;
      return done('смена водителя');
    }
    if (sub === 'assign' && m === 'POST') {
      const pb = busIn(body.busId);
      const route = db.routes.find((r) => r.id === body.routeId);
      if (!pb || !route) return fail(res, 400, 'Автобус или развозка не найдены');
      for (const b of plan.buses) b.routeIds = b.routeIds.filter((x) => x !== route.id); // развозка может быть только в одном автобусе
      pb.routeIds.push(route.id);
      return done(`${routeLabel(route)} → ${db.buses.find((b) => b.id === pb.busId)?.name}`);
    }
    if (sub === 'unassign' && m === 'POST') {
      for (const b of plan.buses) b.routeIds = b.routeIds.filter((x) => x !== body.routeId);
      return done('развозка снята с автобуса');
    }
    if (sub === 'default' && m === 'POST') {
      const active = new Set(activeRoutesFor(date).map((r) => r.id));
      plan.buses = db.defaultPlan
        .filter((d) => db.buses.some((b) => b.id === d.busId && b.active))
        .map((d) => ({ busId: d.busId, driverId: db.drivers.some((x) => x.id === d.driverId && x.active) ? d.driverId : null, routeIds: d.routeIds.filter((r) => active.has(r)) }));
      return done('применён план по умолчанию');
    }
    if (sub === 'copy' && m === 'POST') {
      if (!isDate(body.to) || body.to === date) return fail(res, 400, 'Выберите другую дату');
      const target = ensurePlan(body.to);
      if (target.closed) return fail(res, 409, 'Целевой день уже завершён');
      const active = new Set(activeRoutesFor(body.to).map((r) => r.id));
      const skipped = plan.buses.flatMap((b) => b.routeIds).filter((r) => !active.has(r)).length;
      target.buses = plan.buses.map((b) => ({ busId: b.busId, driverId: b.driverId, routeIds: b.routeIds.filter((r) => active.has(r)) }));
      target.updatedAt = now(); target.updatedBy = me.id;
      log('plan', `${date}: план скопирован на ${body.to}${skipped ? `, пропущено развозок не по расписанию: ${skipped}` : ''}`, me.id);
      save();
      return send(res, 200, { ok: true, skipped });
    }
    if (sub === 'close' && m === 'POST') {
      plan.closed = true; plan.closedAt = now(); plan.closedBy = me.id;
      const left = unassigned(date).length;
      return done(`день завершён${left ? ` (не назначено: ${left})` : ''}`);
    }
    if (reopen && m === 'POST') {
      if (!isAdmin) return fail(res, 403, 'Открыть завершённый день может только администратор');
      plan.closed = false; plan.reopenedAt = now();
      return done('день открыт администратором');
    }
  }

  if (!isAdmin) return fail(res, 403, 'Раздел доступен только администратору');

  // ----- справочники -----
  const DICTS = { routes: 'routes', buses: 'buses', drivers: 'drivers' };
  if (DICTS[what]) {
    const list = db[what];
    const item = id ? list.find((x) => x.id === id) : null;
    if (id && !item) return fail(res, 404, 'Запись не найдена');
    const data = validate(what, body, item);
    if (data.error) return fail(res, 400, data.error);
    if (m === 'POST' && !id) { const rec = { id: newId(), active: true, ...data }; list.push(rec); log('dict', `${titleOf(what)}: добавлено «${nameOf(what, rec)}»`, me.id); save(); return send(res, 200, rec); }
    if (m === 'PATCH' && item) { Object.assign(item, data); log('dict', `${titleOf(what)}: изменено «${nameOf(what, item)}»${data.active === false ? ' (отключено)' : data.active === true ? ' (включено)' : ''}`, me.id); save(); return send(res, 200, item); }
  }

  if (what === 'default-plan' && m === 'PUT') {
    if (!Array.isArray(body.buses)) return fail(res, 400, 'Неверные данные');
    const seen = new Set();
    db.defaultPlan = body.buses.filter((b) => db.buses.some((x) => x.id === b.busId)).map((b) => ({
      busId: b.busId,
      driverId: db.drivers.some((d) => d.id === b.driverId) ? b.driverId : null,
      routeIds: (b.routeIds || []).filter((r) => db.routes.some((x) => x.id === r) && !seen.has(r) && seen.add(r)),
    }));
    log('plan', 'изменён план по умолчанию', me.id); save();
    return send(res, 200, db.defaultPlan);
  }

  // ----- статистика -----
  if (what === 'stats' && m === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const from = isDate(q.get('from')) ? q.get('from') : addDays(todayStr(), -30);
    const to = isDate(q.get('to')) ? q.get('to') : todayStr();
    const onlyClosed = q.get('closed') === '1';
    const byBus = {}, byDriver = {}, byRoute = {};
    let days = 0, trips = 0;
    for (const [date, plan] of Object.entries(db.plans)) {
      if (date < from || date > to || (onlyClosed && !plan.closed)) continue;
      days++;
      for (const pb of plan.buses) for (const rid of pb.routeIds) {
        trips++;
        byBus[pb.busId] = (byBus[pb.busId] || 0) + 1;
        if (pb.driverId) byDriver[pb.driverId] = (byDriver[pb.driverId] || 0) + 1;
        const r = (byRoute[rid] = byRoute[rid] || { total: 0, buses: {} });
        r.total++; r.buses[pb.busId] = (r.buses[pb.busId] || 0) + 1;
      }
    }
    return send(res, 200, { from, to, days, trips, byBus, byDriver, byRoute });
  }

  // ----- пользователи -----
  if (what === 'users') {
    if (m === 'POST') {
      const login = str(body.login, 40).toLowerCase();
      if (!/^[a-z0-9._-]{3,40}$/.test(login)) return fail(res, 400, 'Логин: латиница, цифры, точка, дефис — от 3 символов');
      if (db.users.some((u) => u.login === login)) return fail(res, 400, 'Такой логин уже есть');
      if (!str(body.name)) return fail(res, 400, 'Укажите имя');
      if (String(body.password || '').length < 6) return fail(res, 400, 'Пароль — минимум 6 символов');
      const u = { id: newId(), login, name: str(body.name, 80), role: body.role === 'admin' ? 'admin' : 'dispatcher', active: true, createdAt: now(), ...hashPassword(String(body.password)) };
      db.users.push(u); log('users', `создан пользователь ${login}`, me.id); save();
      return send(res, 200, pub(u));
    }
    const u = db.users.find((x) => x.id === id);
    if (!u) return fail(res, 404, 'Пользователь не найден');
    if (m === 'PATCH') {
      if (u.id === me.id && (body.role === 'dispatcher' || body.active === false)) return fail(res, 400, 'Нельзя снять права или отключить самого себя');
      if (body.name !== undefined) u.name = str(body.name, 80) || u.name;
      if (body.role !== undefined) u.role = body.role === 'admin' ? 'admin' : 'dispatcher';
      if (body.active !== undefined) {
        u.active = !!body.active;
        if (!u.active) for (const [t, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[t];
      }
      if (body.password) {
        if (String(body.password).length < 6) return fail(res, 400, 'Пароль — минимум 6 символов');
        Object.assign(u, hashPassword(String(body.password)));
      }
      log('users', `изменён пользователь ${u.login}`, me.id); save();
      return send(res, 200, pub(u));
    }
  }

  // ----- уведомления -----
  if (what === 'settings' && m === 'PATCH') {
    const s = db.settings;
    if (body.notifyEnabled !== undefined) s.notifyEnabled = !!body.notifyEnabled;
    if (body.notifyTime !== undefined) { if (!/^\d{2}:\d{2}$/.test(body.notifyTime)) return fail(res, 400, 'Время в формате ЧЧ:ММ'); s.notifyTime = body.notifyTime; }
    if (body.notifyFor !== undefined) s.notifyFor = body.notifyFor === 'today' ? 'today' : 'tomorrow';
    if (body.telegramToken !== undefined && !String(body.telegramToken).startsWith('••••')) s.telegramToken = str(body.telegramToken, 100);
    if (body.telegramChatId !== undefined) s.telegramChatId = str(body.telegramChatId, 40);
    log('settings', 'изменены настройки уведомлений', me.id); save();
    return send(res, 200, { ok: true });
  }
  if (what === 'notify' && id === 'test' && m === 'POST') {
    const date = db.settings.notifyFor === 'today' ? todayStr() : addDays(todayStr(), 1);
    const text = unassigned(date).length && !getPlan(date).closed ? reminderText(date) : `✅ Проверка уведомлений «Развозка»: на ${date.split('-').reverse().join('.')} всё назначено.`;
    const r = await sendTelegram(text);
    log('reminder', `Тест: ${text}${r.ok ? '\n(отправлено в Telegram)' : `\n(Telegram: ${r.error})`}`, me.id); save();
    return send(res, 200, { ok: r.ok, error: r.error, text });
  }
  if (what === 'log' && m === 'GET') return send(res, 200, db.log.slice(0, 200));

  // ----- резервные копии -----
  if (what === 'backup' && m === 'GET' && !id) {
    const list = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('db-')).sort().reverse()
      .map((f) => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size }));
    return send(res, 200, list);
  }
  if (what === 'backup' && id === 'download' && m === 'GET') {
    const { sessions, ...data } = db;
    return send(res, 200, JSON.stringify(data, null, 1), { 'Content-Disposition': `attachment; filename="razvozka-backup-${todayStr()}.json"` });
  }
  if (what === 'backup' && id === 'restore' && m === 'POST') {
    const d = body.data;
    if (!d || !Array.isArray(d.users) || !Array.isArray(d.routes) || !Array.isArray(d.buses) || !d.plans) return fail(res, 400, 'Это не файл резервной копии «Развозки»');
    if (!d.users.some((u) => u.role === 'admin' && u.active)) return fail(res, 400, 'В копии нет активного администратора — восстановление отменено');
    fs.writeFileSync(path.join(BACKUP_DIR, `before-restore-${Date.now()}.json`), JSON.stringify(db));
    db = { ...d, sessions: db.sessions };
    log('backup', 'данные восстановлены из резервной копии', me.id); save();
    return send(res, 200, { ok: true });
  }

  return fail(res, 404, 'Не найдено');
}

const titleOf = (w) => ({ routes: 'Развозки', buses: 'Автобусы', drivers: 'Водители' }[w]);
const nameOf = (w, x) => (w === 'routes' ? routeLabel(x) : w === 'buses' ? `${x.name} · ${x.plate}` : x.name);
function validate(what, b, old) {
  const out = {};
  const need = (k) => b[k] !== undefined || !old;
  if (b.active !== undefined) out.active = !!b.active;
  if (what === 'routes') {
    if (need('client')) { out.client = str(b.client, 80); if (!out.client) return { error: 'Укажите заказчика / объект' }; }
    if (need('direction')) { if (!DIR_RU[b.direction]) return { error: 'Укажите направление' }; out.direction = b.direction; }
    if (need('time')) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '')) return { error: 'Время в формате ЧЧ:ММ' }; out.time = b.time; }
    if (need('days')) { const d = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter((x) => x >= 1 && x <= 7))].sort() : []; if (!d.length) return { error: 'Отметьте хотя бы один день недели' }; out.days = d; }
    if (b.address !== undefined || !old) out.address = str(b.address, 300);
  }
  if (what === 'buses') {
    if (need('name')) { out.name = str(b.name, 60); if (!out.name) return { error: 'Укажите название автобуса' }; }
    if (need('plate')) { out.plate = str(b.plate, 20).toUpperCase(); if (!out.plate) return { error: 'Укажите госномер' }; if (db.buses.some((x) => x.plate === out.plate && x !== old)) return { error: 'Автобус с таким номером уже есть' }; }
    if (b.seats !== undefined || !old) out.seats = Math.max(0, Math.min(200, parseInt(b.seats, 10) || 0));
    if (b.defaultDriverId !== undefined) out.defaultDriverId = db.drivers.some((d) => d.id === b.defaultDriverId) ? b.defaultDriverId : null;
  }
  if (what === 'drivers') {
    if (need('name')) { out.name = str(b.name, 80); if (!out.name) return { error: 'Укажите ФИО водителя' }; }
    if (b.phone !== undefined || !old) out.phone = str(b.phone, 30);
  }
  return out;
}

// ---------- запуск ----------
load();
backupTick();
setInterval(() => { reminderTick().catch((e) => console.error(e)); backupTick(); }, 60000);
http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (pathname === '/health') return send(res, 200, { ok: true });
    if (pathname.startsWith('/api/')) return await api(req, res, pathname.split('/').filter(Boolean).slice(1), currentUser(req));
    return serveStatic(res, pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'Ошибка сервера');
  }
}).listen(PORT, () => console.log(`Развозка: http://localhost:${PORT} (данные: ${DATA_DIR})`));
process.on('SIGTERM', () => { saveNow(); process.exit(0); });
