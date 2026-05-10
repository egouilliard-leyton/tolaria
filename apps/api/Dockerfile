# Multi-stage: build with the full workspace, ship only the api dist.
FROM node:22-alpine AS builder
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @tolaria/api... --prod=false
COPY apps/api ./apps/api
RUN pnpm --filter @tolaria/api build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable
COPY --from=builder /repo/apps/api/dist ./dist
COPY --from=builder /repo/apps/api/package.json ./
COPY --from=builder /repo/apps/api/node_modules ./node_modules
ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "--enable-source-maps", "dist/index.js"]
