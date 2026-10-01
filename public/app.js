/* «Развозка» — интерфейс диспетчера (без фреймворков). */
(() => {
'use strict';

const DIR = { to: 'на работу', from: 'с работы' };
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WD_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const BUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 10h16M8 21v-3M16 21v-3"/><circle cx="8" cy="14" r=".6" fill="currentColor"/><circle cx="16" cy="14" r=".6" fill="currentColor"/></svg>';
const ICON = {
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

let S = null;          // справочники и пользователь
let P = null;          // план выбранной даты
const UI = { date: null, showOff: false, draft: null, draftDirty: false, stats: null, statsQ: null, log: null, backups: null };

// ---------- утилиты ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const weekday = (d) => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w === 0 ? 7 : w; };
const fmtDate = (d) => { const [y, m, day] = d.split('-').map(Number); return `${day} ${MONTHS[m - 1]}${y !== Number(S.today.slice(0, 4)) ? ' ' + y : ''}`; };
const fmtShort = (d) => d.split('-').reverse().join('.');
const fmtDT = (iso) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const route = (id) => S.routes.find((r) => r.id === id);
const bus = (id) => S.buses.find((b) => b.id === id);
const driver = (id) => S.drivers.find((d) => d.id === id);
const userName = (id) => (S.users || []).find((u) => u.id === id)?.name || (id === S.me.id ? S.me.name : 'диспетчер');
const isAdmin = () => S.me.role === 'admin';
const byTime = (a, b) => route(a).time.localeCompare(route(b).time);
const opts = (list, cur, empty) => (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') + list.map(([v, l, dis]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''} ${dis ? 'disabled' : ''}>${esc(l)}</option>`).join('');
const dirBadge = (r) => `<span class="badge ${r.direction === 'to' ? 'blue' : 'yellow'}">${DIR[r.direction]}</span>`;
const daysHtml = (days) => `<span class="days">${WD.map((w, i) => `<i class="${days.includes(i + 1) ? 'on' : ''}">${w}</i>`).join('')}</span>`;

function toast(msg, err) {
  const el = $('#toast'); el.textContent = msg; el.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.className = 'toast'), 2800);
}
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') { S = null; render(); throw new Error(data.error || 'Нужно войти'); }
  if (!r.ok) throw new Error(data.error || 'Ошибка ' + r.status);
  return data;
}
async function boot() {
  try { S = await api('GET', '/api/bootstrap'); } catch { S = null; }
  if (S && !UI.date) UI.date = S.today;
  await onRoute();
}
async function loadPlan() { P = await api('GET', '/api/plan/' + UI.date); }
async function planAct(sub, body, method = 'POST') {
  try { await api(method, `/api/plan/${UI.date}/${sub}`, body); await loadPlan(); render(); return true; }
  catch (e) { toast(e.message, true); await loadPlan(); render(); return false; }
}

// ---------- маршрутизация ----------
function current() {
  const [name, a] = (location.hash.replace(/^#\/?/, '') || 'plan').split('/');
  return { name, a };
}
async function onRoute() {
  if (!S) return render();
  const r = current();
  if (!isAdmin() && r.name !== 'plan') { location.hash = '#/plan'; return; }
  try {
    if (r.name === 'plan') { if (r.a && /^\d{4}-\d{2}-\d{2}$/.test(r.a)) UI.date = r.a; await loadPlan(); }
    if (r.name === 'default' && !UI.draft) { UI.draft = JSON.parse(JSON.stringify(S.defaultPlan)); UI.draftDirty = false; }
    if (r.name === 'stats') await loadStats();
    if (r.name === 'notify') UI.log = await api('GET', '/api/log');
    if (r.name === 'backup') UI.backups = await api('GET', '/api/backup');
  } catch (e) { toast(e.message, true); }
  render();
}
window.addEventListener('hashchange', onRoute);
const go = (h) => { if (location.hash === h) onRoute(); else location.hash = h; };

// ---------- отрисовка ----------
function render() {
  const app = $('#app');
  const f = document.activeElement?.id;
  if (!S) { app.innerHTML = loginView(); return; }
  const r = current();
  const nav = isAdmin()
    ? [['plan', 'Планирование'], ['default', 'План по умолчанию'], ['dicts', 'Справочники'], ['stats', 'Статистика'], ['notify', 'Уведомления'], ['users', 'Пользователи'], ['backup', 'Резервные копии']]
    : [['plan', 'Планирование']];
  let page = '';
  if (r.name === 'plan') page = planView();
  else if (r.name === 'default') page = defaultView();
  else if (r.name === 'dicts') page = dictsView(r.a || 'routes');
  else if (r.name === 'stats') page = statsView();
  else if (r.name === 'notify') page = notifyView();
  else if (r.name === 'users') page = usersView();
  else if (r.name === 'backup') page = backupView();
  app.innerHTML = `
    <header class="top">
      <div class="logo"><img src="/favicon.svg" alt="">Развозка</div>
      <nav class="nav">${nav.map(([h, l]) => `<a href="#/${h}${h === 'plan' ? '/' + UI.date : ''}" class="${r.name === h ? 'on' : ''}">${l}</a>`).join('')}</nav>
      <div class="me"><span class="name">${esc(S.me.name)} · ${isAdmin() ? 'администратор' : 'диспетчер'}</span><button class="btn sm" data-act="logout">Выйти</button></div>
    </header>
    <main class="content">${page}</main>`;
  if (f && document.getElementById(f)) document.getElementById(f).focus();
}

function loginView() {
  return `<div class="login"><div class="login-card">
    <div class="logo"><img src="/favicon.svg" alt="">Развозка</div>
    <p class="muted" style="margin:6px 0 0">Диспетчерская: план развозок на день</p>
    <form id="login-form">
      <label class="field"><span>Логин</span><input class="input" id="l-login" name="login" required autocomplete="username"></label>
      <label class="field"><span>Пароль</span><input class="input" id="l-pass" name="password" type="password" required autocomplete="current-password"></label>
      <div class="error" id="l-error"></div>
      <button class="btn primary">Войти</button>
    </form>
    <div class="demo"><b>Демо-доступ</b>, пароль: <code>razvozka</code><br>
      <button data-act="demo" data-login="admin">admin — администратор</button><br>
      <button data-act="demo" data-login="dispatcher">dispatcher — диспетчер</button></div>
  </div></div>`;
}

// ----- редактор плана (используется и для дня, и для плана по умолчанию) -----
function editor(model) {
  // model: { buses, poolIds, editable, kind }
  const busesIn = new Set(model.buses.map((b) => b.busId));
  const driverBus = {};
  model.buses.forEach((b) => { if (b.driverId) driverBus[b.driverId] = b.busId; });
  const freeBuses = S.buses.filter((b) => b.active && !busesIn.has(b.id));
  const pool = model.poolIds.slice().sort(byTime);

  const routeRow = (rid, inBus, conflict) => {
    const r = route(rid);
    const sel = !inBus && model.editable && model.buses.length
      ? `<select class="input" data-act-change="assign" data-route="${rid}" aria-label="Назначить на автобус">${opts(model.buses.map((b) => [b.busId, bus(b.busId)?.name]), '', 'В автобус…')}</select>` : '';
    return `<div class="route ${conflict ? 'conflict' : ''}" data-route="${rid}" data-drag="${model.editable ? 1 : ''}">
      <span class="time">${r.time}</span>
      <div class="info" title="${esc(r.address)}"><b>${esc(r.client)}</b><span class="dir-${r.direction}">${DIR[r.direction]}</span>${model.kind === 'default' ? ` ${daysHtml(r.days)}` : ''}${!inBus && r.address ? `<span class="addr">${esc(r.address)}</span>` : ''}</div>
      ${sel}
      ${inBus && model.editable ? `<button class="btn icon ghost" data-act="unassign" data-route="${rid}" title="Снять с автобуса" aria-label="Снять с автобуса">${ICON.x}</button>` : ''}
    </div>`;
  };

  const busCard = (pb) => {
    const b = bus(pb.busId);
    const ids = pb.routeIds.filter(route).slice().sort(byTime);
    const times = {};
    ids.forEach((id) => { const t = route(id).time; times[t] = (times[t] || 0) + 1; });
    const conflicts = Object.keys(times).filter((t) => times[t] > 1);
    const drivers = S.drivers.filter((d) => d.active || d.id === pb.driverId).map((d) => [d.id, d.name + (driverBus[d.id] && driverBus[d.id] !== pb.busId ? ` (${bus(driverBus[d.id])?.name})` : ''), driverBus[d.id] && driverBus[d.id] !== pb.busId]);
    return `<div class="card bus" data-bus="${pb.busId}">
      <div class="bus-head"><span class="bus-icon">${BUS_SVG}</span>
        <div class="t"><b>${esc(b?.name || 'Автобус удалён')}</b><span class="plate">${esc(b?.plate || '')}</span> <span class="small muted">${b?.seats ? b.seats + ' мест' : ''}</span></div>
        ${model.editable ? `<button class="btn icon ghost" data-act="remove-bus" data-bus="${pb.busId}" title="Убрать автобус из плана" aria-label="Убрать автобус">${ICON.x}</button>` : ''}
      </div>
      <div class="bus-driver ${pb.driverId ? '' : 'nodriver'}"><span class="small muted">Водитель</span>
        <select class="input" data-act-change="driver" data-bus="${pb.busId}" ${model.editable ? '' : 'disabled'} aria-label="Водитель">${opts(drivers, pb.driverId || '', '— не назначен —')}</select></div>
      <div class="bus-routes">
        ${ids.map((id) => routeRow(id, true, conflicts.includes(route(id).time))).join('') || '<div class="muted small">Перетащите сюда развозку или выберите ниже</div>'}
        ${conflicts.length ? `<div class="warn-text">Две развозки в одно время: ${conflicts.join(', ')}</div>` : ''}
        ${!pb.driverId ? '<div class="note-text">Не назначен водитель</div>' : ''}
      </div>
      ${model.editable && pool.length ? `<div class="bus-foot"><select class="input" data-act-change="assign-to" data-bus="${pb.busId}" aria-label="Добавить развозку">${opts(pool.map((id) => [id, `${route(id).time} · ${route(id).client} · ${DIR[route(id).direction]}`]), '', '+ Добавить развозку')}</select></div>` : ''}
    </div>`;
  };

  return `<div class="plan">
    <section class="card pool" data-pool="1">
      <div class="pool-head"><h2 style="flex:1">${model.kind === 'default' ? 'Не распределены' : 'Не назначены'}</h2><span class="badge ${pool.length ? 'red' : 'green'}">${pool.length}</span></div>
      <div class="pool-list">${pool.map((id) => routeRow(id, false)).join('') || `<div class="empty">✓ Все ${model.kind === 'default' ? 'развозки распределены' : 'развозки дня назначены'}</div>`}</div>
    </section>
    <section class="buses">
      ${model.buses.map(busCard).join('')}
      ${model.editable ? `<div class="add-bus">
        <b>Добавить автобус в план</b>
        ${freeBuses.length ? `<select class="input" id="add-bus-sel">${opts(freeBuses.map((b) => [b.id, `${b.name} · ${b.plate}`]), '', 'Выберите автобус')}</select>
        <button class="btn primary" data-act="add-bus">${ICON.plus} Добавить</button>` : '<span class="muted small">Все активные автобусы уже в плане</span>'}
      </div>` : ''}
      ${!model.buses.length && !model.editable ? '<div class="card empty">В этом дне не было автобусов</div>' : ''}
    </section>
  </div>`;
}

function planView() {
  const plan = P.plan;
  const closed = plan.closed;
  const total = P.active.length;
  const left = P.unassigned.length;
  const wd = WD_FULL[weekday(UI.date) - 1];
  const isToday = UI.date === S.today;
  const editable = !closed;
  return `
    <div class="page-head">
      <div class="grow"><h1>План развозок · ${fmtDate(UI.date)}</h1><div class="muted">${wd}${isToday ? ' · сегодня' : UI.date === addDays(S.today, 1) ? ' · завтра' : ''}</div></div>
      <div class="datebar">
        <button class="btn icon" data-act="day" data-d="-1" aria-label="Предыдущий день">‹</button>
        <input class="input" type="date" id="plan-date" value="${UI.date}" aria-label="Дата планирования">
        <button class="btn icon" data-act="day" data-d="1" aria-label="Следующий день">›</button>
        <button class="btn sm ${isToday ? 'primary' : ''}" data-act="date" data-v="${S.today}">Сегодня</button>
        <button class="btn sm ${UI.date === addDays(S.today, 1) ? 'primary' : ''}" data-act="date" data-v="${addDays(S.today, 1)}">Завтра</button>
      </div>
    </div>
    <div class="row" style="margin-bottom:14px">
      <button class="btn" data-act="apply-default" ${editable ? '' : 'disabled'}>Применить план по умолчанию</button>
      <button class="btn" data-act="copy-plan" ${plan.buses.length ? '' : 'disabled'}>${ICON.copy} Копировать на дату</button>
      <button class="btn" data-act="report">Текстовый отчёт</button>
      <span style="flex:1"></span>
      ${closed ? (isAdmin() ? '<button class="btn" data-act="reopen">Открыть день</button>' : '') : `<button class="btn yellow" data-act="close-day">${ICON.lock} Завершить день</button>`}
    </div>
    ${closed ? `<div class="banner closed">${ICON.lock.replace('<svg', '<svg width="18" height="18"')} День завершён ${plan.closedAt ? fmtDT(plan.closedAt) : ''}${plan.closedBy ? ' · ' + esc(userName(plan.closedBy)) : ''}. Изменения недоступны${isAdmin() ? ' — откройте день, если нужно поправить' : ', открыть день может администратор'}.</div>`
      : !plan.buses.length ? `<div class="banner warn">План на этот день пуст. Нажмите «Применить план по умолчанию» — автобусы, водители и развозки этого дня недели расставятся сами, — или добавьте автобусы вручную справа.</div>`
      : left ? `<div class="banner warn">Не назначено развозок: ${left}. Перетащите их на автобусы или выберите автобус в списке слева.</div>` : ''}
    <div class="summary">
      <div class="card"><span class="muted small">Активных развозок</span><b>${total}</b></div>
      <div class="card ok"><span class="muted small">Назначено</span><b>${total - left}</b></div>
      <div class="card ${left ? 'warn' : 'ok'}"><span class="muted small">Не назначено</span><b>${left}</b></div>
      <div class="card"><span class="muted small">Автобусов в плане</span><b>${plan.buses.length}</b></div>
    </div>
    ${editor({ buses: plan.buses, poolIds: P.unassigned, editable, kind: 'day' })}`;
}

function defaultView() {
  const d = UI.draft;
  const used = new Set(d.flatMap((b) => b.routeIds));
  const pool = S.routes.filter((r) => r.active && !used.has(r.id)).map((r) => r.id);
  return `
    <div class="page-head"><div class="grow"><h1>План по умолчанию</h1><div class="muted">Типовое распределение автобусов, водителей и развозок. При применении к дате попадут только развозки, которые ходят в этот день недели.</div></div>
      ${UI.draftDirty ? '<span class="badge yellow">Есть несохранённые изменения</span>' : ''}
      <button class="btn" data-act="draft-reset" ${UI.draftDirty ? '' : 'disabled'}>Отменить</button>
      <button class="btn primary" data-act="draft-save" ${UI.draftDirty ? '' : 'disabled'}>Сохранить план</button></div>
    ${editor({ buses: d, poolIds: pool, editable: true, kind: 'default' })}`;
}

// ----- справочники -----
function dictsView(tab) {
  const tabs = [['routes', 'Развозки'], ['buses', 'Автобусы'], ['drivers', 'Водители']];
  const list = S[tab].filter((x) => UI.showOff || x.active);
  const off = S[tab].filter((x) => !x.active).length;
  let head = '', rows = '';
  const sw = (x) => `<button class="switch ${x.active ? 'on' : ''}" data-act="toggle" data-kind="${tab}" data-id="${x.id}" title="${x.active ? 'Отключить' : 'Включить'}" aria-label="Активность"></button>`;
  const ed = (x) => `<button class="btn sm" data-act="edit" data-kind="${tab}" data-id="${x.id}">Изменить</button>`;
  if (tab === 'routes') {
    head = '<th>Заказчик / объект</th><th>Направление</th><th>Время</th><th>Дни</th><th>Адрес / описание</th><th>Активна</th><th></th>';
    rows = list.slice().sort((a, b) => a.client.localeCompare(b.client) || a.time.localeCompare(b.time)).map((r) => `<tr class="${r.active ? '' : 'off'}"><td><b>${esc(r.client)}</b></td><td>${dirBadge(r)}</td><td class="mono"><b>${r.time}</b></td><td>${daysHtml(r.days)}</td><td class="small">${esc(r.address)}</td><td>${sw(r)}</td><td>${ed(r)}</td></tr>`).join('');
  } else if (tab === 'buses') {
    head = '<th>Название</th><th>Госномер</th><th>Мест</th><th>Водитель по умолчанию</th><th>Активен</th><th></th>';
    rows = list.map((b) => `<tr class="${b.active ? '' : 'off'}"><td><b>${esc(b.name)}</b></td><td><span class="plate">${esc(b.plate)}</span></td><td>${b.seats || '—'}</td><td>${esc(driver(b.defaultDriverId)?.name || '—')}</td><td>${sw(b)}</td><td>${ed(b)}</td></tr>`).join('');
  } else {
    head = '<th>ФИО</th><th>Телефон</th><th>Автобус по умолчанию</th><th>Активен</th><th></th>';
    rows = list.map((d) => `<tr class="${d.active ? '' : 'off'}"><td><b>${esc(d.name)}</b></td><td>${esc(d.phone || '—')}</td><td>${esc(S.buses.filter((b) => b.defaultDriverId === d.id).map((b) => b.name).join(', ') || '—')}</td><td>${sw(d)}</td><td>${ed(d)}</td></tr>`).join('');
  }
  return `
    <div class="page-head"><h1 class="grow">Справочники</h1>
      <label class="check"><input type="checkbox" data-act="show-off" ${UI.showOff ? 'checked' : ''}> Показать отключённые (${off})</label>
      <button class="btn primary" data-act="add" data-kind="${tab}">${ICON.plus} Добавить</button></div>
    <div class="tabs">${tabs.map(([t, l]) => `<a href="#/dicts/${t}" class="${t === tab ? 'on' : ''}">${l} · ${S[t].filter((x) => x.active).length}</a>`).join('')}</div>
    <div class="card table-wrap"><table class="table"><thead><tr>${head}</tr></thead><tbody>${rows || `<tr><td colspan="7" class="empty">Пусто</td></tr>`}</tbody></table></div>
    <p class="muted small">Записи не удаляются, а отключаются — так сохраняется история и статистика прошлых дней.</p>`;
}

// ----- статистика -----
async function loadStats() {
  const q = UI.statsQ || (UI.statsQ = { from: addDays(S.today, -30), to: S.today, closed: true });
  UI.stats = await api('GET', `/api/stats?from=${q.from}&to=${q.to}&closed=${q.closed ? 1 : 0}`);
}
function bars(obj, nameFn, cls = '') {
  const items = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...items.map((x) => x[1]));
  return items.map(([id, n]) => `<div class="barrow"><span>${esc(nameFn(id))}</span><div class="bar ${cls}"><i style="width:${(n / max) * 100}%"></i></div><b class="mono" style="text-align:right">${n}</b></div>`).join('') || '<div class="empty">Нет данных за период</div>';
}
function statsView() {
  const s = UI.stats, q = UI.statsQ;
  const routesRows = Object.entries(s.byRoute).sort((a, b) => b[1].total - a[1].total).map(([rid, v]) => {
    const r = route(rid);
    return `<tr><td><b>${esc(r ? r.client : 'удалена')}</b> ${r ? dirBadge(r) : ''}</td><td class="mono">${r ? r.time : ''}</td><td class="mono"><b>${v.total}</b></td><td class="small">${Object.entries(v.buses).sort((a, b) => b[1] - a[1]).map(([b, n]) => `${esc(bus(b)?.name || '—')}: ${n}`).join(' · ')}</td></tr>`;
  }).join('');
  return `
    <div class="page-head"><h1 class="grow">Статистика выездов</h1></div>
    <div class="card pad row" style="margin-bottom:16px">
      <label class="field"><span>С</span><input class="input" type="date" id="st-from" value="${q.from}"></label>
      <label class="field"><span>По</span><input class="input" type="date" id="st-to" value="${q.to}"></label>
      <div class="field"><span>Быстро</span><div class="row">
        <button class="btn sm" data-act="st-range" data-r="7">7 дней</button>
        <button class="btn sm" data-act="st-range" data-r="30">30 дней</button>
        <button class="btn sm" data-act="st-range" data-r="month">Этот месяц</button></div></div>
      <label class="check" style="align-self:flex-end;margin-bottom:8px"><input type="checkbox" id="st-closed" ${q.closed ? 'checked' : ''}> Только завершённые дни</label>
      <button class="btn primary" data-act="st-apply" style="align-self:flex-end">Показать</button>
    </div>
    <div class="summary">
      <div class="card"><span class="muted small">Дней в периоде с планом</span><b>${s.days}</b></div>
      <div class="card"><span class="muted small">Всего выездов</span><b>${s.trips}</b></div>
      <div class="card"><span class="muted small">В среднем за день</span><b>${s.days ? (s.trips / s.days).toFixed(1) : 0}</b></div>
      <div class="card"><span class="muted small">Период</span><b style="font-size:16px">${fmtShort(s.from)} — ${fmtShort(s.to)}</b></div>
    </div>
    <div class="stats-grid">
      <section class="card pad"><h2 style="margin-bottom:8px">Выезды по автобусам</h2>${bars(s.byBus, (id) => bus(id) ? `${bus(id).name} · ${bus(id).plate}` : '—')}</section>
      <section class="card pad"><h2 style="margin-bottom:8px">Выезды по водителям</h2>${bars(s.byDriver, (id) => driver(id)?.name || '—', 'y')}</section>
    </div>
    <section class="card table-wrap" style="margin-top:16px"><div class="pad" style="padding-bottom:0"><h2>По развозкам</h2></div>
      <table class="table"><thead><tr><th>Развозка</th><th>Время</th><th>Выездов</th><th>Какие автобусы возили</th></tr></thead><tbody>${routesRows || '<tr><td colspan="4" class="empty">Нет данных за период</td></tr>'}</tbody></table></section>`;
}

// ----- уведомления -----
function notifyView() {
  const s = S.settings;
  return `
    <div class="page-head"><h1 class="grow">Уведомления</h1></div>
    <div class="stats-grid">
      <section class="card pad">
        <h2>Напоминание диспетчеру</h2>
        <p class="muted">Если день не завершён и есть неназначенные активные развозки — в заданное время приходит сообщение в Telegram со списком.</p>
        <form id="settings-form" style="display:flex;flex-direction:column;gap:12px">
          <label class="check"><input type="checkbox" name="notifyEnabled" ${s.notifyEnabled ? 'checked' : ''}> Напоминания включены</label>
          <div class="grid2">
            <label class="field"><span>Время проверки</span><input class="input" type="time" name="notifyTime" value="${s.notifyTime}" required></label>
            <label class="field"><span>Какой день проверять</span><select class="input" name="notifyFor">${opts([['tomorrow', 'Завтрашний'], ['today', 'Сегодняшний']], s.notifyFor)}</select></label>
          </div>
          <label class="field"><span>Токен Telegram-бота</span><input class="input" name="telegramToken" value="${esc(s.telegramToken)}" placeholder="123456:ABC… — выдаёт @BotFather" autocomplete="off"></label>
          <label class="field"><span>ID чата или группы</span><input class="input" name="telegramChatId" value="${esc(s.telegramChatId)}" placeholder="например, -1001234567890"></label>
          <p class="small muted" style="margin:0">Как подключить: создайте бота у @BotFather и скопируйте токен; добавьте бота в чат диспетчеров; ID чата покажет бот @getmyid_bot. Позже можно добавить MAX или почту.</p>
          <div class="row"><button class="btn primary">Сохранить</button><button type="button" class="btn" data-act="notify-test">Проверить сейчас</button></div>
        </form>
      </section>
      <section class="card"><div class="pad" style="padding-bottom:8px"><h2>Журнал</h2><span class="muted small">Напоминания и действия с планами</span></div>
        <div style="max-height:520px;overflow:auto">${(UI.log || []).map((l) => `<div class="log-item"><span class="small muted mono" style="min-width:80px">${fmtDT(l.at)}</span><div class="txt small">${esc(l.text)}${l.userId ? ` <span class="muted">— ${esc(userName(l.userId))}</span>` : ''}</div></div>`).join('') || '<div class="empty">Пусто</div>'}</div>
      </section>
    </div>`;
}

// ----- пользователи -----
function usersView() {
  return `
    <div class="page-head"><h1 class="grow">Пользователи</h1><button class="btn primary" data-act="user-new">${ICON.plus} Добавить пользователя</button></div>
    <div class="card table-wrap"><table class="table"><thead><tr><th>Имя</th><th>Логин</th><th>Роль</th><th>Активен</th><th></th></tr></thead><tbody>
    ${S.users.map((u) => `<tr class="${u.active ? '' : 'off'}"><td><b>${esc(u.name)}</b>${u.id === S.me.id ? ' <span class="badge blue">это вы</span>' : ''}</td><td class="mono">${esc(u.login)}</td>
      <td><select class="input" data-act-change="user-role" data-id="${u.id}" ${u.id === S.me.id ? 'disabled' : ''} style="height:32px">${opts([['admin', 'Администратор'], ['dispatcher', 'Диспетчер']], u.role)}</select></td>
      <td><button class="switch ${u.active ? 'on' : ''}" data-act="user-toggle" data-id="${u.id}" ${u.id === S.me.id ? 'disabled' : ''} aria-label="Активность"></button></td>
      <td><button class="btn sm" data-act="user-pass" data-id="${u.id}">Сменить пароль</button></td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted small">Диспетчер видит только планирование. Отключённый пользователь не может войти, его действия в истории сохраняются.</p>`;
}

// ----- резервные копии -----
function backupView() {
  return `
    <div class="page-head"><h1 class="grow">Резервные копии</h1></div>
    <div class="stats-grid">
      <section class="card pad"><h2>Скачать копию сейчас</h2>
        <p class="muted">Файл со всеми данными: справочники, планы, пользователи, настройки. Храните его у себя.</p>
        <a class="btn primary" href="/api/backup/download" download>Скачать резервную копию</a>
        <h2 style="margin-top:22px">Восстановить из файла</h2>
        <p class="muted">Текущие данные будут заменены данными из файла. Перед восстановлением сервис сам сохранит копию текущего состояния.</p>
        <label class="btn">Выбрать файл .json<input type="file" id="restore-file" accept=".json,application/json" hidden></label>
      </section>
      <section class="card"><div class="pad" style="padding-bottom:6px"><h2>Автоматические копии</h2><span class="muted small">Создаются каждый день, хранятся последние 14</span></div>
        <table class="table"><tbody>${(UI.backups || []).map((b) => `<tr><td class="mono">${esc(b.name)}</td><td class="muted small">${Math.round(b.size / 1024)} КБ</td></tr>`).join('') || '<tr><td class="empty">Пока нет</td></tr>'}</tbody></table>
      </section>
    </div>`;
}

// ---------- модальные окна ----------
function modal(title, body, foot, id) {
  closeModal();
  const w = document.createElement('div');
  w.className = 'modal-wrap'; w.id = 'modal';
  w.innerHTML = `<form class="modal" id="${id}" novalidate><div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="btn icon ghost" data-act="modal-close" aria-label="Закрыть">${ICON.x}</button></div>
    <div class="modal-body">${body}<div class="error" id="m-error"></div></div><div class="modal-foot">${foot}</div></form>`;
  document.body.appendChild(w);
  w.querySelector('input:not([type=hidden]):not([type=checkbox]),select,textarea')?.focus();
}
const closeModal = () => $('#modal')?.remove();
const mErr = (m) => { const e = $('#m-error'); if (e) e.textContent = m; };
const FOOT = (ok) => `<button type="button" class="btn" data-act="modal-close">Отмена</button><button class="btn primary">${ok}</button>`;

function dictForm(kind, id) {
  const x = id ? S[kind].find((r) => r.id === id) : null;
  let body = '';
  if (kind === 'routes') {
    body = `<label class="field"><span>Заказчик / объект <b>*</b></span><input class="input" name="client" value="${esc(x?.client)}" placeholder="Газпром"></label>
      <div class="grid2"><label class="field"><span>Направление <b>*</b></span><select class="input" name="direction">${opts([['to', 'На работу'], ['from', 'С работы']], x?.direction || 'to')}</select></label>
      <label class="field"><span>Время <b>*</b></span><input class="input" type="time" name="time" value="${esc(x?.time || '08:00')}"></label></div>
      <div class="field"><span>Дни недели <b>*</b></span><div class="daypick">${WD.map((w, i) => `<label><input type="checkbox" name="days" value="${i + 1}" ${(x ? x.days : [1, 2, 3, 4, 5]).includes(i + 1) ? 'checked' : ''}>${w}</label>`).join('')}</div></div>
      <label class="field"><span>Адрес / описание маршрута</span><textarea class="input" name="address" rows="2">${esc(x?.address)}</textarea></label>`;
  } else if (kind === 'buses') {
    body = `<div class="grid2"><label class="field"><span>Название <b>*</b></span><input class="input" name="name" value="${esc(x?.name)}" placeholder="Автобус 7"></label>
      <label class="field"><span>Госномер <b>*</b></span><input class="input" name="plate" value="${esc(x?.plate)}" placeholder="А123ВС72"></label>
      <label class="field"><span>Мест</span><input class="input" type="number" min="0" max="200" name="seats" value="${esc(x?.seats ?? '')}"></label>
      <label class="field"><span>Водитель по умолчанию</span><select class="input" name="defaultDriverId">${opts(S.drivers.filter((d) => d.active).map((d) => [d.id, d.name]), x?.defaultDriverId || '', '— нет —')}</select></label></div>`;
  } else {
    body = `<label class="field"><span>ФИО <b>*</b></span><input class="input" name="name" value="${esc(x?.name)}"></label>
      <label class="field"><span>Телефон</span><input class="input" name="phone" value="${esc(x?.phone)}" placeholder="+7 …"></label>`;
  }
  const t = { routes: 'развозку', buses: 'автобус', drivers: 'водителя' }[kind];
  modal(x ? `Изменить ${t}` : `Добавить ${t}`, body, FOOT(x ? 'Сохранить' : 'Добавить'), 'dict-form');
  Object.assign($('#dict-form').dataset, { kind, id: id || '' });
}

// ---------- изменения ----------
async function reloadS() { S = await api('GET', '/api/bootstrap'); }
function draftBus(busId) { return UI.draft.find((b) => b.busId === busId); }
function draftChange(fn) { fn(); UI.draftDirty = true; render(); }

async function assign(routeId, busId) {
  if (current().name === 'default') return draftChange(() => { UI.draft.forEach((b) => (b.routeIds = b.routeIds.filter((r) => r !== routeId))); draftBus(busId).routeIds.push(routeId); });
  return planAct('assign', { busId, routeId });
}
async function unassign(routeId) {
  if (current().name === 'default') return draftChange(() => UI.draft.forEach((b) => (b.routeIds = b.routeIds.filter((r) => r !== routeId))));
  return planAct('unassign', { routeId });
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || drag.suppress) { drag.suppress = false; return; }
  const a = el.dataset.act;
  const isDefault = current().name === 'default';
  switch (a) {
    case 'demo': $('#l-login').value = el.dataset.login; $('#l-pass').value = 'razvozka'; break;
    case 'logout': await api('POST', '/api/logout').catch(() => {}); S = null; P = null; UI.draft = null; location.hash = ''; render(); break;
    case 'day': go(`#/plan/${addDays(UI.date, Number(el.dataset.d))}`); break;
    case 'date': go(`#/plan/${el.dataset.v}`); break;
    case 'add-bus': {
      const id = $('#add-bus-sel').value;
      if (!id) return toast('Выберите автобус', true);
      if (isDefault) return draftChange(() => UI.draft.push({ busId: id, driverId: bus(id).defaultDriverId && !UI.draft.some((b) => b.driverId === bus(id).defaultDriverId) ? bus(id).defaultDriverId : null, routeIds: [] }));
      await planAct('bus', { busId: id }); break;
    }
    case 'remove-bus': {
      const b = bus(el.dataset.bus);
      const n = (isDefault ? draftBus(el.dataset.bus) : P.plan.buses.find((x) => x.busId === el.dataset.bus)).routeIds.length;
      if (n && !confirm(`Убрать ${b.name} из плана? Его развозки (${n}) вернутся в список неназначенных.`)) return;
      if (isDefault) return draftChange(() => (UI.draft = UI.draft.filter((x) => x.busId !== el.dataset.bus)));
      await planAct('bus', { busId: el.dataset.bus }, 'DELETE'); break;
    }
    case 'unassign': await unassign(el.dataset.route); break;
    case 'apply-default':
      if (P.plan.buses.length && !confirm('Текущий план на этот день будет заменён планом по умолчанию. Продолжить?')) return;
      if (await planAct('default')) toast('План по умолчанию применён');
      break;
    case 'copy-plan':
      modal('Копировать план на другую дату', `<p class="muted" style="margin:0">План ${fmtDate(UI.date)} будет скопирован на выбранную дату и заменит её план. Развозки, которые в тот день не ходят, будут пропущены.</p>
        <label class="field"><span>Дата</span><input class="input" type="date" name="to" value="${addDays(UI.date, 1)}"></label>`, FOOT('Копировать'), 'copy-form');
      break;
    case 'report':
      modal(`Отчёт · ${fmtDate(UI.date)}`, `<textarea class="input report" id="report-text" readonly>${esc(P.report || 'План пуст')}</textarea>`,
        `<button type="button" class="btn" data-act="modal-close">Закрыть</button><button type="button" class="btn primary" data-act="report-copy">${ICON.copy} Скопировать</button>`, 'report-form');
      break;
    case 'report-copy': {
      const t = $('#report-text');
      try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand('copy'); }
      toast('Отчёт скопирован — вставьте его в мессенджер'); break;
    }
    case 'close-day': {
      const left = P.unassigned.length;
      const nod = P.plan.buses.filter((b) => !b.driverId).length;
      const warn = [left ? `не назначено развозок: ${left}` : '', nod ? `автобусов без водителя: ${nod}` : ''].filter(Boolean).join(', ');
      if (!confirm(warn ? `Внимание: ${warn}. Всё равно завершить день?` : `Завершить день ${fmtDate(UI.date)}? После этого план нельзя будет случайно изменить.`)) return;
      if (await planAct('close')) toast('День завершён');
      break;
    }
    case 'reopen': if (await planAct('reopen')) toast('День открыт для изменений'); break;
    case 'draft-reset': UI.draft = JSON.parse(JSON.stringify(S.defaultPlan)); UI.draftDirty = false; render(); break;
    case 'draft-save':
      try { S.defaultPlan = await api('PUT', '/api/default-plan', { buses: UI.draft }); UI.draft = JSON.parse(JSON.stringify(S.defaultPlan)); UI.draftDirty = false; render(); toast('План по умолчанию сохранён'); } catch (err) { toast(err.message, true); }
      break;
    case 'show-off': UI.showOff = el.checked; render(); break;
    case 'add': dictForm(el.dataset.kind); break;
    case 'edit': dictForm(el.dataset.kind, el.dataset.id); break;
    case 'toggle': {
      const x = S[el.dataset.kind].find((r) => r.id === el.dataset.id);
      try { await api('PATCH', `/api/${el.dataset.kind}/${x.id}`, { active: !x.active }); await reloadS(); render(); toast(x.active ? 'Запись отключена' : 'Запись включена'); } catch (err) { toast(err.message, true); }
      break;
    }
    case 'st-range': {
      const r = el.dataset.r;
      $('#st-to').value = S.today;
      $('#st-from').value = r === 'month' ? S.today.slice(0, 8) + '01' : addDays(S.today, -Number(r) + 1);
      $('[data-act=st-apply]').click(); break;
    }
    case 'st-apply':
      UI.statsQ = { from: $('#st-from').value, to: $('#st-to').value, closed: $('#st-closed').checked };
      if (UI.statsQ.from > UI.statsQ.to) return toast('Дата «С» позже даты «По»', true);
      try { await loadStats(); render(); } catch (err) { toast(err.message, true); }
      break;
    case 'notify-test':
      try {
        const r = await api('POST', '/api/notify/test');
        toast(r.ok ? 'Сообщение отправлено в Telegram' : `Не отправлено: ${r.error}`, !r.ok);
        UI.log = await api('GET', '/api/log'); render();
      } catch (err) { toast(err.message, true); }
      break;
    case 'user-new':
      modal('Новый пользователь', `<label class="field"><span>Имя <b>*</b></span><input class="input" name="name"></label>
        <div class="grid2"><label class="field"><span>Логин <b>*</b></span><input class="input" name="login" autocomplete="off" placeholder="latinica"></label>
        <label class="field"><span>Роль</span><select class="input" name="role">${opts([['dispatcher', 'Диспетчер'], ['admin', 'Администратор']], 'dispatcher')}</select></label></div>
        <label class="field"><span>Пароль <b>*</b></span><input class="input" name="password" autocomplete="new-password" placeholder="минимум 6 символов"></label>`, FOOT('Создать'), 'user-form');
      break;
    case 'user-pass':
      modal('Сменить пароль', `<p style="margin:0">Пользователь: <b>${esc(S.users.find((u) => u.id === el.dataset.id).name)}</b></p>
        <label class="field"><span>Новый пароль</span><input class="input" name="password" autocomplete="new-password" placeholder="минимум 6 символов"></label>`, FOOT('Сохранить'), 'pass-form');
      $('#pass-form').dataset.id = el.dataset.id;
      break;
    case 'user-toggle': {
      const u = S.users.find((x) => x.id === el.dataset.id);
      try { await api('PATCH', '/api/users/' + u.id, { active: !u.active }); await reloadS(); render(); toast(u.active ? 'Пользователь отключён' : 'Пользователь включён'); } catch (err) { toast(err.message, true); }
      break;
    }
    case 'modal-close': closeModal(); break;
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  const a = el.dataset.actChange;
  const isDefault = current().name === 'default';
  if (el.id === 'plan-date' && el.value) return go(`#/plan/${el.value}`);
  if (a === 'assign' && el.value) return assign(el.dataset.route, el.value);
  if (a === 'assign-to' && el.value) return assign(el.value, el.dataset.bus);
  if (a === 'driver') {
    if (isDefault) return draftChange(() => { draftBus(el.dataset.bus).driverId = el.value || null; });
    return planAct('driver', { busId: el.dataset.bus, driverId: el.value || null });
  }
  if (a === 'user-role') {
    try { await api('PATCH', '/api/users/' + el.dataset.id, { role: el.value }); await reloadS(); render(); toast('Роль изменена'); } catch (err) { toast(err.message, true); await reloadS(); render(); }
  }
  if (el.id === 'restore-file' && el.files[0]) {
    let data;
    try { data = JSON.parse(await el.files[0].text()); } catch { return toast('Файл не похож на резервную копию', true); }
    if (!confirm('Заменить все текущие данные данными из файла?')) return;
    try { await api('POST', '/api/backup/restore', { data }); toast('Данные восстановлены'); await boot(); } catch (err) { toast(err.message, true); }
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const fd = new FormData(f);
  const d = Object.fromEntries(fd.entries());
  try {
    if (f.id === 'login-form') {
      try { await api('POST', '/api/login', d); UI.date = null; await boot(); } catch (err) { $('#l-error').textContent = err.message; }
      return;
    }
    if (f.id === 'copy-form') {
      const r = await api('POST', `/api/plan/${UI.date}/copy`, { to: d.to });
      closeModal(); toast(`План скопирован на ${fmtShort(d.to)}${r.skipped ? `, пропущено развозок: ${r.skipped}` : ''}`);
      return;
    }
    if (f.id === 'dict-form') {
      const { kind, id } = f.dataset;
      const body = { ...d };
      if (kind === 'routes') body.days = fd.getAll('days').map(Number);
      await api(id ? 'PATCH' : 'POST', `/api/${kind}${id ? '/' + id : ''}`, body);
      closeModal(); await reloadS(); render(); toast(id ? 'Сохранено' : 'Добавлено');
      return;
    }
    if (f.id === 'user-form') { await api('POST', '/api/users', d); closeModal(); await reloadS(); render(); toast('Пользователь создан'); return; }
    if (f.id === 'pass-form') { await api('PATCH', '/api/users/' + f.dataset.id, { password: d.password }); closeModal(); toast('Пароль изменён'); return; }
    if (f.id === 'settings-form') {
      await api('PATCH', '/api/settings', { notifyEnabled: fd.has('notifyEnabled'), notifyTime: d.notifyTime, notifyFor: d.notifyFor, telegramToken: d.telegramToken, telegramChatId: d.telegramChatId });
      await reloadS(); UI.log = await api('GET', '/api/log'); render(); toast('Настройки сохранены');
    }
  } catch (err) { if ($('#modal')) mErr(err.message); else toast(err.message, true); }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal')) closeModal(); });

// ---------- перетаскивание развозок ----------
const drag = { el: null, ghost: null, active: false, suppress: false };
document.addEventListener('pointerdown', (e) => {
  const r = e.target.closest('.route[data-drag="1"]');
  if (!r || e.button !== 0 || e.target.closest('select,button')) return;
  Object.assign(drag, { el: r, x: e.clientX, y: e.clientY, active: false });
});
document.addEventListener('pointermove', (e) => {
  if (!drag.el) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
    drag.active = true;
    const rc = drag.el.getBoundingClientRect();
    drag.dx = drag.x - rc.left; drag.dy = drag.y - rc.top;
    drag.ghost = drag.el.cloneNode(true); drag.ghost.classList.add('drag-ghost'); drag.ghost.style.width = rc.width + 'px';
    document.body.appendChild(drag.ghost); drag.el.classList.add('dragging');
  }
  e.preventDefault();
  drag.ghost.style.left = e.clientX - drag.dx + 'px'; drag.ghost.style.top = e.clientY - drag.dy + 'px';
  document.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop'));
  const t = document.elementFromPoint(e.clientX, e.clientY);
  (t?.closest('.bus') || t?.closest('.pool'))?.classList.add('drop');
});
document.addEventListener('pointerup', (e) => {
  if (!drag.el) return;
  if (drag.active) {
    drag.ghost.remove(); drag.el.classList.remove('dragging');
    document.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop'));
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const rid = drag.el.dataset.route;
    const target = t?.closest('.bus');
    const fromBus = drag.el.closest('.bus')?.dataset.bus;
    drag.suppress = true; setTimeout(() => (drag.suppress = false), 0);
    if (target && target.dataset.bus !== fromBus) assign(rid, target.dataset.bus);
    else if (!target && t?.closest('.pool') && fromBus) unassign(rid);
  }
  drag.el = null; drag.active = false;
});

boot();
})();
