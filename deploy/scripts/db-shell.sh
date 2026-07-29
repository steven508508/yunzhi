#!/usr/bin/env bash
# 雲端智學 — 資料庫 shell
#
# docker-compose.yml 刻意不對外發布 5432：資料庫只在 internal 網路上，
# 就算 web 容器被打穿也沒有跳板。代價是「我要進去看一下資料」變得麻煩，
# 而麻煩的除錯方式的下場是有人為了方便去 compose 檔加一行 ports —— 那一行
# 會留在正式環境裡好幾年。所以這條路要好走。
#
# 兩種部署模式都能用（docker／原生）。
#
# 用法：
#   ./deploy/scripts/db-shell.sh                         # 互動 psql
#   ./deploy/scripts/db-shell.sh -c 'SELECT count(*) FROM users'
#   ./deploy/scripts/db-shell.sh --readonly              # 唯讀連線，防手滑
#   ./deploy/scripts/db-shell.sh --tenant <id>           # 帶著租戶脈絡進去

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

READONLY=0
TENANT=""
PSQL_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --readonly|--read-only) READONLY=1; shift ;;
    --tenant) TENANT="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) PSQL_ARGS+=("$1"); shift ;;
  esac
done

load_env

# ── 連線期就設好的 GUC ──────────────────────────────────────────
#
# 用 PGOPTIONS 而不是進去之後打 SET：`psql -f init.sql` 跑完就結束，
# 接不上互動 session；而 -c 只能給一句。PGOPTIONS 是在連線建立時
# 套用的，互動與非互動都一樣有效。
PG_OPTS=""

# 資料庫開了 RLS（ENABLE ＋ FORCE）。沒有租戶脈絡就進去的話，
# **每一個 SELECT 都會回 0 列而且不報錯** —— 於是人會得出「資料不見了」
# 的結論，然後開始找一個根本不存在的資料遺失事故。
if [[ -n "${TENANT}" ]]; then
  PG_OPTS+=" -c app.tenant_id=${TENANT}"
fi
if (( READONLY )); then
  PG_OPTS+=" -c default_transaction_read_only=on"
fi

MODE="$(detect_mode)"
info "資料庫 ${POSTGRES_DB}（${MODE} 模式）${TENANT:+｜租戶 ${TENANT}}"
if (( READONLY )); then
  ok "唯讀連線：任何 INSERT／UPDATE／DELETE 都會被拒絕"
fi
if [[ -z "${TENANT}" ]]; then
  warn "沒有指定 --tenant。RLS 之下多數查詢會回 0 列 —— 那不是資料不見了。"
  dim "先查租戶：./deploy/scripts/db-shell.sh -c 'SELECT id,name FROM tenants'"
fi

# 環境變數用陣列傳，不要靠字串展開 —— PG_OPTS 裡有空白，
# 不加引號會被拆成好幾個參數，psql 收到的是一個看不懂的資料庫名稱。
ENV_ARGS=()
[[ -n "${PG_OPTS}" ]] && ENV_ARGS=(-e "PGOPTIONS=${PG_OPTS}")

if [[ "${MODE}" == "docker" ]]; then
  # 互動需要 TTY，所以不能走 common.sh 的 pg_exec（它一律 -T）。
  ( cd "${YZ_ROOT}" && docker compose --env-file .env exec \
      "${ENV_ARGS[@]}" postgres \
      psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" "${PSQL_ARGS[@]}" )
else
  PGPASSWORD="${POSTGRES_PASSWORD}" PGOPTIONS="${PG_OPTS}" psql \
    -h "${POSTGRES_HOST:-127.0.0.1}" -p "${POSTGRES_PORT:-5432}" \
    -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" "${PSQL_ARGS[@]}"
fi
