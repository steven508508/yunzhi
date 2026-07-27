# 雲端智學 — 主應用映像
#
# 多階段建置。最終映像只帶 standalone 產物加上 Prisma engine，
# 從約 1.2GB 降到約 250MB —— 對自架環境的下載、備份、
# 以及離線包的大小都有實質差別。

# ── 相依套件 ───────────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/
COPY packages/db/schema.prisma ./packages/db/
RUN npm ci --ignore-scripts

# ── 建置 ───────────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION} NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate --schema packages/db/schema.prisma \
 && npm run build --workspace=apps/web

# ── 執行 ───────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl curl tini
WORKDIR /app

ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# 非 root。容器逃逸的風險本來就存在，用 root 跑只是把
# 「逃出來之後能做什麼」的答案變成「什麼都能做」。
RUN addgroup -g 10001 -S yunzhi && adduser -u 10001 -S yunzhi -G yunzhi

COPY --from=builder --chown=yunzhi:yunzhi /app/apps/web/.next/standalone ./
COPY --from=builder --chown=yunzhi:yunzhi /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=yunzhi:yunzhi /app/apps/web/public ./apps/web/public 2>/dev/null || true

# migration 與 worker 需要 Prisma CLI 與 schema
COPY --from=builder --chown=yunzhi:yunzhi /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=yunzhi:yunzhi /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=yunzhi:yunzhi /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=yunzhi:yunzhi /app/packages/db ./packages/db
COPY --chown=yunzhi:yunzhi apps/web/scripts ./scripts

USER yunzhi
EXPOSE 3000

# tini 當 PID 1。沒有它，Node 收不到 SIGTERM 就不會優雅關閉，
# 正在作答的學生那一段未同步的作答就會留在瀏覽器裡。
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
