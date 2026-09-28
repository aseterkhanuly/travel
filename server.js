const fs = require('fs'), path = require('path'), crypto = require('crypto');
try { process.loadEnvFile(); } catch {}
const express = require('express'), multer = require('multer');

const { ADMIN_PASSWORD, SESSION_SECRET } = process.env;
if (!ADMIN_PASSWORD || !SESSION_SECRET || SESSION_SECRET.length < 16) {
  console.error('Задайте ADMIN_PASSWORD и SESSION_SECRET (16+ символов) в .env'); process.exit(1);
}
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const DATA = path.resolve(process.env.DATA_DIR || './data');
const UP = path.join(DATA, 'uploads'), DB = path.join(DATA, 'db.json'), CAP = path.join(DATA, 'capitals.json');
fs.mkdirSync(UP, { recursive: true });
if (!fs.existsSync(DB)) fs.copyFileSync(path.join(__dirname, 'seed.json'), DB);

let db = JSON.parse(fs.readFileSync(DB, 'utf8'));
const save = () => { fs.writeFileSync(DB + '.tmp', JSON.stringify(db, null, 2)); fs.renameSync(DB + '.tmp', DB); };
const uid = () => crypto.randomBytes(8).toString('hex');
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const num = (v, lo, hi) => { if (v === '' || v == null) return null; v = Number(v); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
const rm = f => fs.rm(path.join(UP, path.basename(f)), { force: true }, () => {});

// ---------- сессия владельца (подписанная cookie) ----------
const sign = s => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('hex');
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
function isAdmin(req) {
  const [e, s] = (cookies(req).sid || '').split('.');
  if (!e || !s || +e < Date.now()) return false;
  const a = Buffer.from(sign(e)), b = Buffer.from(s);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const need = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Нужен вход владельца' });
const cookie = (v, age) => `sid=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${PROD ? '; Secure' : ''}`;

const app = express();
if (PROD) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((q, r, n) => { r.setHeader('X-Content-Type-Options', 'nosniff'); r.setHeader('Referrer-Policy', 'same-origin'); n(); });
app.use(express.json({ limit: '50kb' }));
app.use('/uploads', express.static(UP, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));

const fails = new Map();
app.post('/api/login', (req, res) => {
  const f = fails.get(req.ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 6e5) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 5) return res.status(429).json({ error: 'Слишком много попыток. Подождите 10 минут.' });
  if (!crypto.timingSafeEqual(sha(req.body.password || ''), sha(ADMIN_PASSWORD))) {
    f.n++; fails.set(req.ip, f); return res.status(401).json({ error: 'Неверный пароль' });
  }
  fails.delete(req.ip);
  const e = Date.now() + 7 * 864e5;
  res.setHeader('Set-Cookie', cookie(e + '.' + sign(String(e)), 604800));
  res.json({ ok: true });
});
app.post('/api/logout', (q, res) => { res.setHeader('Set-Cookie', cookie('', 0)); res.json({ ok: true }); });

// ---------- публичное чтение ----------
app.get('/api/data', (req, res) => {
  const admin = isAdmin(req);
  const places = db.places.filter(p => admin || p.visited);
  const ids = new Set(places.map(p => p.id));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    admin, places, trips: db.trips.filter(t => ids.has(t.placeId)),
    settings: { title: process.env.SITE_TITLE || 'Наша история', subtitle: process.env.SITE_SUBTITLE || '' }
  });
});

// столицы: скачиваются один раз с restcountries.com и кэшируются в DATA_DIR/capitals.json
let capP = null;
async function capitals() {
  if (fs.existsSync(CAP)) return fs.readFileSync(CAP, 'utf8');
  capP ??= (async () => {
    const r = await fetch('https://restcountries.com/v3.1/all?fields=cca2,name,capital,capitalInfo,translations', { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const out = (await r.json()).filter(c => c.capital?.[0] && c.capitalInfo?.latlng?.length === 2).map(c => ({
      c: c.capital[0], cc: c.cca2, country: c.translations?.rus?.common || c.name.common, en: c.name.common,
      lat: c.capitalInfo.latlng[0], lng: c.capitalInfo.latlng[1]
    }));
    const s = JSON.stringify(out); fs.writeFileSync(CAP, s); return s;
  })().finally(() => { capP = null; });
  return capP;
}
app.get('/api/capitals', async (q, res) => {
  try { res.type('json').send(await capitals()); }
  catch { res.status(503).json({ error: 'Список столиц пока недоступен' }); }
});

// поиск городов через Nominatim (с кэшем и очередью не чаще 1 запроса в секунду)
const gc = new Map(); let last = 0, chain = Promise.resolve();
app.get('/api/geocode', (req, res) => {
  const q = str(req.query.q, 100).toLowerCase();
  if (q.length < 2) return res.json([]);
  if (gc.has(q)) return res.json(gc.get(q));
  chain = chain.then(async () => {
    const wait = 1100 - (Date.now() - last); if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: '6', 'accept-language': 'ru' }),
        { headers: { 'User-Agent': `our-story-album/1.0 (${process.env.CONTACT || 'no-contact'})` }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error();
      const out = (await r.json()).map(x => ({ name: x.name || x.display_name.split(',')[0], full: x.display_name, country: x.address?.country || '', lat: +x.lat, lng: +x.lon }));
      if (gc.size > 500) gc.clear(); gc.set(q, out); res.json(out);
    } catch { res.status(502).json({ error: 'Поиск городов временно недоступен' }); }
  });
});

// ---------- изменения (только владелец) ----------
app.post('/api/places', need, (req, res) => {
  const b = req.body, lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180), name = str(b.name, 120);
  if (lat === null || lng === null || !name) return res.status(400).json({ error: 'Нужны название и координаты' });
  const p = { id: uid(), name, country: str(b.country, 80), lat, lng, visited: !!b.visited };
  db.places.push(p); save(); res.json(p);
});
app.patch('/api/places/:id', need, (req, res) => {
  const p = db.places.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Место не найдено' });
  if ('visited' in req.body) p.visited = !!req.body.visited;
  if (req.body.name) p.name = str(req.body.name, 120);
  if ('country' in req.body) p.country = str(req.body.country, 80);
  save(); res.json(p);
});
app.delete('/api/places/:id', need, (req, res) => {
  db.trips.filter(t => t.placeId === req.params.id).forEach(t => t.media.forEach(m => rm(m.file)));
  db.trips = db.trips.filter(t => t.placeId !== req.params.id);
  db.places = db.places.filter(p => p.id !== req.params.id);
  save(); res.json({ ok: true });
});

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };
const upload = multer({
  storage: multer.diskStorage({ destination: UP, filename: (q, f, cb) => cb(null, uid() + EXT[f.mimetype]) }),
  fileFilter: (q, f, cb) => EXT[f.mimetype] ? cb(null, true) : cb(new Error(`Формат не поддерживается: ${f.originalname}. Допустимы JPG, PNG, WebP, GIF, AVIF, MP4, WebM, MOV.`)),
  limits: { fileSize: 300 * 1024 * 1024, files: 30 }
});
const files = req => (req.files || []).map(f => ({ id: uid(), type: f.mimetype.startsWith('video') ? 'video' : 'image', file: f.filename, name: Buffer.from(f.originalname, 'latin1').toString('utf8').slice(0, 120) }));
const fields = b => ({
  date: /^\d{4}-\d\d-\d\d$/.test(b.date || '') ? b.date : null,
  order: b.order === '' || b.order == null ? null : num(b.order, 1, 9999),
  title: str(b.title, 120), text: str(b.text, 5000)
});
app.post('/api/trips', need, upload.array('files', 30), (req, res) => {
  const place = db.places.find(p => p.id === req.body.placeId);
  if (!place) { files(req).forEach(m => rm(m.file)); return res.status(400).json({ error: 'Место не найдено' }); }
  const t = { id: uid(), placeId: place.id, ...fields(req.body), media: files(req) };
  db.trips.push(t); save(); res.json(t);
});
app.patch('/api/trips/:id', need, upload.array('files', 30), (req, res) => {
  const t = db.trips.find(x => x.id === req.params.id);
  if (!t) { files(req).forEach(m => rm(m.file)); return res.status(404).json({ error: 'Поездка не найдена' }); }
  Object.assign(t, fields(req.body)); t.media.push(...files(req)); save(); res.json(t);
});
app.delete('/api/trips/:id', need, (req, res) => {
  const t = db.trips.find(x => x.id === req.params.id);
  if (t) t.media.forEach(m => rm(m.file));
  db.trips = db.trips.filter(x => x.id !== req.params.id); save(); res.json({ ok: true });
});
app.delete('/api/trips/:id/media/:mid', need, (req, res) => {
  const t = db.trips.find(x => x.id === req.params.id);
  const m = t?.media.find(x => x.id === req.params.mid);
  if (!m) return res.status(404).json({ error: 'Файл не найден' });
  rm(m.file); t.media = t.media.filter(x => x !== m); save(); res.json({ ok: true });
});

app.use('/api', (q, res) => res.status(404).json({ error: 'Не найдено' }));
app.use((err, q, res, n) => res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл больше 300 МБ' : err.message }));
app.listen(PORT, () => console.log(`Сайт запущен: http://localhost:${PORT}`));
