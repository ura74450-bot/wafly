FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY server/package.json server/pnpm-lock.yaml ./server/
RUN pnpm --dir server install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 10000
CMD ["pnpm", "start"]
