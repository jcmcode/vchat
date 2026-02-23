FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/signaling-server/package.json packages/signaling-server/
RUN pnpm install --frozen-lockfile --filter @vchat/signaling-server
COPY packages/signaling-server/ packages/signaling-server/
RUN pnpm --filter @vchat/signaling-server build

FROM node:20-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/signaling-server/package.json packages/signaling-server/
RUN pnpm install --frozen-lockfile --filter @vchat/signaling-server --prod
COPY --from=builder /app/packages/signaling-server/dist/ packages/signaling-server/dist/
EXPOSE 3001
CMD ["node", "packages/signaling-server/dist/index.js"]
