// Демо-данные: развозки, автобусы, водители, план по умолчанию и история за 30 дней.
const DEMO_PASSWORD = 'razvozka';
const TZ_OFFSET = Number(process.env.TZ_OFFSET_HOURS || 5);

function seed(hashPassword) {
  const today = new Date(Date.now() + TZ_OFFSET * 3600000).toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const weekday = (d) => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w === 0 ? 7 : w; };
  const at = (daysAgo, hh = 18) => new Date(Date.parse(addDays(today, -daysAgo) + `T${String(hh).padStart(2, '0')}:10:00Z`) - TZ_OFFSET * 3600000).toISOString();

  const users = [
    { id: 'u1', login: 'admin', name: 'Ирина Соколова', role: 'admin' },
    { id: 'u2', login: 'dispatcher', name: 'Олег Ковалёв', role: 'dispatcher' },
    { id: 'u3', login: 'smena2', name: 'Наталья Белова', role: 'dispatcher' },
  ].map((u) => ({ ...u, active: true, createdAt: at(60), ...hashPassword(DEMO_PASSWORD) }));

  const WD = [1, 2, 3, 4, 5], WD6 = [1, 2, 3, 4, 5, 6], ALL = [1, 2, 3, 4, 5, 6, 7];
  const routes = [
    ['r1', 'Газпром', 'to', '08:00', WD, 'ул. Республики, 142 → офис на ул. Тимофея Чаркова, 79'],
    ['r2', 'Газпром', 'from', '19:00', WD, 'Офис → ул. Республики, 142'],
    ['r3', 'Завод', 'to', '07:30', WD6, 'Ж/д вокзал → проходная №2, ул. Ветеранов труда, 9'],
    ['r4', 'Завод', 'from', '18:00', WD6, 'Проходная №2 → ж/д вокзал'],
    ['r5', 'Логистический центр', 'to', '07:00', ALL, 'ТЦ «Лето» → склад, Старый Тобольский тракт, 6 км'],
    ['r6', 'Логистический центр', 'from', '20:00', ALL, 'Склад → ТЦ «Лето»'],
    ['r7', 'Областная больница', 'to', '07:45', WD, 'пл. Борцов Революции → ул. Котовского, 55'],
    ['r8', 'Областная больница', 'from', '16:30', WD, 'ул. Котовского, 55 → пл. Борцов Революции'],
    ['r9', 'Агрокомплекс', 'to', '06:30', WD6, 'Автовокзал → пос. Московский, промзона'],
    ['r10', 'Агрокомплекс', 'from', '17:30', WD6, 'Промзона → автовокзал'],
    ['r11', 'Склад «Восток»', 'to', '19:30', ALL, 'Ночная смена: ул. 50 лет Октября → Восточный проезд, 12'],
    ['r12', 'Склад «Восток»', 'from', '08:30', ALL, 'Восточный проезд, 12 → ул. 50 лет Октября'],
  ].map(([id, client, direction, time, days, address]) => ({ id, client, direction, time, days, address, active: true }));
  routes.push({ id: 'r13', client: 'Стройплощадка «Северный»', direction: 'to', time: '07:15', days: WD, address: 'Сезонная развозка, на паузе до весны', active: false });

  const drivers = [
    ['d1', 'Иванов Сергей Петрович', '+7 900 000-00-01'],
    ['d2', 'Петров Алексей Иванович', '+7 900 000-00-02'],
    ['d3', 'Сидоров Михаил Юрьевич', '+7 900 000-00-03'],
    ['d4', 'Кузнецов Дмитрий Олегович', '+7 900 000-00-04'],
    ['d5', 'Смирнов Андрей Викторович', '+7 900 000-00-05'],
    ['d6', 'Волков Николай Сергеевич', '+7 900 000-00-06'],
    ['d7', 'Морозов Евгений Павлович', '+7 900 000-00-07'],
  ].map(([id, name, phone]) => ({ id, name, phone, active: true }));
  drivers.push({ id: 'd8', name: 'Фёдоров Игорь Андреевич', phone: '+7 900 000-00-08', active: false });

  const buses = [
    ['b1', 'Автобус 1', 'А123ВС72', 45, 'd1'],
    ['b2', 'Автобус 2', 'Е445БТ172', 45, 'd2'],
    ['b3', 'Автобус 3', 'К318МН72', 32, 'd3'],
    ['b4', 'Автобус 4', 'О907РС72', 32, 'd4'],
    ['b5', 'Автобус 5', 'Т250УХ172', 22, 'd5'],
    ['b6', 'Автобус 6 (резерв)', 'В661КЕ72', 18, null],
  ].map(([id, name, plate, seats, defaultDriverId]) => ({ id, name, plate, seats, defaultDriverId, active: true }));

  const defaultPlan = [
    { busId: 'b1', driverId: 'd1', routeIds: ['r1', 'r2'] },
    { busId: 'b2', driverId: 'd2', routeIds: ['r3', 'r4'] },
    { busId: 'b3', driverId: 'd3', routeIds: ['r5', 'r8', 'r6'] },
    { busId: 'b4', driverId: 'd4', routeIds: ['r9', 'r7', 'r10'] },
    { busId: 'b5', driverId: 'd5', routeIds: ['r12', 'r11'] },
  ];

  // История: 30 прошлых дней завершены, иногда водитель заменён или подключён резервный автобус.
  const plans = {};
  const log = [];
  for (let i = 30; i >= 1; i--) {
    const date = addDays(today, -i);
    const active = new Set(routes.filter((r) => r.active && r.days.includes(weekday(date))).map((r) => r.id));
    const pb = defaultPlan.map((d) => ({ ...d, routeIds: d.routeIds.filter((r) => active.has(r)) })).filter((d) => d.routeIds.length);
    if (i % 7 === 3) { const b = pb.find((x) => x.busId === 'b2'); if (b) b.driverId = 'd6'; }
    if (i % 9 === 4) { const b = pb.find((x) => x.busId === 'b3'); if (b && b.routeIds.includes('r8')) { b.routeIds = b.routeIds.filter((r) => r !== 'r8'); pb.push({ busId: 'b6', driverId: 'd7', routeIds: ['r8'] }); } }
    plans[date] = { date, buses: pb, closed: true, closedAt: at(i, 17), closedBy: i % 2 ? 'u2' : 'u3', updatedAt: at(i, 16) };
  }
  // Сегодня: план собран частично — две развозки ещё не назначены, день открыт.
  {
    const active = new Set(routes.filter((r) => r.active && r.days.includes(weekday(today))).map((r) => r.id));
    plans[today] = {
      date: today, closed: false, updatedAt: at(0, 9),
      buses: defaultPlan.slice(0, 4).map((d) => ({ ...d, routeIds: d.routeIds.filter((r) => active.has(r) && r !== 'r10') })),
    };
  }
  log.push({ id: 'l1', type: 'plan', text: `${today}: применён план по умолчанию`, userId: 'u2', at: at(0, 9) });
  log.push({ id: 'l2', type: 'reminder', text: `⚠️ Развозки на ${addDays(today, 0).split('-').reverse().join('.')}: день не завершён, не назначено 3 (демо-запись; Telegram не настроен)`, userId: null, at: at(1, 17) });

  return {
    users, routes, buses, drivers, defaultPlan, plans, log, sessions: {},
    settings: { notifyEnabled: true, notifyTime: '17:00', notifyFor: 'tomorrow', telegramToken: '', telegramChatId: '', lastNotifyKey: '' },
  };
}

module.exports = { seed, DEMO_PASSWORD };
