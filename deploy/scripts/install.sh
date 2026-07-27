#!/usr/bin/env bash
# 雲端智學 — 原生安裝（不使用 Docker）
#
# 適用於不能或不想跑 Docker 的環境。所有東西都裝在明確的位置，
# 並由 uninstall.sh 完整移除。
#
# 安裝清單（每一項 uninstall.sh 都會處理）：
#   系統套件      postgresql-16 postgresql-16-pgvector redis-server nodejs python3
#   專用使用者    yunzhi（系統帳號，不可登入，無家目錄殼層）
#   程式          /opt/yunzhi
#   設定          /etc/yunzhi
#   資料          /var/lib/yunzhi
#   日誌          /var/log/yunzhi
#   備份          /var/backups/yunzhi
#   systemd       yunzhi-web / yunzhi-worker / yunzhi-ai / yunzhi-backup.timer
#   logrotate     /etc/logrotate.d/yunzhi
#   Caddy         由官方套件庫安裝，設定在 /etc/caddy/Caddyfile
#
# 用法：
#   sudo ./deploy/scripts/install.sh
#   sudo ./deploy/scripts/install.sh --yes --skip-preflight

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

SKIP_PREFLIGHT=0
SKIP_PACKAGES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) export YZ_ASSUME_YES=1; shift ;;
    --skip-preflight) SKIP_PREFLIGHT=1; shift ;;
    --skip-packages) SKIP_PACKAGES=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

need_root
acquire_lock "native-install"

readonly YZ_USER="yunzhi"
readonly YZ_GROUP="yunzhi"
readonly OPT_DIR="/opt/yunzhi"
readonly ETC_DIR="/etc/yunzhi"
readonly VAR_DIR="/var/lib/yunzhi"
readonly LOG_DIR="/var/log/yunzhi"
readonly BAK_DIR="/var/backups/yunzhi"
readonly PG_VERSION=16

# 安裝清單。uninstall.sh 讀同一份，所以兩邊永遠一致 ——
# 手抄兩份清單就是殘留物的來源。
readonly MANIFEST="${ETC_DIR}/install-manifest.txt"

cat <<'BANNER'

  ╔══════════════════════════════════════════════════════════╗
  ║           雲端智學 — 原生安裝（Ubuntu Server）             ║
  ╚══════════════════════════════════════════════════════════╝

BANNER

# ═══════════════════════════════════════════════════════════════
section "1／9  安裝前檢查"
# ═══════════════════════════════════════════════════════════════

if (( SKIP_PREFLIGHT )); then
  warn "跳過環境檢查。"
else
  "${YZ_SCRIPTS_DIR}/preflight.sh" --native || die "安裝前檢查未通過。"
fi

confirm_phrase "將在此機器上安裝雲端智學（系統套件、專用使用者、systemd 服務）。" "INSTALL"

mkdir -p "${ETC_DIR}"
: > "${MANIFEST}"
record() { printf '%s\t%s\n' "$1" "$2" >> "${MANIFEST}"; }

# ═══════════════════════════════════════════════════════════════
section "2／9  系統套件"
# ═══════════════════════════════════════════════════════════════

if (( SKIP_PACKAGES )); then
  warn "跳過套件安裝。"
else
  export DEBIAN_FRONTEND=noninteractive

  info "更新套件索引…"
  apt-get update -qq

  # Node.js 22 不在 Ubuntu 24.04 的預設庫中
  if ! command -v node >/dev/null 2>&1 || (( $(node -v | tr -d 'v' | cut -d. -f1) < 22 )); then
    info "加入 NodeSource 套件庫…"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    record repo /etc/apt/sources.list.d/nodesource.list
  fi

  # Caddy 官方庫
  if ! command -v caddy >/dev/null 2>&1; then
    info "加入 Caddy 套件庫…"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    record repo /etc/apt/sources.list.d/caddy-stable.list
    record file /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    apt-get update -qq
  fi

  PACKAGES=(
    "postgresql-${PG_VERSION}"
    "postgresql-contrib-${PG_VERSION}"
    "postgresql-${PG_VERSION}-pgvector"
    redis-server
    nodejs
    python3 python3-venv python3-pip
    caddy
    minio  # 若套件庫沒有，下方會退回二進位安裝
    openssl curl jq acl
  )

  info "安裝套件…"
  for pkg in "${PACKAGES[@]}"; do
    if dpkg -l "${pkg}" 2>/dev/null | grep -q '^ii'; then
      dim "${pkg}（已安裝，不記入移除清單）"
    elif apt-get install -y -qq "${pkg}" >/dev/null 2>&1; then
      ok "${pkg}"
      record package "${pkg}"
    else
      if [[ "${pkg}" == "minio" ]]; then
        info "套件庫沒有 minio，改用官方二進位…"
        curl -fsSL https://dl.min.io/server/minio/release/linux-amd64/minio -o /usr/local/bin/minio
        chmod +x /usr/local/bin/minio
        record file /usr/local/bin/minio
        ok "minio（二進位）"
      else
        die "安裝 ${pkg} 失敗。"
      fi
    fi
  done
fi

# ═══════════════════════════════════════════════════════════════
section "3／9  專用使用者與目錄"
# ═══════════════════════════════════════════════════════════════

# 系統帳號、不可登入、無家目錄。應用被入侵時，攻擊者拿到的是
# 一個什麼都不能做的帳號，而不是一個能 SSH 出去的立足點。
if ! id -u "${YZ_USER}" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin \
          --home-dir "${VAR_DIR}" --comment "雲端智學服務帳號" "${YZ_USER}"
  record user "${YZ_USER}"
  ok "建立使用者 ${YZ_USER}"
else
  dim "使用者 ${YZ_USER} 已存在"
fi

for d in "${OPT_DIR}" "${ETC_DIR}" "${VAR_DIR}" "${LOG_DIR}" "${BAK_DIR}" "${VAR_DIR}/objects" "${VAR_DIR}/models"; do
  mkdir -p "${d}"
  chown "${YZ_USER}:${YZ_GROUP}" "${d}"
  record dir "${d}"
done
chmod 750 "${ETC_DIR}" "${BAK_DIR}"
chmod 755 "${OPT_DIR}" "${VAR_DIR}" "${LOG_DIR}"
ok "目錄就緒"

# ═══════════════════════════════════════════════════════════════
section "4／9  設定"
# ═══════════════════════════════════════════════════════════════

if [[ ! -f "${ETC_DIR}/env" ]]; then
  cp "${YZ_ROOT}/.env.example" "${ETC_DIR}/env"
  chmod 600 "${ETC_DIR}/env"
  chown "${YZ_USER}:${YZ_GROUP}" "${ETC_DIR}/env"
  # 原生安裝時所有服務都在 localhost
  sed -i \
    -e 's|^POSTGRES_HOST=.*|POSTGRES_HOST=127.0.0.1|' \
    -e 's|^REDIS_HOST=.*|REDIS_HOST=127.0.0.1|' \
    -e 's|^S3_ENDPOINT=.*|S3_ENDPOINT=http://127.0.0.1:9000|' \
    -e "s|^BACKUP_DIR=.*|BACKUP_DIR=${BAK_DIR}|" \
    "${ETC_DIR}/env"
  "${YZ_SCRIPTS_DIR}/gen-secrets.sh" --file "${ETC_DIR}/env"
fi
record file "${ETC_DIR}/env"

# 讓專案根目錄的 .env 指向正式設定，好讓其他腳本（backup、doctor）
# 不必分辨自己跑在哪一種部署上。
ln -sfn "${ETC_DIR}/env" "${YZ_ROOT}/.env"
load_env "${ETC_DIR}/env"
ok "設定就緒"

# ═══════════════════════════════════════════════════════════════
section "5／9  PostgreSQL"
# ═══════════════════════════════════════════════════════════════

PG_CONF_DIR="/etc/postgresql/${PG_VERSION}/main"

systemctl enable --now postgresql >/dev/null 2>&1 || true

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${POSTGRES_USER}'" | grep -q 1; then
  # CREATEDB 是必要的，不是多給的權限：還原演練（verify-restore.sh）
  # 要建立一個獨立的演練資料庫，才能在不碰正式資料的前提下驗證備份。
  # 少了它，演練會在「permission denied to create database」失敗，
  # 而那是只有在真的需要還原時才會被發現的問題。
  sudo -u postgres psql -c "CREATE ROLE ${POSTGRES_USER} LOGIN CREATEDB PASSWORD '${POSTGRES_PASSWORD}';" >/dev/null
  ok "建立資料庫角色"
  record pgrole "${POSTGRES_USER}"
else
  sudo -u postgres psql -c "ALTER ROLE ${POSTGRES_USER} CREATEDB PASSWORD '${POSTGRES_PASSWORD}';" >/dev/null
  dim "資料庫角色已存在，已更新密碼與 CREATEDB 權限"
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB}'" | grep -q 1; then
  sudo -u postgres createdb -O "${POSTGRES_USER}" "${POSTGRES_DB}"
  ok "建立資料庫 ${POSTGRES_DB}"
  record pgdb "${POSTGRES_DB}"
fi

sudo -u postgres psql -d "${POSTGRES_DB}" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" \
  -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;" >/dev/null
ok "擴充功能就緒"

# 效能與 WAL 歸檔設定用 include 檔而不是直接改 postgresql.conf。
# 這樣移除時只要刪掉一個檔案，不必去 postgresql.conf 裡挑出
# 哪幾行是我們加的 —— 那是原生安裝殘留物的主要來源。
WAL_DIR="${VAR_DIR}/wal_archive"
mkdir -p "${WAL_DIR}"
chown postgres:postgres "${WAL_DIR}"
record dir "${WAL_DIR}"

cat > "${PG_CONF_DIR}/conf.d/yunzhi.conf" <<EOF
# 由雲端智學 install.sh 產生。移除時整個檔案刪除即可。
shared_buffers = ${POSTGRES_SHARED_BUFFERS:-512MB}
max_connections = ${POSTGRES_MAX_CONNECTIONS:-200}
work_mem = 8MB
random_page_cost = 1.1
wal_level = replica
archive_mode = on
archive_command = 'test ! -f ${WAL_DIR}/%f && cp %p ${WAL_DIR}/%f'
archive_timeout = 900
autovacuum_vacuum_scale_factor = 0.05
log_min_duration_statement = 1000
timezone = 'Asia/Taipei'
shared_preload_libraries = 'pg_stat_statements'
EOF
record file "${PG_CONF_DIR}/conf.d/yunzhi.conf"

grep -q "include_dir 'conf.d'" "${PG_CONF_DIR}/postgresql.conf" \
  || echo "include_dir 'conf.d'" >> "${PG_CONF_DIR}/postgresql.conf"

systemctl restart postgresql
ok "PostgreSQL 已設定（WAL 歸檔至 ${WAL_DIR}）"

# ═══════════════════════════════════════════════════════════════
section "6／9  Redis"
# ═══════════════════════════════════════════════════════════════

cat > /etc/redis/redis.conf.d/yunzhi.conf 2>/dev/null <<EOF || {
requirepass ${REDIS_PASSWORD}
appendonly yes
appendfsync everysec
maxmemory-policy noeviction
bind 127.0.0.1
EOF
  # 舊版 Redis 沒有 conf.d，退回直接改主設定並記錄備份
  mkdir -p /etc/redis
  cp /etc/redis/redis.conf "/etc/redis/redis.conf.yunzhi-backup"
  record file "/etc/redis/redis.conf.yunzhi-backup"
  {
    echo "# --- 雲端智學 ---"
    echo "requirepass ${REDIS_PASSWORD}"
    echo "appendonly yes"
    echo "maxmemory-policy noeviction"
  } >> /etc/redis/redis.conf
}
record file /etc/redis/redis.conf.d/yunzhi.conf
systemctl restart redis-server
ok "Redis 已設定"

# ═══════════════════════════════════════════════════════════════
section "7／9  部署程式"
# ═══════════════════════════════════════════════════════════════

info "複製程式到 ${OPT_DIR}…"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude data --exclude .env \
  "${YZ_ROOT}/" "${OPT_DIR}/"

info "安裝 Node 相依套件並建置…"
( cd "${OPT_DIR}" && npm ci --omit=dev --silent && npm run db:generate --silent && npm run build --silent )

info "建立 Python 虛擬環境…"
python3 -m venv "${OPT_DIR}/apps/ai/.venv"
"${OPT_DIR}/apps/ai/.venv/bin/pip" install -q --upgrade pip
"${OPT_DIR}/apps/ai/.venv/bin/pip" install -q -r "${OPT_DIR}/apps/ai/requirements.txt"

chown -R "${YZ_USER}:${YZ_GROUP}" "${OPT_DIR}"
ok "程式部署完成"

info "執行資料庫遷移…"
( cd "${OPT_DIR}" && sudo -u "${YZ_USER}" \
    DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}" \
    npx prisma migrate deploy --schema packages/db/schema.prisma )
ok "資料庫結構就緒"

# ═══════════════════════════════════════════════════════════════
section "8／9  systemd 服務"
# ═══════════════════════════════════════════════════════════════

for unit in yunzhi-web yunzhi-worker yunzhi-ai yunzhi-minio yunzhi-backup; do
  src="${YZ_ROOT}/deploy/systemd/${unit}.service"
  [[ -f "${src}" ]] || continue
  install -m 644 "${src}" "/etc/systemd/system/${unit}.service"
  record systemd "${unit}.service"
done
if [[ -f "${YZ_ROOT}/deploy/systemd/yunzhi-backup.timer" ]]; then
  install -m 644 "${YZ_ROOT}/deploy/systemd/yunzhi-backup.timer" /etc/systemd/system/
  record systemd "yunzhi-backup.timer"
fi

# 讓 systemd 單元不必寫死路徑
cat > /etc/default/yunzhi <<EOF
YZ_OPT_DIR=${OPT_DIR}
YZ_ETC_DIR=${ETC_DIR}
YZ_VAR_DIR=${VAR_DIR}
YZ_LOG_DIR=${LOG_DIR}
EOF
record file /etc/default/yunzhi

install -m 644 "${YZ_ROOT}/deploy/logrotate/yunzhi" /etc/logrotate.d/yunzhi 2>/dev/null && record file /etc/logrotate.d/yunzhi || true

systemctl daemon-reload
systemctl enable --now yunzhi-minio yunzhi-ai yunzhi-web yunzhi-worker >/dev/null 2>&1
systemctl enable --now yunzhi-backup.timer >/dev/null 2>&1 || true
ok "服務已啟用"

info "設定 Caddy…"
cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.yunzhi-backup" 2>/dev/null && record file "/etc/caddy/Caddyfile.yunzhi-backup"
sed -e "s|{\$APP_DOMAIN}|${APP_DOMAIN}|g" -e "s|{\$ACME_EMAIL}|${ACME_EMAIL:-}|g" \
    "${YZ_ROOT}/deploy/caddy/Caddyfile" \
  | sed -e 's|reverse_proxy web:3000|reverse_proxy 127.0.0.1:3000|' \
        -e 's|reverse_proxy grafana:3000|reverse_proxy 127.0.0.1:3001|' \
  > /etc/caddy/Caddyfile
record file /etc/caddy/Caddyfile
systemctl reload caddy 2>/dev/null || systemctl restart caddy
ok "Caddy 已設定"

# ═══════════════════════════════════════════════════════════════
section "9／9  驗證"
# ═══════════════════════════════════════════════════════════════

wait_for_http "http://127.0.0.1:3000/api/readyz" 120 "主應用" \
  || { err "主應用未就緒。診斷：journalctl -u yunzhi-web -n 50"; }
wait_for_http "http://127.0.0.1:8000/healthz" 120 "AI 服務" \
  || warn "AI 服務未就緒。考試與客觀題評分不受影響。"

chmod 600 "${ETC_DIR}/env"

echo
cat <<EOF
  ╔══════════════════════════════════════════════════════════╗
  ║  安裝完成                                                 ║
  ╚══════════════════════════════════════════════════════════╝

  網址      ${APP_URL}
  設定      ${ETC_DIR}/env
  程式      ${OPT_DIR}
  資料      ${VAR_DIR}
  日誌      ${LOG_DIR}（journalctl -u yunzhi-web -f）
  備份      ${BAK_DIR}
  清單      ${MANIFEST}

  服務控制
    systemctl status yunzhi-web yunzhi-worker yunzhi-ai
    systemctl restart yunzhi-web

  解除安裝
    sudo ./deploy/scripts/uninstall.sh --dry-run    # 先看會刪什麼
    sudo ./deploy/scripts/uninstall.sh

EOF

warn "安裝清單寫在 ${MANIFEST}。"
dim "uninstall.sh 讀這份清單，只移除本次安裝新增的東西 ——"
dim "安裝前就存在的套件（例如機器上本來就有的 PostgreSQL）不會被動到。"
echo
