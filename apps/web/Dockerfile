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

# **建置期的假設定。少了這一段，`docker compose build` 直接失敗。**
#
# `next build` 為了讀出每個路由的 segment config（dynamic、revalidate…）
# 會把每一個 route 模組真的 require 一次。其中 app/api/import/route.ts
# → lib/storage.ts → lib/env.ts，而 lib/env.ts 在模組載入時就驗證設定，
# 缺一項就 process.exit(78)。建置機器上不會有資料庫密碼，於是：
#
#   ⨯ Next.js build worker exited with code: 78 and signal: null
#
# 訊息裡沒有任何一個字提到設定，安裝腳本的第 3／7 步就停在那裡。
#
# 三件事讓這一段是安全的：
#   一、ENV 不跨階段。runner 是新的 FROM，這些值不會進最終映像，
#       執行期缺設定仍然照樣 exit 78 —— 那道防線沒有被拆掉。
#   二、值只在**建置期**被讀，不會被編進產物：Next 只會把
#       NEXT_PUBLIC_* 與 next.config 的 env 內聯，而 lib/env.ts 讀的是
#       整個 process.env 物件。
#   三、主機名一律用 .invalid（RFC 6761 保證永不解析）。萬一哪天有人
#       把這幾行抄到 runner，它會立刻連線失敗，而不是安靜地連到
#       某台真的機器。
#
# 新增必填設定時這裡要一起加。tools/deploy-check.mjs 會盯著。
ENV DATABASE_URL=postgresql://build:build@build.invalid:5432/build \
    REDIS_URL=redis://build.invalid:6379 \
    AUTH_SECRET=BUILD_TIME_PLACEHOLDER_NOT_A_REAL_SECRET_0000000000 \
    APP_URL=https://build.invalid \
    APP_DOMAIN=build.invalid \
    S3_ENDPOINT=http://build.invalid:9000 \
    S3_BUCKET=build \
    S3_ACCESS_KEY=build \
    S3_SECRET_KEY=build

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate --schema packages/db/schema.prisma \
 && npm run build --workspace=apps/web \
 && mkdir -p apps/web/public

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
# public/ 目前不存在，但 Next.js 的慣例是有這個目錄。
# **不可以寫成 `COPY … 2>/dev/null || true`**：Dockerfile 的 COPY
# 不是 shell，那三個字會被當成第 2、3 個來源與目的地，而多來源時
# 目的地必須以 / 結尾——整個映像建不起來，全新安裝在第三步就死。
# builder 階段先確保它存在，這裡就無條件複製。
COPY --from=builder --chown=yunzhi:yunzhi /app/apps/web/public ./apps/web/public

# migration 與 worker 需要 Prisma CLI 與 schema
COPY --from=builder --chown=yunzhi:yunzhi /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=yunzhi:yunzhi /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=yunzhi:yunzhi /app/node_modules/prisma ./node_modules/prisma
# `.bin` 是 npx 唯一會找的地方。scripts/migrate-and-seed.mjs 跑的是
# `npx prisma migrate deploy`，而 npx 找不到本地執行檔時**不會報錯，
# 它會去 registry 下載一份**——離線機器上遷移直接失敗，有網路的機器
# 則靜默換成另一個版本的 Prisma 去動 schema。standalone 產物只帶
# 被追蹤到的 .js，不含 .bin，所以這一行不能省。
COPY --from=builder --chown=yunzhi:yunzhi /app/node_modules/.bin ./node_modules/.bin
COPY --from=builder --chown=yunzhi:yunzhi /app/packages/db ./packages/db
COPY --chown=yunzhi:yunzhi apps/web/scripts ./scripts
# **scripts 與 lib 的相對位置在映像裡必須跟 repo 裡一樣。**
# migrate-and-seed.mjs 與 worker.mjs 都 `import '../lib/tenantContext.mjs'`；
# scripts 落在 /app/scripts，所以 lib 必須落在 /app/lib。少了這一行，
# migrate 容器起來第一秒就 ERR_MODULE_NOT_FOUND，而 web 的 depends_on
# 是 service_completed_successfully——整套堆疊卡在那裡，一個畫面都沒有。
# （lib/*.ts 進來只是順帶，執行期用不到；漏抄比多抄的代價高太多。）
COPY --chown=yunzhi:yunzhi apps/web/lib ./lib

USER yunzhi
EXPOSE 3000

# tini 當 PID 1。沒有它，Node 收不到 SIGTERM 就不會優雅關閉，
# 正在作答的學生那一段未同步的作答就會留在瀏覽器裡。
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
