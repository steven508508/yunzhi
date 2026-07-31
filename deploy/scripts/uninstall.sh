#!/usr/bin/env bash
# 雲端智學 — 原生解除安裝
#
# 核心設計：**只移除 install.sh 記錄在清單裡的東西**。
#
# 這一點是原生安裝能不能負責任地提供的關鍵。若機器上本來就有
# PostgreSQL（很多學校的伺服器有），一個粗暴的 `apt-get purge
# postgresql` 會連別人的資料庫一起殺掉。清單機制讓解除安裝只
# 回收自己帶來的東西。
#
# 三個層級（與 Docker 版一致）：
#   （預設）  停用服務、移除程式與 systemd 單元。資料與資料庫保留。
#   --purge   連同資料庫、資料目錄一起刪除。
#   --full    再加上本次安裝的系統套件與使用者。
#
# 用法：
#   sudo ./deploy/scripts/uninstall.sh --dry-run
#   sudo ./deploy/scripts/uninstall.sh
#   sudo ./deploy/scripts/uninstall.sh --purge --backup-first

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

PURGE=0
FULL=0
DRY_RUN=0
BACKUP_FIRST=0
KEEP_ENV=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --full) PURGE=1; FULL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --backup-first) BACKUP_FIRST=1; shift ;;
    --remove-env) KEEP_ENV=0; shift ;;
    --yes|-y) export YZ_ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

(( DRY_RUN )) || need_root
acquire_lock "native-uninstall"

readonly YZ_USER="yunzhi"
readonly OPT_DIR="/opt/yunzhi"
readonly ETC_DIR="/etc/yunzhi"
readonly VAR_DIR="/var/lib/yunzhi"
readonly LOG_DIR="/var/log/yunzhi"
readonly BAK_DIR="/var/backups/yunzhi"
readonly MANIFEST="${ETC_DIR}/install-manifest.txt"

[[ -f "${ETC_DIR}/env" ]] && load_env "${ETC_DIR}/env"

run() {
  if (( DRY_RUN )); then
    dim "[dry-run] $*"
  else
    "$@" 2>/dev/null || warn "指令失敗（繼續）：$*"
  fi
}

# ═══════════════════════════════════════════════════════════════
section "安裝清單"
# ═══════════════════════════════════════════════════════════════

if [[ ! -f "${MANIFEST}" ]]; then
  warn "找不到安裝清單 ${MANIFEST}。"
  warn "這代表本系統不是用 install.sh 裝的，或清單已遺失。"
  warn "本腳本只會移除**已知的固定路徑**，不會碰任何系統套件——"
  warn "沒有清單就無從判斷哪些套件是本安裝帶來的，寧可留下也不誤刪。"
  MANIFEST_MISSING=1
else
  MANIFEST_MISSING=0
  info "讀取清單：${MANIFEST}（$(wc -l < "${MANIFEST}") 項）"
fi

declare -a M_PACKAGES=() M_FILES=() M_DIRS=() M_SYSTEMD=() M_USERS=() M_PGDBS=() M_PGROLES=() M_REPOS=()
if (( ! MANIFEST_MISSING )); then
  while IFS=$'\t' read -r kind value; do
    case "${kind}" in
      package) M_PACKAGES+=("${value}") ;;
      file)    M_FILES+=("${value}") ;;
      dir)     M_DIRS+=("${value}") ;;
      systemd) M_SYSTEMD+=("${value}") ;;
      user)    M_USERS+=("${value}") ;;
      pgdb)    M_PGDBS+=("${value}") ;;
      pgrole)  M_PGROLES+=("${value}") ;;
      repo)    M_REPOS+=("${value}") ;;
    esac
  done < "${MANIFEST}"
fi

# ═══════════════════════════════════════════════════════════════
section "將要移除的項目"
# ═══════════════════════════════════════════════════════════════

show_group() {
  local title="$1" will_remove="$2"; shift 2
  printf '\n%s%s%s\n' "${C_BOLD}" "${title}" "${C_RESET}"
  if (( $# == 0 )); then dim "（無）"; return; fi
  for item in "$@"; do
    if (( will_remove )); then
      printf '  %s✗%s %s\n' "${C_RED}" "${C_RESET}" "${item}"
    else
      printf '  %s✓%s %s ← 保留\n' "${C_GREEN}" "${C_RESET}" "${item}"
    fi
  done
}

running_units=()
for u in yunzhi-web yunzhi-worker yunzhi-ai yunzhi-minio yunzhi-backup.timer; do
  systemctl list-unit-files 2>/dev/null | grep -q "^${u}" && running_units+=("${u}")
done

show_group "systemd 服務（停用並移除）" 1 "${running_units[@]}"
show_group "程式目錄" 1 "${OPT_DIR}"
show_group "資料目錄" "${PURGE}" "${VAR_DIR}" "${LOG_DIR}"
show_group "資料庫" "${PURGE}" "${M_PGDBS[@]}" "${M_PGROLES[@]}"
show_group "設定檔" "$(( PURGE && ! KEEP_ENV ))" "${ETC_DIR}/env" "/etc/default/yunzhi"
show_group "本次安裝的系統套件" "${FULL}" "${M_PACKAGES[@]}"
show_group "本次新增的套件庫" "${FULL}" "${M_REPOS[@]}"
show_group "服務帳號" "${FULL}" "${M_USERS[@]}"

printf '\n%s一律保留%s\n' "${C_BOLD}" "${C_RESET}"
printf '  %s✓%s %s（本腳本永不刪除備份）\n' "${C_GREEN}" "${C_RESET}" "${BAK_DIR}"
dim "以及所有安裝前就存在的套件、其他服務的設定、防火牆規則"

if (( MANIFEST_MISSING )); then
  printf '\n%s因為沒有清單而不會處理%s\n' "${C_BOLD}${C_YELLOW}" "${C_RESET}"
  dim "系統套件、套件庫、服務帳號、PostgreSQL 角色與資料庫"
  dim "若確定要清，請在移除後手動處理，或參考 docs/UNINSTALL.md 的完整清單。"
fi

if (( DRY_RUN )); then
  echo; ok "dry-run 結束，沒有更動任何東西。"; exit 0
fi

# ═══════════════════════════════════════════════════════════════
section "確認"
# ═══════════════════════════════════════════════════════════════

if (( PURGE )); then
  latest_backup=""
  [[ -d "${BAK_DIR}" ]] && latest_backup="$(find "${BAK_DIR}" -name '*.tar.gz*' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)"

  if [[ -z "${latest_backup}" ]]; then
    err "找不到任何備份，而你要刪除全部資料。"
    if (( BACKUP_FIRST )); then
      info "正在備份…"
      "${YZ_SCRIPTS_DIR}/backup.sh" --tag "pre-uninstall" || die "備份失敗，已中止。"
    else
      die "請先備份，或加上 --backup-first。"
    fi
  else
    age_days=$(( ( $(date +%s) - $(stat -c %Y "${latest_backup}") ) / 86400 ))
    info "最新備份：$(basename "${latest_backup}")（${age_days} 天前）"
    (( BACKUP_FIRST )) && { info "再備份一次…"; "${YZ_SCRIPTS_DIR}/backup.sh" --tag "pre-uninstall" || die "備份失敗。"; }
  fi
  echo
  err "這會**永久刪除**資料庫 ${POSTGRES_DB:-yunzhi} 與 ${VAR_DIR} 的全部內容。"
  confirm_phrase "確定要刪除全部資料？" "DELETE ALL DATA"
else
  confirm_phrase "將停用服務並移除程式（資料與資料庫保留）。" "UNINSTALL"
fi

# ═══════════════════════════════════════════════════════════════
section "停用服務"
# ═══════════════════════════════════════════════════════════════

# 停止順序與啟動相反：先斷入口，再停應用，最後停資料層。
# 反過來停會讓 web 在資料庫消失後噴一堆錯誤日誌，
# 掩蓋掉真正需要看的訊息。
for u in yunzhi-backup.timer yunzhi-worker yunzhi-web yunzhi-ai yunzhi-minio; do
  systemctl list-unit-files 2>/dev/null | grep -q "^${u}" || continue
  info "停用 ${u}…"
  # 給 60 秒收尾。不是等前端同步本機暫存（前端沒有本機暫存），
  # 是等「已經送出、還沒寫進資料庫」的請求與 worker 手上的匯入。
  run systemctl stop "${u}"
  run systemctl disable "${u}"
done

for unit in "${M_SYSTEMD[@]}"; do
  run rm -f "/etc/systemd/system/${unit}"
done
run systemctl daemon-reload
run systemctl reset-failed
ok "服務已停用"

# ═══════════════════════════════════════════════════════════════
section "還原被修改的設定"
# ═══════════════════════════════════════════════════════════════

# install.sh 修改過的第三方設定要還原，否則 PostgreSQL 會留著
# 指向已刪除目錄的 archive_command，然後在下次重啟時卡住。
PG_CONF_DIR="/etc/postgresql/16/main"
if [[ -f "${PG_CONF_DIR}/conf.d/yunzhi.conf" ]]; then
  run rm -f "${PG_CONF_DIR}/conf.d/yunzhi.conf"
  ok "移除 PostgreSQL 的雲端智學設定（archive_command 一併失效）"
  run systemctl restart postgresql
fi

if [[ -f /etc/redis/redis.conf.d/yunzhi.conf ]]; then
  run rm -f /etc/redis/redis.conf.d/yunzhi.conf
  run systemctl restart redis-server
  ok "還原 Redis 設定"
elif [[ -f /etc/redis/redis.conf.yunzhi-backup ]]; then
  run mv /etc/redis/redis.conf.yunzhi-backup /etc/redis/redis.conf
  run systemctl restart redis-server
  ok "還原 Redis 設定（自備份）"
fi

if [[ -f /etc/caddy/Caddyfile.yunzhi-backup ]]; then
  run mv /etc/caddy/Caddyfile.yunzhi-backup /etc/caddy/Caddyfile
  run systemctl reload caddy
  ok "還原 Caddy 設定"
elif [[ -f /etc/caddy/Caddyfile ]] && grep -q "127.0.0.1:3000" /etc/caddy/Caddyfile 2>/dev/null; then
  warn "/etc/caddy/Caddyfile 仍指向雲端智學但沒有備份可還原。"
  dim "請手動編輯，否則 Caddy 會一直對已停用的服務回 502。"
fi

# ═══════════════════════════════════════════════════════════════
section "移除程式與資料"
# ═══════════════════════════════════════════════════════════════

run rm -rf "${OPT_DIR}"
ok "移除 ${OPT_DIR}"

if (( PURGE )); then
  for db in "${M_PGDBS[@]}"; do
    info "刪除資料庫 ${db}…"
    # 先斷開所有連線，否則 DROP DATABASE 會因為「資料庫使用中」失敗
    run sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}' AND pid <> pg_backend_pid();"
    run sudo -u postgres dropdb --if-exists "${db}"
  done
  for role in "${M_PGROLES[@]}"; do
    run sudo -u postgres psql -c "DROP ROLE IF EXISTS ${role};"
  done
  run rm -rf "${VAR_DIR}" "${LOG_DIR}"
  (( KEEP_ENV )) || { run shred -u "${ETC_DIR}/env"; run rm -rf "${ETC_DIR}"; }
  ok "資料已刪除"
else
  info "保留資料庫與 ${VAR_DIR}。重新安裝會接上原本的資料。"
fi

# ═══════════════════════════════════════════════════════════════
if (( FULL )); then
section "移除系統套件與帳號"

  if ((${#M_PACKAGES[@]})); then
    warn "即將移除本次安裝帶來的套件：${M_PACKAGES[*]}"
    confirm_phrase "確定移除這些系統套件？" "REMOVE PACKAGES"
    for pkg in "${M_PACKAGES[@]}"; do
      run apt-get purge -y -qq "${pkg}"
    done
    run apt-get autoremove -y -qq
    ok "套件已移除"
  fi

  for repo in "${M_REPOS[@]}"; do run rm -f "${repo}"; done
  ((${#M_REPOS[@]})) && run apt-get update -qq

  for u in "${M_USERS[@]}"; do
    run userdel "${u}"
    ok "移除使用者 ${u}"
  done
fi

run rm -f "${YZ_ROOT}/.env" "${YZ_LOCK_FILE}" /etc/logrotate.d/yunzhi /etc/default/yunzhi

# ═══════════════════════════════════════════════════════════════
section "驗證移除結果"
# ═══════════════════════════════════════════════════════════════

leftover=0
check() {
  local desc="$1" path="$2"
  if [[ -e "${path}" ]]; then
    warn "${desc} 仍存在：${path}"
    leftover=1
  else
    ok "${desc} 已清除"
  fi
}

check "程式目錄" "${OPT_DIR}"
(( PURGE )) && check "資料目錄" "${VAR_DIR}"
for u in yunzhi-web yunzhi-worker yunzhi-ai yunzhi-minio; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^${u}"; then
    warn "systemd 單元仍存在：${u}"; leftover=1
  fi
done
[[ -f "/etc/systemd/system/yunzhi-web.service" ]] && { warn "systemd 檔案殘留"; leftover=1; }

# 殘留的行程比殘留的檔案更麻煩 —— 它們會繼續佔用連接埠。
if pgrep -u "${YZ_USER}" >/dev/null 2>&1; then
  warn "仍有 ${YZ_USER} 的行程在執行："
  pgrep -au "${YZ_USER}" | head -5
  leftover=1
else
  ok "沒有殘留行程"
fi

echo
if (( leftover )); then
  warn "有殘留項目，請依上列訊息處理。"
else
  ok "移除完成，沒有殘留。"
fi

echo
dim "備份保留在 ${BAK_DIR}"
if (( ! PURGE )); then
  dim "資料庫與 ${VAR_DIR} 仍在。重新安裝會直接接上："
  dim "  sudo ./deploy/scripts/install.sh"
fi
echo
