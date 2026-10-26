# Sproutbound Co-op server

Небольшой Node.js 22 WebSocket-сервер для кооперативной фермы. Он хранит комнаты в памяти процесса и является источником истины для игроков, грядок, культур, общей кассы, смены дня и действий.

## Локальный запуск

```bash
pnpm install --frozen-lockfile
ALLOWED_ORIGINS=http://localhost:3000 HOST=127.0.0.1 PORT=8787 node authoritative_server.mjs
```

- `GET /healthz` — health check для Render;
- `GET /` — production-клиент из `../dist`;
- `WS /ws?room=ABCD` — комната фермы;
- `PORT` — порт Render подставляет автоматически;
- `HOST=0.0.0.0` используется в production;
- `ALLOWED_ORIGINS` — список разрешённых origin через запятую. Для единого Render-домена можно оставить пустым.

## Сообщения

Клиент отправляет `input` с координатами и `action` (`plant`, `water`, `harvest`, `talk`, `sell`, `sleep`). Сервер рассылает `welcome` и `state`. Комнаты рассчитаны на двух активных игроков и до восьми наблюдателей.

Состояние комнаты не персистентное: при перезапуске процесса комнаты и деньги сбрасываются. Для production-игры с постоянными фермами потребуется база данных и авторизация.
