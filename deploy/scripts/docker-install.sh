#!/usr/bin/env bash
# 雲端智學 — Docker 一鍵安裝
#
# 可重複執行。已安裝的環境重跑會變成「確認狀態並補齊缺漏」，
# 不會重建資料庫或覆蓋設定。
#
# 用法：
#   ./deploy/scripts/docker-install.sh
#   ./deploy/scripts/docker-install.sh --yes            # 不互動
#   ./deploy/scripts/docker-install.sh --skip-preflight # 已確認過環境
#   ./deploy/scripts/docker-install.sh --monitoring     # 一併啟用監控

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

SKIP_PREFLIGHT=0
WITH_MONITORING=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) export YZ_ASSUME_YES=1; shift ;;
    --skip-preflight) SKIP_PREFLIGHT=1; shift ;;
    --monitoring) WITH_MONITORING=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

acquire_lock "docker-install"

cat <<'BANNER'

  ╔══════════════════════════════════════════════════════════╗
  ║                      雲端智學                             ║
  ║             學測線上學習與評量系統 — 安裝                  ║
  ╚══════════════════════════════════════════════════════════╝

BANNER

# ═══════════════════════════════════════════════════════════════
section "1／7  安裝前檢查"
# ═══════════════════════════════════════════════════════════════

if (( SKIP_PREFLIGHT )); then
  warn "已指定 --skip-preflight，跳過環境檢查。"
else
  if ! "${YZ_SCRIPTS_DIR}/preflight.sh"; then
    die "安裝前檢查未通過。修正上列失敗項後重試，或加 --skip-preflight 強制繼續（不建議）。"
  fi
fi

# ═══════════════════════════════════════════════════════════════
section "2／7  設定"
# ═══════════════════════════════════════════════════════════════

if [[ ! -f "${YZ_ROOT}/.env" ]]; then
  info "建立 .env 並產生密碼。"
  "${YZ_SCRIPTS_DIR}/gen-secrets.sh"
else
  # 升級情境：.env.example 可能新增了欄位，補齊但不動既有值。
  info "已有 .env，補齊缺漏的自動產生欄位。"
  "${YZ_SCRIPTS_DIR}/gen-secrets.sh" >/dev/null
  ok "設定檔就緒"
fi

load_env
require_env APP_DOMAIN APP_URL POSTGRES_PASSWORD REDIS_PASSWORD AUTH_SECRET S3_SECRET_KEY

APP_VERSION="${APP_VERSION:-$(cat "${YZ_ROOT}/VERSION" 2>/dev/null || echo '0.1.0')}"
export APP_VERSION
PROXY_MODE="${PROXY_MODE:-caddy}"
if [[ "${PROXY_MODE}" == "external" ]]; then
  info "版本 ${APP_VERSION}｜網域 ${APP_DOMAIN}｜代理 外部（綁 ${WEB_BIND:-127.0.0.1}:${WEB_BIND_PORT:-3000}）｜AI ${AI_PROVIDER:-mock}"
else
  info "版本 ${APP_VERSION}｜網域 ${APP_DOMAIN}｜代理 內建 Caddy｜TLS ${TLS_MODE:-internal}｜AI ${AI_PROVIDER:-mock}"
fi

if [[ "${AI_PROVIDER:-mock}" == "mock" ]]; then
  warn "AI_PROVIDER=mock —— AI 功能會回傳假資料。"
  warn "正式使用前請在 .env 設定 AI_PROVIDER 與 AI_API_KEY，然後執行："
  dim "  ./deploy/scripts/docker-install.sh   # 重跑即可套用"
fi

# 備份目錄要在啟動前存在，否則 backup 容器會掛載出一個 root 擁有的目錄
mkdir -p "${BACKUP_DIR:-${YZ_ROOT}/data/backups}" "${YZ_ROOT}/data/models"

# ═══════════════════════════════════════════════════════════════
section "3／7  建置映像"
# ═══════════════════════════════════════════════════════════════

info "建置中。第一次會下載基底映像，視網路可能需要 5 至 15 分鐘。"
export YZ_ERROR_HINT="建置失敗常見原因：對外網路不通（離線環境請用 build-offline-bundle.sh）、或磁碟空間不足。"
compose build --pull
unset YZ_ERROR_HINT
ok "映像建置完成"

# ═══════════════════════════════════════════════════════════════
section "4／7  啟動基礎服務"
# ═══════════════════════════════════════════════════════════════

# 分階段啟動而不是一次 up -d 全部。
# 理由是失敗定位：資料庫起不來時，分階段能立刻指出是資料庫，
# 而一次全上只會看到一堆服務同時在重啟迴圈裡。
info "啟動 PostgreSQL、Redis、MinIO…"
compose up -d postgres redis minio

info "等待資料庫就緒…"
for i in {1..60}; do
  if compose exec -T postgres pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; then
    ok "PostgreSQL 就緒"
    break
  fi
  (( i == 60 )) && die "PostgreSQL 在 120 秒內未就緒。查看日誌：docker compose logs postgres"
  sleep 2
done

# WAL 歸檔目錄的擁有者必須是 postgres，否則 archive_command 會
# 每次都失敗，而 Postgres 會保留所有 WAL 直到磁碟寫滿。
# 這是很難診斷的故障，所以在安裝時就處理掉。
if [[ "${WAL_ARCHIVE_ENABLED:-true}" == "true" ]]; then
  compose exec -T --user root postgres sh -c \
    'mkdir -p /var/lib/postgresql/wal_archive && chown postgres:postgres /var/lib/postgresql/wal_archive' \
    >/dev/null 2>&1 || warn "無法設定 WAL 歸檔目錄權限，請手動確認。"
  ok "WAL 歸檔目錄就緒（RPO 目標 15 分鐘）"
fi

info "建立物件儲存 bucket…"
compose exec -T minio sh -c "
  mc alias set local http://localhost:9000 '${S3_ACCESS_KEY}' '${S3_SECRET_KEY}' >/dev/null 2>&1
  mc mb --ignore-existing local/${S3_BUCKET} >/dev/null 2>&1
  mc anonymous set none local/${S3_BUCKET} >/dev/null 2>&1
" || warn "bucket 建立可能失敗，稍後可用 doctor.sh 檢查。"
ok "物件儲存就緒"

# ═══════════════════════════════════════════════════════════════
section "5／7  資料庫遷移"
# ═══════════════════════════════════════════════════════════════

# 已有資料時，先備份再遷移。這是不可省略的一步 ——
# 遷移失敗到一半的資料庫，沒有備份就只能靠手工修。
existing_tables="$(compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo 0)"

if (( existing_tables > 0 )); then
  info "偵測到既有資料（${existing_tables} 張表），遷移前先備份。"
  "${YZ_SCRIPTS_DIR}/backup.sh" --tag "pre-migrate" --quiet \
    || die "遷移前備份失敗，已中止。沒有備份就不做遷移。"
fi

info "執行遷移…"
compose run --rm migrate
ok "資料庫結構就緒"

# ═══════════════════════════════════════════════════════════════
section "6／7  啟動應用"
# ═══════════════════════════════════════════════════════════════

compose up -d web worker ai backup

if [[ "${PROXY_MODE}" == "external" ]]; then
  info "PROXY_MODE=external，不啟動內建 Caddy。"
  dim "應用綁在 ${WEB_BIND:-127.0.0.1}:${WEB_BIND_PORT:-3000}，等待既有的 nginx 轉發。"
else
  compose --profile caddy up -d caddy
fi

if (( WITH_MONITORING )) || [[ "${MONITORING_ENABLED:-false}" == "true" ]]; then
  info "啟用監控…"
  compose --profile monitoring up -d
fi

# ═══════════════════════════════════════════════════════════════
section "7／7  驗證"
# ═══════════════════════════════════════════════════════════════

# 內部驗證優先於外部：先確認應用本身好了，再確認 Caddy 通了。
# 反過來的話，Caddy 的 502 分不清是應用沒好還是代理設錯。
wait_for_http "http://127.0.0.1:3000/api/readyz" 180 "主應用" 2>/dev/null \
  || compose exec -T web node -e "
      fetch('http://127.0.0.1:3000/api/readyz')
        .then(r=>r.json()).then(j=>{console.log(JSON.stringify(j)); process.exit(j.ready?0:1)})
        .catch(e=>{console.error(e.message); process.exit(1)})" \
  || die "主應用未就緒。查看日誌：docker compose logs web"
ok "主應用就緒"

if compose exec -T ai python -c "
import urllib.request,sys,json
r=urllib.request.urlopen('http://127.0.0.1:8000/readyz',timeout=10)
sys.exit(0 if r.status==200 else 1)" 2>/dev/null; then
  ok "AI 服務就緒"

  # 設定看起來對，不等於設定真的對。實際打一次上游。
  if [[ "${AI_PROVIDER:-mock}" != "mock" ]]; then
    info "驗證 AI 上游連線（實際呼叫一次）…"
    if compose exec -T ai python -c "
import urllib.request,json,sys
req=urllib.request.Request('http://127.0.0.1:8000/selftest',method='POST')
d=json.load(urllib.request.urlopen(req,timeout=120))
print(json.dumps(d['tiers'],ensure_ascii=False))
sys.exit(0 if d['ok'] else 1)"; then
      ok "AI 上游三個層級全部連通"
    else
      warn "AI 上游驗證失敗。系統仍可運作（考試、客觀題評分、既有解析不受影響），"
      warn "但 AI 功能不可用。請檢查 AI_BASE_URL、AI_API_KEY 與模型名稱。"
    fi
  fi
else
  warn "AI 服務未就緒。這**不會**影響考試與客觀題評分（見規格書文件 01 §16 的降級要求）。"
fi

# 排一次還原演練提醒。備份沒驗證過等於沒有備份。
compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "
  INSERT INTO deployment_records (id, \"appVersion\", \"schemaVersion\", action, \"finishedAt\", succeeded)
  VALUES (md5(random()::text), '${APP_VERSION}', 'current', 'install', now(), true)
  ON CONFLICT DO NOTHING;" >/dev/null 2>&1 || true

echo
cat <<EOF
  ╔══════════════════════════════════════════════════════════╗
  ║  安裝完成                                                 ║
  ╚══════════════════════════════════════════════════════════╝

  網址        ${APP_URL}
  管理帳號    ${BOOTSTRAP_ADMIN_USERNAME:-admin}
  密碼        見 .env 的 BOOTSTRAP_ADMIN_PASSWORD（首次登入強制更換）

  常用指令
    狀態        ./deploy/scripts/doctor.sh
    日誌        docker compose logs -f web
    備份        ./deploy/scripts/backup.sh
    還原演練    ./deploy/scripts/verify-restore.sh
    升級        ./deploy/scripts/upgrade.sh
    解除安裝    ./deploy/scripts/docker-uninstall.sh

EOF

if [[ "${PROXY_MODE}" == "external" ]]; then
  warn "還差最後一步：設定 nginx 把流量轉進來。"
  dim "  sudo ./deploy/scripts/setup-nginx.sh"
  dim ""
  dim "它會產生站台設定、代入你的網域、建立維護頁，"
  dim "並在 nginx -t 通過之後才 reload —— 設定有錯不會影響機器上其他站台。"
  echo
elif [[ "${TLS_MODE:-internal}" == "internal" ]]; then
  warn "TLS_MODE=internal：Caddy 用本地 CA 簽發憑證，瀏覽器會出現警告。"
  dim "匯出根憑證交給 MIS 派送到學生電腦："
  dim "  ./deploy/scripts/export-ca.sh"
  dim ""
  dim "這個根憑證只讓瀏覽器信任本站，不會也不能用來解密其他網站的流量——"
  dim "與規格書文件 08 明確否決的 TLS 攔截是完全不同的東西。"
  echo
fi

warn "上線前務必完成兩件事："
dim "1. 執行一次還原演練並記錄 RTO：./deploy/scripts/verify-restore.sh"
dim "   未驗證過的備份等於沒有備份。"
dim "2. 把 .env 備份到密碼管理器或離線儲存。"
dim "   遺失 BACKUP_ENCRYPTION_KEY 等於所有加密備份作廢。"
echo
