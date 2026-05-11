# Multi-stage: build with the full workspace, ship only the worker dist.
FROM node:22-alpine AS builder
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @tolaria/worker... --prod=false
COPY apps/worker ./apps/worker
RUN pnpm --filter @tolaria/worker build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable
COPY --from=builder /repo/apps/worker/dist ./dist
COPY --from=builder /repo/apps/worker/package.json ./
COPY --from=builder /repo/apps/worker/node_modules ./node_modules
ENV NODE_ENV=production
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]
