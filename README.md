# Наша история — интерактивный альбом путешествий

Node.js + Express, данные в JSON-файле, фото и видео на диске сервера. Карта — Leaflet + плитки CARTO/OpenStreetMap.

## Структура
```
our-story/
├─ server.js        API, вход владельца, загрузка файлов, поиск городов, столицы
├─ seed.json        демо-данные (копируются в data/db.json при первом запуске)
├─ package.json
├─ .env.example     пароль, секрет сессии, название сайта
└─ public/          index.html, style.css, app.js (сайт)
data/               создаётся сам: db.json, capitals.json, uploads/
```

## Схема данных (`data/db.json`)
```
places[]  { id, name, country, lat, lng, visited: bool, demo?: bool }
trips[]   { id, placeId → places.id, date: "YYYY-MM-DD"|null, order: 1..9999|null,
            title, text, media[], demo?: bool }
media[]   { id, type: "image"|"video", file: "<имя в data/uploads>", name }
```
Одно место (`place`) может иметь много поездок (`trips`). Место с `visited=false` видит только владелец (черновик).
Маршрут: если у 2+ поездок есть `order` — по нему; иначе по `date`. Поездки без порядка и даты в маршрут не входят.
`data/capitals.json` (столицы) скачивается один раз с restcountries.com при первом обращении к сайту.

## Запуск локально
1. Нужен Node.js 20.12+.
2. `npm install`
3. Скопируйте `.env.example` в `.env`, задайте `ADMIN_PASSWORD` и `SESSION_SECRET` (случайная строка от 16 символов), при желании `SITE_TITLE`, `SITE_SUBTITLE`, `CONTACT` (e-mail для поиска городов — требование Nominatim).
4. `npm start` → http://localhost:3000. Владелец: кнопка «Владелец» справа внизу.

## Публикация
Нужен хостинг, где Node-процесс работает постоянно и есть **постоянный диск** (иначе фото пропадут при перезапуске).
- **VPS** (любой Linux): установите Node, скопируйте проект, `NODE_ENV=production npm start` под `pm2` или `systemd`, поставьте перед ним Nginx/Caddy с HTTPS. В Nginx: `client_max_body_size 400m;`, `proxy_pass http://127.0.0.1:3000;`.
- **Render / Railway / Fly.io**: сервис Node, команда запуска `npm start`, подключите Volume/Disk и задайте `DATA_DIR` на его путь (например `/var/data`), переменные из `.env.example` — в настройках сервиса, `NODE_ENV=production`.
- Обязателен HTTPS: cookie владельца помечается `Secure` в production.
- **Резервная копия** = папка `DATA_DIR` целиком.

## Как заменить демо-данные
Войдите как владелец → откройте демо-метку → «Удалить место» (или «Изменить»). Демо-записи помечены тегом «демо».

## Ограничения
- Фото не сжимаются на сервере: перед загрузкой лучше уменьшить до ~2000 px по длинной стороне. HEIC браузеры не показывают — сохраняйте JPG.
- Одна копия сервера (JSON-файл не рассчитан на несколько процессов).
- Карта и шрифты грузятся с CDN (cdnjs, Google Fonts, CARTO). Для большого трафика используйте собственного провайдера плиток.
