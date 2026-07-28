#!/usr/bin/env bash
# 雲端智學 — 系統診斷
#
# 「現在到底哪裡不對」的單一入口。設計目標是讓一位不熟悉這套
# 系統的維運人員，在半夜接到電話時執行這一支就能定位問題。
#
# 每一項檢查失敗時都給出**下一步該做什麼**，而不只是說它壞了。
#
# 用法：
#   ./deploy/scripts/doctor.sh
#   ./deploy/scripts/doctor.sh --config-only    # 只檢查設定
#   ./deploy/scripts/doctor.sh --json           # 給監控系統用

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CONFIG_ONLY=0
JSON_OUT=0
FAILURES=0
WARNINGS=0
declare -a JSON_ITEMS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-only) CONFIG_ONLY=1; shift ;;
    --json) JSON_OUT=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

set +e
trap - ERR

_record() { JSON_ITEMS+=("{\"check\":\"$1\",\"status\":\"$2\",\"detail\":\"${3//\"/\\\"}\"}"); }
pass() { (( JSON_OUT )) || ok "$2";   _record "$1" ok   "$2"; }
fail() { (( JSON_OUT )) || err "$2";  _record "$1" fail "$2"; FAILURES=$((FAILURES+1));
         [[ -n "${3:-}" ]] && { (( JSON_OUT )) || dim "→ $3"; }; }
soft() { (( JSON_OUT )) || warn "$2"; _record "$1" warn "$2"; WARNINGS=$((WARNINGS+1));
         [[ -n "${3:-}" ]] && { (( JSON_OUT )) || dim "→ $3"; }; }

MODE="unknown"
if [[ -f /etc/systemd/system/yunzhi-web.service ]]; then MODE="native"
elif docker ps --filter 'name=yunzhi' --format '{{.Names}}' 2>/dev/null | grep -q .; then MODE="docker"
elif [[ -f "${YZ_ROOT}/docker-compose.yml" ]]; then MODE="docker"
fi

(( JSON_OUT )) || { echo; printf '%s雲端智學系統診斷（%s 模式）%s\n' "${C_BOLD}" "${MODE}" "${C_RESET}"; }

# ═══════════════════════════════════════════════════════════════
(( JSON_OUT )) || section "設定"
# ═══════════════════════════════════════════════════════════════

ENV_FILE=""
[[ -f "${YZ_ROOT}/.env" ]] && ENV_FILE="${YZ_ROOT}/.env"
[[ -f /etc/yunzhi/env ]] && ENV_FILE=/etc/yunzhi/env

if [[ -n "${ENV_FILE}" ]]; then
  _tz="${TZ:-}"
  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a
  if [[ -n "${_tz}" ]]; then export TZ="${_tz}"; else unset TZ; fi
  pass config.file "設定檔 ${ENV_FILE}"

  perms="$(stat -Lc '%a' "${ENV_FILE}" 2>/dev/null)"
  if [[ "${perms}" == "600" || "${perms}" == "400" ]]; then
    pass config.perms "設定檔權限 ${perms}"
  else
    fail config.perms "設定檔權限 ${perms}，含密碼與 API key" "chmod 600 ${ENV_FILE}"
  fi

  for v in APP_DOMAIN APP_URL POSTGRES_PASSWORD REDIS_PASSWORD AUTH_SECRET S3_SECRET_KEY; do
    [[ -n "${!v:-}" ]] || fail "config.${v}" "${v} 未設定" "./deploy/scripts/gen-secrets.sh"
  done
  (( ${#AUTH_SECRET} >= 32 )) || fail config.authsecret "AUTH_SECRET 過短（${#AUTH_SECRET}）" "./deploy/scripts/gen-secrets.sh --rotate AUTH_SECRET"

  if [[ "${AI_PROVIDER:-mock}" == "mock" ]]; then
    soft config.ai "AI_PROVIDER=mock，AI 功能回傳假資料" "正式使用請設定 AI_PROVIDER 與 AI_API_KEY"
  else
    pass config.ai "AI provider = ${AI_PROVIDER}${AI_BASE_URL:+（${AI_BASE_URL}）}"
  fi

  if [[ "${WAL_ARCHIVE_ENABLED:-true}" == "true" ]]; then
    pass config.wal "WAL 歸檔已啟用（RPO 目標 15 分鐘）"
  else
    soft config.wal "WAL 歸檔未啟用，RPO 退化為 24 小時" "在 .env 設定 WAL_ARCHIVE_ENABLED=true"
  fi
else
  fail config.file "找不到設定檔" "cp .env.example .env && ./deploy/scripts/gen-secrets.sh"
fi

if (( CONFIG_ONLY )); then
  (( JSON_OUT )) && printf '{"failures":%d,"warnings":%d,"checks":[%s]}\n' "${FAILURES}" "${WARNINGS}" "$(IFS=,; echo "${JSON_ITEMS[*]}")"
  exit $(( FAILURES > 0 ? 1 : 0 ))
fi

# ═══════════════════════════════════════════════════════════════
(( JSON_OUT )) || section "服務"
# ═══════════════════════════════════════════════════════════════

if [[ "${MODE}" == "docker" ]]; then
  for svc in postgres redis minio web worker ai caddy; do
    state="$(compose ps --format '{{.State}}' "${svc}" 2>/dev/null | head -1)"
    health="$(compose ps --format '{{.Health}}' "${svc}" 2>/dev/null | head -1)"
    case "${state}" in
      running)
        if [[ "${health}" == "unhealthy" ]]; then
          fail "svc.${svc}" "${svc} 執行中但健康檢查失敗" "docker compose logs --tail 50 ${svc}"
        elif [[ "${health}" == "starting" ]]; then
          soft "svc.${svc}" "${svc} 啟動中" "稍候再查"
        else
          pass "svc.${svc}" "${svc} 正常"
        fi ;;
      restarting) fail "svc.${svc}" "${svc} 在重啟迴圈中" "docker compose logs --tail 100 ${svc}｜多半是設定錯誤或相依服務未就緒" ;;
      exited|"")  fail "svc.${svc}" "${svc} 未執行" "docker compose up -d ${svc}" ;;
      *)          soft "svc.${svc}" "${svc} 狀態 ${state}" "" ;;
    esac
  done
elif [[ "${MODE}" == "native" ]]; then
  for u in yunzhi-web yunzhi-worker yunzhi-ai yunzhi-minio postgresql redis-server caddy; do
    systemctl list-unit-files 2>/dev/null | grep -q "^${u}" || continue
    if systemctl is-active --quiet "${u}"; then
      pass "svc.${u}" "${u} 正常"
    else
      st="$(systemctl is-active "${u}" 2>/dev/null)"
      fail "svc.${u}" "${u} 狀態 ${st}" "journalctl -u ${u} -n 50 --no-pager"
    fi
  done
fi

# ═══════════════════════════════════════════════════════════════
(( JSON_OUT )) || section "連通性"
# ═══════════════════════════════════════════════════════════════

# 走 common.sh 的統一包裝，兩種部署模式共用同一份邏輯
pg_query() { pg_scalar "$1"; }
export YZ_MODE="${MODE}"

if [[ "$(pg_query 'SELECT 1')" == "1" ]]; then
  pass db.connect "資料庫連線正常"

  tables="$(pg_query "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  if (( ${tables:-0} > 0 )); then
    pass db.schema "資料表 ${tables} 張"
  else
    fail db.schema "資料庫是空的，遷移未執行" "docker compose run --rm migrate"
  fi

  # 連線數快滿是「還沒壞但快壞了」的典型訊號，
  # 而它爆掉的時間點通常是全班同時交卷的那一刻。
  conns="$(pg_query "SELECT count(*) FROM pg_stat_activity")"
  maxc="$(pg_query "SHOW max_connections")"
  if (( ${maxc:-0} > 0 )); then
    pct=$(( ${conns:-0} * 100 / maxc ))
    if (( pct > 85 )); then
      fail db.connections "連線數 ${conns}/${maxc}（${pct}%）" "接近上限，交卷尖峰會被拒。調高 POSTGRES_MAX_CONNECTIONS 或降低 DATABASE_POOL_MAX"
    elif (( pct > 70 )); then
      soft db.connections "連線數 ${conns}/${maxc}（${pct}%）" "留意尖峰"
    else
      pass db.connections "連線數 ${conns}/${maxc}"
    fi
  fi

  # 長交易會擋住 autovacuum，讓資料表持續膨脹
  longtx="$(pg_query "SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction' AND now()-state_change > interval '10 minutes'")"
  (( ${longtx:-0} > 0 )) && soft db.longtx "${longtx} 個閒置交易超過 10 分鐘" "會阻擋 autovacuum，檢查應用是否有未關閉的交易"

  dbsize="$(pg_query "SELECT pg_size_pretty(pg_database_size('${POSTGRES_DB}'))")"
  pass db.size "資料庫大小 ${dbsize}"
else
  fail db.connect "資料庫連不上" "檢查 POSTGRES_PASSWORD 是否與資料庫實際密碼一致；docker compose logs postgres"
fi

if [[ "${MODE}" == "docker" ]]; then
  if compose exec -T redis redis-cli -a "${REDIS_PASSWORD}" ping 2>/dev/null | grep -q PONG; then
    pass redis "Redis 正常"
  else
    fail redis "Redis 連不上" "docker compose logs redis"
  fi
else
  if redis-cli -a "${REDIS_PASSWORD}" ping 2>/dev/null | grep -q PONG; then
    pass redis "Redis 正常"
  else
    fail redis "Redis 連不上" "journalctl -u redis-server -n 30"
  fi
fi

readyz="$(curl -fsS --max-time 8 http://127.0.0.1:3000/api/readyz 2>/dev/null)"
if [[ -n "${readyz}" ]] && grep -q '"ready":true' <<<"${readyz}"; then
  pass web.ready "主應用就緒"
else
  fail web.ready "主應用未就緒" "docker compose logs --tail 50 web；或 journalctl -u yunzhi-web -n 50"
fi

# Docker 模式的 AI 服務沒有發布任何埠（它只在 internal 網路上），
# 所以不能從宿主機打。直接打的話**每次跑 doctor 都會固定出現一則
# 警告**，而那會訓練維護老師忽略 doctor 的輸出——doctor 正是出事
# 時唯一的觀測手段。
if command -v docker >/dev/null 2>&1 && docker compose ps ai >/dev/null 2>&1; then
  ai_ready="$(docker compose exec -T ai python -c \
    "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8000/readyz',timeout=8).read().decode())" \
    2>/dev/null)"
else
  ai_ready="$(curl -fsS --max-time 8 http://127.0.0.1:8000/readyz 2>/dev/null)"
fi
if [[ -n "${ai_ready}" ]] && grep -q '"ready":true' <<<"${ai_ready}"; then
  pass ai.ready "AI 服務就緒"
else
  soft ai.ready "AI 服務未就緒" "考試、客觀題評分、既有解析不受影響（降級設計）。診斷：docker compose logs ai"
fi

# ═══════════════════════════════════════════════════════════════
(( JSON_OUT )) || section "資源"
# ═══════════════════════════════════════════════════════════════

for path in / "${BACKUP_DIR:-/var/backups/yunzhi}"; do
  [[ -d "${path}" ]] || continue
  used="$(df --output=pcent "${path}" 2>/dev/null | tail -1 | tr -dc '0-9')"
  free="$(disk_free_gb "${path}")"
  if (( ${used:-0} > 90 )); then
    fail "disk:${path}" "${path} 已用 ${used}%（剩 ${free}GB）" "磁碟寫滿會讓考試中斷且 Postgres 無法寫 WAL。立刻清理或擴充。"
  elif (( ${used:-0} > 80 )); then
    soft "disk:${path}" "${path} 已用 ${used}%（剩 ${free}GB）" "調低 BACKUP_RETENTION_DAYS 或清理日誌"
  else
    pass "disk:${path}" "${path} 已用 ${used}%（剩 ${free}GB）"
  fi
done

mem_pct="$(free 2>/dev/null | awk '/Mem:/ {printf "%d", $3/$2*100}')"
if (( ${mem_pct:-0} > 90 )); then
  fail memory "記憶體已用 ${mem_pct}%" "OOM killer 會優先砍 PostgreSQL。調低 .env 的 AI_MEMORY_LIMIT 或加記憶體。"
else
  pass memory "記憶體已用 ${mem_pct}%"
fi

# ═══════════════════════════════════════════════════════════════
(( JSON_OUT )) || section "備份"
# ═══════════════════════════════════════════════════════════════

BACKUP_DIR="${BACKUP_DIR:-/var/backups/yunzhi}"
if [[ -d "${BACKUP_DIR}" ]]; then
  latest="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'yunzhi-*.tar.gz*' ! -name '*.sha256' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1)"
  if [[ -n "${latest}" ]]; then
    ts="${latest%% *}"; file="${latest#* }"
    age_h=$(( ( $(date +%s) - ${ts%.*} ) / 3600 ))
    if (( age_h > 48 )); then
      fail backup.age "最新備份已 ${age_h} 小時" "備份排程可能沒在跑。檢查：docker compose logs backup 或 systemctl status yunzhi-backup.timer"
    elif (( age_h > 26 )); then
      soft backup.age "最新備份已 ${age_h} 小時" "預期每日一次"
    else
      pass backup.age "最新備份 ${age_h} 小時前（$(basename "${file}")）"
    fi
    count="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'yunzhi-*.tar.gz*' ! -name '*.sha256' -type f | wc -l)"
    pass backup.count "共 ${count} 份備份"
  else
    fail backup.exists "沒有任何備份" "./deploy/scripts/backup.sh"
  fi

  # 這一項是本工具最重要的檢查之一。備份天天跑但從沒還原過，
  # 在真的需要它的那天才發現壞掉，是自架系統的經典結局。
  drill_log="${BACKUP_DIR}/restore-drills.log"
  if [[ -f "${drill_log}" ]]; then
    last_drill="$(tail -1 "${drill_log}" | cut -d'|' -f1)"
    last_result="$(tail -1 "${drill_log}" | cut -d'|' -f3)"
    days=$(( ( $(date +%s) - $(date -d "${last_drill}" +%s 2>/dev/null || echo 0) ) / 86400 ))
    if [[ "${last_result}" != "通過" ]]; then
      fail drill.result "上次還原演練失敗（${last_drill}）" "備份目前不可信賴。./deploy/scripts/verify-restore.sh"
    elif (( days > 92 )); then
      fail drill.age "距上次還原演練 ${days} 天，超過每季一次的要求" "./deploy/scripts/verify-restore.sh"
    else
      pass drill.age "還原演練 ${days} 天前通過"
    fi
  else
    fail drill.exists "從未執行過還原演練" "未驗證的備份等於沒有備份。./deploy/scripts/verify-restore.sh"
  fi
else
  fail backup.dir "備份目錄不存在：${BACKUP_DIR}" "mkdir -p ${BACKUP_DIR}"
fi

# WAL 歸檔失敗是靜默的，而它失敗的後果是磁碟被寫滿。
if [[ "${WAL_ARCHIVE_ENABLED:-true}" == "true" ]]; then
  wal_fail="$(pg_query "SELECT failed_count FROM pg_stat_archiver")"
  wal_last="$(pg_query "SELECT coalesce(last_archived_time::text,'從未') FROM pg_stat_archiver")"
  if (( ${wal_fail:-0} > 0 )); then
    fail wal.archive "WAL 歸檔失敗 ${wal_fail} 次" "Postgres 會累積 WAL 直到磁碟寫滿。檢查歸檔目錄權限：docker compose logs postgres | grep -i archive"
  elif [[ -n "${wal_last}" ]]; then
    pass wal.archive "WAL 歸檔正常（最後一次 ${wal_last}）"
  fi
fi

# ═══════════════════════════════════════════════════════════════
(( JSON_OUT )) || section "結論"
# ═══════════════════════════════════════════════════════════════

if (( JSON_OUT )); then
  printf '{"mode":"%s","failures":%d,"warnings":%d,"checks":[%s]}\n' \
    "${MODE}" "${FAILURES}" "${WARNINGS}" "$(IFS=,; echo "${JSON_ITEMS[*]}")"
else
  echo
  if (( FAILURES > 0 )); then
    err "${FAILURES} 項失敗、${WARNINGS} 項警告。"
    dim "每一項失敗下方的「→」就是下一步。"
  elif (( WARNINGS > 0 )); then
    warn "${WARNINGS} 項警告，沒有失敗。"
  else
    ok "全部正常。"
  fi
  echo
fi

exit $(( FAILURES > 0 ? 1 : 0 ))
