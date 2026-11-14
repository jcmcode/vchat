FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/signaling-server/package.json packages/signaling-server/
RUN pnpm install --frozen-lockfile --filter @vchat/signaling-server
COPY packages/signaling-server/ packages/signaling-server/
RUN pnpm --filter @vchat/signaling-server build

FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/signaling-server/package.json packages/signaling-server/
RUN pnpm install --frozen-lockfile --filter @vchat/signaling-server --prod
COPY --from=builder /app/packages/signaling-server/dist/ packages/signaling-server/dist/
ENV NODE_ENV=production
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3001/healthz || exit 1
CMD ["node", "packages/signaling-server/dist/index.js"]
