'use strict';
const $ = s => document.querySelector(s);
const el = (t, a = {}, ...k) => {
  const e = document.createElement(t);
  for (const [n, v] of Object.entries(a)) {
    if (v == null || v === false) continue;
    if (n === 'class') e.className = v; else if (n === 'text') e.textContent = v;
    else if (n.startsWith('on')) e.addEventListener(n.slice(2), v); else e.setAttribute(n, v === true ? '' : v);
  }
  e.append(...k.flat().filter(x => x != null && x !== false)); return e;
};
const S = { admin: false, places: [], trips: [], caps: [], draft: null };
const byId = id => S.places.find(p => p.id === id);
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
const fmt = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : 'Дата не указана';
const near = (a, b, e = .08) => Math.abs(a.lat - b.lat) < e && Math.abs(a.lng - b.lng) < e;
const findPlace = (lat, lng) => S.places.find(p => near(p, { lat, lng }));
const byDate = (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.order ?? 1e9) - (b.order ?? 1e9);
const placeTrips = id => S.trips.filter(t => t.placeId === id).sort(byDate);

let tt;
function toast(m, err) { const t = $('#toast'); t.textContent = m; t.className = 'on' + (err ? ' err' : ''); clearTimeout(tt); tt = setTimeout(() => t.className = '', 4500); }
async function api(url, opt = {}) {
  let r; try { r = await fetch(url, { credentials: 'same-origin', ...opt }); } catch { throw new Error('Нет соединения с сервером'); }
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j.error || 'Ошибка ' + r.status); return j;
}
const post = (u, b, m = 'POST') => api(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const send = (url, method, fd, on) => new Promise((ok, no) => {
  const x = new XMLHttpRequest(); x.open(method, url);
  x.upload.onprogress = e => e.lengthComputable && on?.(Math.round(e.loaded / e.total * 100));
  x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} x.status < 300 ? ok(j) : no(new Error(j.error || 'Ошибка ' + x.status)); };
  x.onerror = () => no(new Error('Нет соединения с сервером')); x.send(fd);
});
function banner(title, msg, retry) {
  const b = $('#banner'); if (!title) { b.hidden = true; return; }
  b.replaceChildren(el('h2', { text: title }), el('p', { text: msg }), el('button', { class: 'btn', onclick: retry, text: 'Повторить' })); b.hidden = false;
}
function show(n) { n._op = document.activeElement; n.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => { n.classList.add('on'); (n.querySelector('.x,.round,input,button') || n).focus({ preventScroll: true }); })); }
function hide(n, ret = true) { n.classList.remove('on'); setTimeout(() => { if (!n.classList.contains('on')) n.hidden = true; }, 420); if (ret) n._op?.focus?.({ preventScroll: true }); }

/* ---------- карта ---------- */
const map = L.map('map', { worldCopyJump: true, minZoom: 2, zoomControl: false, preferCanvas: true }).setView([30, 15], 2);
L.control.zoom({ position: 'bottomright', zoomInTitle: 'Приблизить', zoomOutTitle: 'Отдалить' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap, © CARTO', subdomains: 'abcd', maxZoom: 18 }).addTo(map);
const capL = L.layerGroup().addTo(map), routeL = L.layerGroup().addTo(map), placeL = L.layerGroup().addTo(map);
let routeOn = true, pickMarker = null, picking = false;
const pinIcon = c => L.divIcon({ className: 'pinwrap', html: `<span class="pin-h ${c}"></span>`, iconSize: [26, 26], iconAnchor: [13, 26], popupAnchor: [0, -26] });

function spot(s) {
  const n = el('div', {}, el('b', { text: s.name }), el('br'), el('small', { text: s.country || '' }));
  if (S.admin) n.append(el('br'), el('button', { class: 'btn', text: 'Мы были здесь', onclick: () => { map.closePopup(); openAdmin({ name: s.name, country: s.country, lat: s.lat, lng: s.lng, visited: true }); } }));
  L.popup().setLatLng([s.lat, s.lng]).setContent(n).openOn(map);
}
function drawCaps() {
  capL.clearLayers(); if (map.getZoom() < 4) return;
  const vis = S.places.filter(p => p.visited), bb = map.getBounds().pad(.3);
  for (const c of S.caps) {
    if (!bb.contains([c.lat, c.lng]) || vis.some(p => near(p, c))) continue;
    L.circleMarker([c.lat, c.lng], { radius: 5, color: '#fff', weight: 1.5, fillColor: '#6d4c7d', fillOpacity: 1 })
      .bindTooltip(`${c.c}, ${c.country}`).on('click', () => spot({ name: c.c, country: c.country, lat: c.lat, lng: c.lng })).addTo(capL);
  }
}
function drawPlaces() {
  placeL.clearLayers();
  for (const p of S.places) {
    L.marker([p.lat, p.lng], { icon: pinIcon(p.visited ? '' : 'draft'), title: `${p.name}, ${p.country}${p.visited ? '' : ' (черновик)'}`, keyboard: true })
      .on('click', () => openCard(p.id)).addTo(placeL);
  }
}
function drawRoute() {
  routeL.clearLayers();
  const vis = new Set(S.places.filter(p => p.visited).map(p => p.id)), v = S.trips.filter(t => vis.has(t.placeId));
  const ord = v.filter(t => t.order != null).sort((a, b) => a.order - b.order);
  const seq = ord.length > 1 ? ord : v.filter(t => t.date).sort((a, b) => a.date.localeCompare(b.date));
  const pts = [];
  for (const t of seq) { const p = byId(t.placeId), l = pts.at(-1); if (!l || l[0] !== p.lat || l[1] !== p.lng) pts.push([p.lat, p.lng]); }
  $('#routeBtn').hidden = pts.length < 2;
  if (routeOn && pts.length > 1) L.polyline(pts, { color: '#b3345f', weight: 2.5, opacity: .85, className: 'route', interactive: false }).addTo(routeL);
}
function render() {
  drawPlaces(); drawRoute(); drawCaps();
  const vis = S.places.filter(p => p.visited), demo = S.places.some(p => p.demo) || S.trips.some(t => t.demo);
  $('#stats').textContent = vis.length ? `Мест: ${vis.length}, поездок: ${S.trips.length}.${demo ? ' Показаны демонстрационные данные.' : ''}` : 'Пока нет ни одной отметки. Первая история появится здесь.';
  $('#ownerBtn').textContent = S.admin ? 'Панель' : 'Владелец';
}
$('#routeBtn').onclick = e => { routeOn = !routeOn; e.currentTarget.setAttribute('aria-pressed', routeOn); drawRoute(); };
map.on('zoomend moveend', drawCaps);

async function load() {
  try {
    const d = await api('/api/data');
    Object.assign(S, { admin: d.admin, places: d.places, trips: d.trips });
    $('#title').textContent = d.settings.title; document.title = d.settings.title; $('#sub').textContent = d.settings.subtitle;
    banner(null); render();
  } catch (e) { banner('Карта не загрузилась', e.message, load); }
}

/* ---------- поиск ---------- */
const q = $('#q'), sug = $('#sug'); let items = [], cur = -1, seq = 0, dt;
function localSearch(v) {
  v = norm(v); const o = [], add = (t, name, sub, x, extra) => o.push({ t, name, sub, country: x.country, lat: x.lat, lng: x.lng, ...extra });
  S.places.filter(p => norm(p.name + ' ' + p.country).includes(v)).slice(0, 4).forEach(p => add('Наши места', p.name, p.country, p, { place: p.id }));
  S.caps.filter(c => norm(c.country + ' ' + c.en).includes(v)).slice(0, 4).forEach(c => add('Страны', c.country, 'Столица: ' + c.c, c, { z: 5 }));
  S.caps.filter(c => norm(c.c).includes(v)).slice(0, 4).forEach(c => add('Столицы', c.c, c.country, { country: c.country, lat: c.lat, lng: c.lng }, { z: 9, nameOverride: c.c }));
  return o;
}
function paint(msg) {
  sug.replaceChildren(); let last = null;
  items.forEach((it, i) => {
    if (it.t !== last) { sug.append(el('li', { class: 'hd', role: 'presentation', text: it.t })); last = it.t; }
    sug.append(el('li', { role: 'option', id: 'o' + i, 'aria-selected': String(i === cur), onclick: () => pick(it) }, el('span', { text: it.name }), el('small', { text: it.sub || '' })));
  });
  if (msg) sug.append(el('li', { class: 'hd', role: 'presentation', text: msg }));
  sug.hidden = !items.length && !msg; q.setAttribute('aria-expanded', String(!sug.hidden));
}
const closeSug = () => { items = []; cur = -1; paint(); q.removeAttribute('aria-activedescendant'); };
async function geo(v, on) { try { return (await api('/api/geocode?q=' + encodeURIComponent(v))).map(x => ({ t: 'Города и места', name: x.name, sub: x.full, country: x.country, lat: x.lat, lng: x.lng, z: 10 })); } catch (e) { on?.(e.message); return []; } }
q.addEventListener('input', () => {
  const v = q.value.trim(); clearTimeout(dt); seq++;
  if (v.length < 2) return closeSug();
  items = localSearch(v); cur = -1; paint(items.length ? '' : 'Ищем города…');
  const my = seq;
  dt = setTimeout(async () => {
    let err = ''; const g = await geo(v, m => err = m); if (my !== seq) return;
    items = items.concat(g); paint(!items.length ? (err || 'Ничего не найдено') : err ? 'Поиск городов недоступен' : '');
  }, 450);
});
q.addEventListener('keydown', e => {
  const n = items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!n) return; cur = (cur + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; paint(); const o = $('#o' + cur); q.setAttribute('aria-activedescendant', 'o' + cur); o?.scrollIntoView({ block: 'nearest' }); }
  else if (e.key === 'Enter' && n) { e.preventDefault(); pick(items[cur < 0 ? 0 : cur]); }
  else if (e.key === 'Escape') { closeSug(); q.value = ''; }
});
document.addEventListener('click', e => { if (!e.target.closest('.search')) closeSug(); });
function pick(it) {
  const p = it.place ? byId(it.place) : findPlace(it.lat, it.lng);
  q.value = it.name; closeSug(); q.blur();
  map.flyTo([it.lat, it.lng], it.z || 9, { duration: 1.1 });
  map.once('moveend', () => { if (p && (p.visited || S.admin)) openCard(p.id); else spot(it); });
}

/* ---------- карточка места ---------- */
const card = $('#card');
function openCard(pid, tid) {
  const p = byId(pid); if (!p) return; map.closePopup();
  const trips = placeTrips(pid); let idx = Math.max(0, trips.findIndex(t => t.id === tid));
  const body = el('div', { class: 'in' });
  const paintCard = () => {
    const t = trips[idx];
    body.replaceChildren(
      el('h2', { id: 'cardTitle', text: p.name }),
      el('p', { class: 'country' }, p.country, p.demo && el('span', { class: 'tag', text: 'демо' }), !p.visited && el('span', { class: 'tag', text: 'черновик' })),
      trips.length > 1 && el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Поездки в это место' }, trips.map((x, i) =>
        el('button', { role: 'tab', 'aria-selected': String(i === idx), onclick: () => { idx = i; paintCard(); }, text: x.date ? new Date(x.date + 'T00:00:00').toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' }) : 'Поездка ' + (i + 1) }))),
      t ? tripView(p, t, () => openCard(pid, t.id)) : el('div', { class: 'empty', text: S.admin ? 'В этом месте пока нет поездок. Добавьте первую.' : 'История этого места ещё не написана.' }),
      S.admin && ownerBar(p, t));
  };
  paintCard();
  card.replaceChildren(el('div', { class: 'top' }, el('button', { class: 'round', 'aria-label': 'Закрыть', onclick: () => hide(card), text: '✕' })), body);
  if (card.hidden || !card.classList.contains('on')) show(card);
  card.scrollTop = 0;
}
function tripView(p, t, again) {
  const imgs = t.media.filter(m => m.type === 'image').map((m, i) => ({ src: '/uploads/' + m.file, alt: `${p.name}, фото ${i + 1}` }));
  let gi = 0;
  const g = t.media.length ? el('div', { class: 'gal' }, t.media.map(m => {
    let cell;
    if (m.type === 'image') {
      const i = gi++; const img = el('img', { src: '/uploads/' + m.file, alt: imgs[i].alt, loading: 'lazy', decoding: 'async' });
      cell = el('div', { class: 'm' }, el('button', { class: 'o', 'aria-label': `Открыть фото ${i + 1} на весь экран`, onclick: e => lbOpen(imgs, i, e.currentTarget) }, img));
      img.onerror = () => cell.replaceChildren(el('span', { class: 'bad', text: 'Не удалось загрузить фото' }));
    } else {
      const v = el('video', { src: '/uploads/' + m.file, controls: true, preload: 'metadata', playsinline: true, 'aria-label': `Видео из ${p.name}` });
      v.onerror = () => cell.replaceChildren(el('span', { class: 'bad', text: 'Не удалось загрузить видео' }));
      cell = el('div', { class: 'm' }, v);
    }
    if (S.admin) cell.append(el('button', { class: 'del', 'aria-label': 'Удалить файл', text: '✕', onclick: async () => { if (!confirm('Удалить этот файл навсегда?')) return; try { await api(`/api/trips/${t.id}/media/${m.id}`, { method: 'DELETE' }); await load(); again(); } catch (e) { toast(e.message, 1); } } }));
    return cell;
  })) : el('div', { class: 'empty', text: S.admin ? 'Фото и видео не добавлены. Нажмите «Изменить», чтобы загрузить.' : 'Фотографий и видео пока нет.' });
  return el('article', { class: 'trip', role: 'tabpanel' },
    el('p', { class: 'date', text: fmt(t.date) }), t.title && el('h3', { text: t.title }),
    t.text ? el('p', { class: 'txt', text: t.text }) : el('p', { class: 'hint', text: 'Текст пока не добавлен.' }), g);
}
function ownerBar(p, t) {
  const close = () => { card.classList.remove('on'); card.hidden = true; };
  const del = (msg, url) => async () => { if (!confirm(msg)) return; try { await api(url, { method: 'DELETE' }); await load(); hide(card, false); toast('Удалено'); } catch (e) { toast(e.message, 1); } };
  return el('div', { class: 'own' },
    t && el('button', { class: 'btn', text: 'Изменить', onclick: () => { close(); openAdmin({ placeId: p.id, tripId: t.id }); } }),
    el('button', { class: 'btn ghost', text: 'Ещё одна поездка', onclick: () => { close(); openAdmin({ placeId: p.id }); } }),
    t && el('button', { class: 'btn danger', text: 'Удалить поездку', onclick: del('Удалить эту поездку вместе с фото и видео?', '/api/trips/' + t.id) }),
    el('button', { class: 'btn danger', text: 'Удалить место', onclick: del(`Удалить «${p.name}» со всеми поездками и файлами?`, '/api/places/' + p.id) }));
}

/* ---------- просмотр фото ---------- */
const lb = $('#lb'); let lbList = [], lbI = 0, sx = 0;
function lbShow() { const c = lbList[lbI]; $('#lbImg').src = c.src; $('#lbImg').alt = c.alt; $('#lbCap').textContent = `${lbI + 1} из ${lbList.length}`; $('#lbPrev').hidden = $('#lbNext').hidden = lbList.length < 2; }
function lbOpen(list, i, from) { lbList = list; lbI = i; lbShow(); lb._op = from; lb.hidden = false; requestAnimationFrame(() => { lb.classList.add('on'); $('#lbClose').focus(); }); }
const step = d => { lbI = (lbI + d + lbList.length) % lbList.length; lbShow(); };
$('#lbClose').onclick = () => hide(lb); $('#lbPrev').onclick = () => step(-1); $('#lbNext').onclick = () => step(1);
lb.addEventListener('click', e => { if (e.target === lb) hide(lb); });
lb.addEventListener('pointerdown', e => sx = e.clientX);
lb.addEventListener('pointerup', e => { const d = e.clientX - sx; if (Math.abs(d) > 50 && lbList.length > 1) step(d < 0 ? 1 : -1); });

/* ---------- панель владельца ---------- */
const adm = $('#admin');
function closeAdmin() { endPick(); hide(adm); if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; } }
function endPick() { picking = false; document.body.classList.remove('picking'); }
function openAdmin(pref = {}) {
  if (!S.admin) { renderLogin(); } else renderForm(pref);
  if (adm.hidden || !adm.classList.contains('on')) show(adm);
}
function renderLogin() {
  const pw = el('input', { type: 'password', id: 'pw', autocomplete: 'current-password' }), er = el('p', { class: 'err', role: 'alert' });
  const go = async () => { try { await post('/api/login', { password: pw.value }); await load(); openAdmin(); } catch (e) { er.textContent = e.message; } };
  pw.addEventListener('keydown', e => e.key === 'Enter' && go());
  adm.replaceChildren(el('h2', { text: 'Вход для владельца' }), el('p', { class: 'hint', text: 'Посетители видят только историю. Добавлять и удалять можно после входа.' }),
    el('label', { for: 'pw', text: 'Пароль' }), pw, er, el('div', { class: 'own', style: 'border:0;padding:0' }, el('button', { class: 'btn', text: 'Войти', onclick: go }), el('button', { class: 'btn ghost', text: 'Закрыть', onclick: closeAdmin })));
}
function renderForm(pref) {
  const d = S.draft = { placeId: null, tripId: null, name: '', country: '', lat: '', lng: '', visited: true, date: '', order: '', title: '', text: '', ...pref };
  if (d.placeId) { const p = byId(d.placeId); Object.assign(d, { name: p.name, country: p.country, lat: p.lat, lng: p.lng, visited: p.visited }); }
  else if (d.lat !== '') { const ex = findPlace(+d.lat, +d.lng); if (ex) Object.assign(d, { placeId: ex.id, name: ex.name, country: ex.country, lat: ex.lat, lng: ex.lng }); }
  if (d.tripId) { const t = S.trips.find(x => x.id === d.tripId); Object.assign(d, { date: t.date || '', order: t.order ?? '', title: t.title, text: t.text }); }
  const F = {};
  const field = (k, type, label, x = {}) => { F[k] = el('input', { type, id: 'f' + k, ...x }); F[k].value = d[k] ?? ''; return [el('label', { for: 'f' + k, text: label }), F[k]]; };
  const er = el('p', { class: 'err', role: 'alert' }), prog = el('progress', { max: 100, value: 0, hidden: true, 'aria-label': 'Загрузка файлов' });
  const res = el('ul', { class: 'res' }), sr = el('input', { type: 'search', id: 'fs', placeholder: 'Город, страна или столица', autocomplete: 'off' });
  let sd, ss = 0;
  const setLoc = (name, country, lat, lng) => {
    const ex = findPlace(lat, lng);
    if (ex && !d.tripId) { d.placeId = ex.id; name = ex.name; country = ex.country; F.visited.checked = true; }
    else if (!d.tripId) d.placeId = null;
    F.name.value = name; F.country.value = country || ''; F.lat.value = (+lat).toFixed(5); F.lng.value = (+lng).toFixed(5); movePick(); tripBox.hidden = !F.visited.checked;
    hintEl.textContent = d.placeId ? 'Это место уже есть на карте: новая запись добавится как ещё одна поездка.' : '';
  };
  function movePick() {
    const la = parseFloat(F.lat.value), ln = parseFloat(F.lng.value); if (isNaN(la) || isNaN(ln)) return;
    if (!pickMarker) { pickMarker = L.marker([la, ln], { icon: pinIcon('pick'), draggable: true, keyboard: false }).addTo(map); pickMarker.on('dragend', () => { const c = pickMarker.getLatLng(); F.lat.value = c.lat.toFixed(5); F.lng.value = c.lng.toFixed(5); }); }
    else pickMarker.setLatLng([la, ln]);
  }
  sr.addEventListener('input', () => {
    const v = sr.value.trim(); clearTimeout(sd); const my = ++ss; res.replaceChildren(); if (v.length < 2) return;
    const draw = (list, msg) => { res.replaceChildren(...list.map(it => el('li', {}, el('button', { type: 'button', onclick: () => { setLoc(it.name, it.country, it.lat, it.lng); map.flyTo([it.lat, it.lng], 8); res.replaceChildren(); } }, it.name, el('small', { text: it.sub || it.country })))), msg && el('li', { class: 'hint', text: msg })); };
    draw(localSearch(v).filter(x => !x.place)); sd = setTimeout(async () => { let e = ''; const g = await geo(v, m => e = m); if (my === ss) draw(localSearch(v).filter(x => !x.place).concat(g), e || (!g.length ? 'Городов не найдено — поставьте точку на карте.' : '')); }, 450);
  });
  const hintEl = el('p', { class: 'hint' });
  F.visited = el('input', { type: 'checkbox', role: 'switch', id: 'fv' }); F.visited.checked = !!d.visited;
  F.text = el('textarea', { id: 'ftext', maxlength: 5000 }); F.text.value = d.text;
  F.files = el('input', { type: 'file', id: 'ffiles', multiple: true, accept: 'image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm,video/quicktime' });
  const fl = el('p', { class: 'files' }); F.files.onchange = () => fl.textContent = F.files.files.length ? `Выбрано файлов: ${F.files.files.length}` : '';
  const tripBox = el('div', {}, ...field('date', 'date', 'Дата поездки (необязательно)'), ...field('order', 'number', 'Порядок в маршруте (1, 2, 3…; необязательно)', { min: 1, max: 9999, step: 1 }),
    ...field('title', 'text', 'Заголовок (необязательно)', { maxlength: 120 }), el('label', { for: 'ftext', text: 'История' }), F.text,
    el('label', { for: 'ffiles', text: 'Фото и видео (можно несколько)' }), F.files, fl,
    d.tripId && el('p', { class: 'hint', text: 'Новые файлы добавятся к уже загруженным. Удалять файлы можно в карточке места.' }));
  F.visited.onchange = () => tripBox.hidden = !F.visited.checked; tripBox.hidden = !F.visited.checked;
  const pickBtn = el('button', { class: 'btn ghost', type: 'button', text: 'Поставить точку на карте', onclick: () => { picking = true; document.body.classList.add('picking'); toast('Нажмите на карту. Кнопка «Панель» или Esc — отмена.'); } });
  const saveBtn = el('button', { class: 'btn', text: 'Сохранить', onclick: async () => {
    er.textContent = ''; const name = F.name.value.trim(), lat = F.lat.value, lng = F.lng.value, vis = F.visited.checked;
    if (!name || lat === '' || lng === '') return er.textContent = 'Укажите название и точку: найдите место или поставьте точку на карте.';
    const big = [...F.files.files].find(f => f.size > 300 * 1024 * 1024); if (big) return er.textContent = `Файл «${big.name}» больше 300 МБ.`;
    const hasTrip = d.tripId || F.date.value || F.order.value || F.title.value || F.text.value || F.files.files.length;
    saveBtn.disabled = true;
    try {
      const body = { name, country: F.country.value.trim(), lat, lng, visited: vis };
      if (!d.placeId) d.placeId = (await post('/api/places', body)).id; else await post('/api/places/' + d.placeId, body, 'PATCH');
      if (vis && hasTrip) {
        const fd = new FormData(); fd.set('placeId', d.placeId); ['date', 'order', 'title', 'text'].forEach(k => fd.set(k, F[k].value));
        [...F.files.files].forEach(f => fd.append('files', f));
        await send(d.tripId ? '/api/trips/' + d.tripId : '/api/trips', d.tripId ? 'PATCH' : 'POST', fd, p => { prog.hidden = false; prog.value = p; });
      }
      const pid = d.placeId; await load(); closeAdmin(); toast('Сохранено'); if (vis) openCard(pid, d.tripId);
    } catch (e) { er.textContent = e.message; if (/вход владельца/.test(e.message)) { S.admin = false; renderLogin(); } } finally { saveBtn.disabled = false; prog.hidden = true; }
  } });
  adm.replaceChildren(el('h2', { text: d.tripId ? 'Изменить поездку' : 'Новая запись' }),
    !d.tripId && el('div', {}, el('label', { for: 'fs', text: 'Найти место' }), sr, res, el('div', { style: 'margin-top:8px' }, pickBtn)),
    ...field('name', 'text', 'Название места', { maxlength: 120 }), ...field('country', 'text', 'Страна', { maxlength: 80 }),
    el('div', { class: 'row' }, el('div', {}, ...field('lat', 'number', 'Широта', { step: 'any', min: -90, max: 90 })), el('div', {}, ...field('lng', 'number', 'Долгота', { step: 'any', min: -180, max: 180 }))), hintEl,
    el('label', { class: 'sw' }, F.visited, el('span', { class: 'tr', 'aria-hidden': 'true' }), el('span', { text: 'Мы были здесь' })),
    tripBox, er, prog,
    el('div', { class: 'own', style: 'border:0;padding:0' }, saveBtn, el('button', { class: 'btn ghost', text: 'Отмена', onclick: closeAdmin }),
      el('button', { class: 'btn ghost', text: 'Выйти', onclick: async () => { await post('/api/logout', {}).catch(() => {}); closeAdmin(); await load(); } })));
  F.lat.onchange = F.lng.onchange = movePick; if (d.lat !== '') movePick();
  hintEl.textContent = d.placeId && !d.tripId ? 'Это место уже есть на карте: новая запись добавится как ещё одна поездка.' : '';
}
map.on('click', e => { if (!picking) return; endPick(); const f = $('#flat'); if (!f) return; $('#flat').value = e.latlng.lat.toFixed(5); $('#flng').value = e.latlng.lng.toFixed(5); $('#flat').dispatchEvent(new Event('change')); if (!$('#fname').value) $('#fname').focus(); });
$('#ownerBtn').onclick = () => { if (picking) return endPick(); if (!adm.hidden && adm.classList.contains('on')) return closeAdmin(); openAdmin(); };

/* ---------- клавиатура ---------- */
addEventListener('keydown', e => {
  const top = !lb.hidden ? lb : !card.hidden && card.classList.contains('on') ? card : null;
  if (e.key === 'Escape') { if (top) hide(top); else if (picking) endPick(); else if (!adm.hidden && adm.classList.contains('on')) closeAdmin(); return; }
  if (!top) return;
  if (top === lb) { if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); }
  if (e.key === 'Tab') {
    const f = [...top.querySelectorAll('button,input,textarea,a[href],video')].filter(x => !x.disabled && x.offsetParent !== null || x === document.activeElement);
    if (!f.length) return; const a = f[0], z = f.at(-1);
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  }
});

load();
api('/api/capitals').then(c => { S.caps = c; drawCaps(); }).catch(() => toast('Список столиц недоступен: работают отметки и поиск городов.', 1));
