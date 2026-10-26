# Sproutbound Co-op

Оригинальный браузерный farming-simulator MVP для двух игроков, подготовленный для GitHub и Render. Клиент использует Three.js с процедурными визуальными элементами, а Node.js WebSocket-сервер синхронизирует игроков, грядки, культуры, деньги, день/ночь и действия.

Полная инструкция по запуску, управлению и деплою находится в [README_RENDER.md](README_RENDER.md).

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --dir server install --frozen-lockfile
ALLOWED_ORIGINS=http://localhost:3000 pnpm dev:server
VITE_SERVER_URL=ws://localhost:8787/ws pnpm dev
```

Для Render используется один Web Service из `render.yaml`: он собирает Vite-клиент, запускает `server/authoritative_server.mjs`, отдаёт `/healthz` и принимает WebSocket на `/ws`.
