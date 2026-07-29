#!/usr/bin/env bash
# 雲端智學 — Docker 解除安裝
#
# 設計原則：**先列出將要刪除的每一項，再要求輸入完整詞句確認**。
# 自架系統的解除安裝最常見的兩種災難是「以為刪乾淨了但留了一堆
# 殘留」與「以為只是停用結果資料被刪了」，這支腳本兩邊都防。
#
# 三個層級：
#   （預設）    停止並移除容器與網路。資料 volume 全部保留。
#   --purge     連同資料 volume 一起刪除。無法復原。
#   --full      再加上映像與建置快取。機器完全回到安裝前的狀態。
#
# 用法：
#   ./deploy/scripts/docker-uninstall.sh
#   ./deploy/scripts/docker-uninstall.sh --purge --backup-first
#   ./deploy/scripts/docker-uninstall.sh --dry-run     # 只列不刪

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
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

acquire_lock "docker-uninstall"
[[ -f "${YZ_ROOT}/.env" ]] && load_env

run() {
  if (( DRY_RUN )); then
    dim "[dry-run] $*"
  else
    "$@" || warn "指令失敗（繼續）：$*"
  fi
}

# ═══════════════════════════════════════════════════════════════
section "將要移除的項目"
# ═══════════════════════════════════════════════════════════════

# 實際去查而不是印死表。印死表的清單會隨版本演進而失準，
# 而失準的清單正是殘留物的來源。
containers="$(docker ps -a --filter 'name=yunzhi' --format '{{.Names}}' 2>/dev/null || true)"
compose_containers="$(cd "${YZ_ROOT}" && docker compose ps -aq 2>/dev/null || true)"
volumes="$(docker volume ls --filter 'name=yunzhi' --format '{{.Name}}' 2>/dev/null || true)"
networks="$(docker network ls --filter 'name=yunzhi' --format '{{.Name}}' 2>/dev/null || true)"
images="$(docker images --filter 'reference=yunzhi/*' --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)"

echo
printf '%s容器%s\n' "${C_BOLD}" "${C_RESET}"
if [[ -n "${containers}${compose_containers}" ]]; then
  # shellcheck disable=SC2086  # 刻意分詞：這裡要逐個容器名各印一行
  printf '  %s\n' ${containers:-} 2>/dev/null || true
  [[ -z "${containers}" ]] && dim "（$(echo "${compose_containers}" | grep -c . ) 個由 compose 管理的容器）"
else
  dim "（無）"
fi

printf '\n%s網路%s\n' "${C_BOLD}" "${C_RESET}"
# shellcheck disable=SC2086,SC2015  # 刻意分詞；A&&B||C 在此等價於 if-then-else（B 不會失敗）
[[ -n "${networks}" ]] && printf '  %s\n' ${networks} || dim "（無）"

printf '\n%s資料 Volume%s\n' "${C_BOLD}" "${C_RESET}"
if [[ -n "${volumes}" ]]; then
  for v in ${volumes}; do
    size="$(docker system df -v --format '{{range .Volumes}}{{if eq .Name "'"${v}"'"}}{{.Size}}{{end}}{{end}}' 2>/dev/null || echo '?')"
    if (( PURGE )); then
      printf '  %s✗ %s%s  %s%s\n' "${C_RED}" "${v}" "${C_RESET}" "${size}" " ← 將被刪除"
    else
      printf '  %s✓ %s%s  %s%s\n' "${C_GREEN}" "${v}" "${C_RESET}" "${size}" " ← 保留"
    fi
  done
else
  dim "（無）"
fi

printf '\n%s映像%s\n' "${C_BOLD}" "${C_RESET}"
if [[ -n "${images}" ]]; then
  for i in ${images}; do
    if (( FULL )); then
      printf '  %s✗ %s%s ← 將被刪除\n' "${C_RED}" "${i}" "${C_RESET}"
    else
      printf '  %s✓ %s%s ← 保留\n' "${C_GREEN}" "${i}" "${C_RESET}"
    fi
  done
else
  dim "（無）"
fi

printf '\n%s宿主機檔案%s\n' "${C_BOLD}" "${C_RESET}"
for p in "${YZ_ROOT}/.env" "${BACKUP_DIR:-${YZ_ROOT}/data/backups}" "${YZ_ROOT}/data/models" "${YZ_LOCK_FILE}"; do
  [[ -e "${p}" ]] || continue
  sz="$(du -sh "${p}" 2>/dev/null | cut -f1 || echo '?')"
  case "${p}" in
    *.env)
      if (( KEEP_ENV )); then
        printf '  %s✓ %s%s (%s) ← 保留（含密碼與金鑰，加 --remove-env 才刪）\n' "${C_GREEN}" "${p}" "${C_RESET}" "${sz}"
      else
        printf '  %s✗ %s%s (%s) ← 將被刪除\n' "${C_RED}" "${p}" "${C_RESET}" "${sz}"
      fi ;;
    *backups*)
      # 備份**永遠不刪**。這是刻意的：解除安裝之後才發現需要
      # 舊資料，是很常見的事，而備份是唯一的救援途徑。
      printf '  %s✓ %s%s (%s) ← 一律保留，本腳本永不刪除備份\n' "${C_GREEN}" "${p}" "${C_RESET}" "${sz}" ;;
    *)
      if (( PURGE )); then
        printf '  %s✗ %s%s (%s) ← 將被刪除\n' "${C_RED}" "${p}" "${C_RESET}" "${sz}"
      else
        printf '  %s✓ %s%s (%s) ← 保留\n' "${C_GREEN}" "${p}" "${C_RESET}" "${sz}"
      fi ;;
  esac
done

printf '\n%s系統層%s\n' "${C_BOLD}" "${C_RESET}"
if [[ -f /etc/systemd/system/yunzhi-docker.service ]]; then
  printf '  %s✗ /etc/systemd/system/yunzhi-docker.service%s ← 將被停用並移除\n' "${C_RED}" "${C_RESET}"
else
  dim "（沒有安裝開機自動啟動的 unit）"
fi

echo
printf '%s不會被觸碰的東西%s\n' "${C_BOLD}" "${C_RESET}"
dim "Docker Engine 本身、其他專案的容器與 volume、系統套件"
dim "以及 ${BACKUP_DIR:-${YZ_ROOT}/data/backups} 底下的所有備份檔"
dim ""
dim "防火牆規則也不會動 —— 機器上可能還有別的服務靠它們。"
dim "要一併移除本系統加的那一段（DOCKER-USER）："
dim "  刪掉 /etc/ufw/after.rules 裡 '### BEGIN 雲端智學 DOCKER-USER' 到 END 之間的內容"
dim "  sudo ufw reload && sudo systemctl restart docker"

if (( DRY_RUN )); then
  echo
  ok "dry-run 結束，沒有刪除任何東西。"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════
section "確認"
# ═══════════════════════════════════════════════════════════════

if (( PURGE )); then
  # 刪資料前強制檢查有沒有備份。沒有備份就 --purge 是
  # 補習班會付出很高代價的操作。
  latest_backup=""
  bdir="${BACKUP_DIR:-${YZ_ROOT}/data/backups}"
  if [[ -d "${bdir}" ]]; then
    latest_backup="$(find "${bdir}" -name '*.tar.gz*' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)"
  fi

  if [[ -z "${latest_backup}" ]]; then
    err "找不到任何備份，而你要刪除全部資料。"
    if (( BACKUP_FIRST )); then
      info "已指定 --backup-first，正在備份…"
      "${YZ_SCRIPTS_DIR}/backup.sh" --tag "pre-uninstall" || die "備份失敗，已中止解除安裝。"
    else
      die "請先執行 ./deploy/scripts/backup.sh，或加上 --backup-first 讓本腳本代勞。"
    fi
  else
    age_days=$(( ( $(date +%s) - $(stat -c %Y "${latest_backup}") ) / 86400 ))
    info "最新備份：${latest_backup}（${age_days} 天前）"
    (( age_days > 1 )) && warn "備份已經 ${age_days} 天，這段期間的資料會遺失。"
    if (( BACKUP_FIRST )); then
      info "指定了 --backup-first，再備份一次…"
      "${YZ_SCRIPTS_DIR}/backup.sh" --tag "pre-uninstall" || die "備份失敗，已中止。"
    fi
  fi

  echo
  err "這會**永久刪除**所有學生資料、成績、題庫與作答記錄。"
  err "只有上列備份能救回來。"
  confirm_phrase "確定要刪除全部資料？" "DELETE ALL DATA"
else
  confirm_phrase "將停止並移除容器（資料保留）。" "UNINSTALL"
fi

# ═══════════════════════════════════════════════════════════════
section "執行"
# ═══════════════════════════════════════════════════════════════

info "停止服務…"
# 給 60 秒優雅關閉。正在作答的學生需要時間讓前端把本地暫存
# 的作答同步上來；直接 kill 會讓那段作答只留在瀏覽器裡。
run bash -c "cd '${YZ_ROOT}' && docker compose --profile monitoring stop -t 60"

info "移除容器與網路…"
if (( PURGE )); then
  run bash -c "cd '${YZ_ROOT}' && docker compose --profile monitoring down --volumes --remove-orphans"
else
  run bash -c "cd '${YZ_ROOT}' && docker compose --profile monitoring down --remove-orphans"
fi

# compose down 有時漏掉手動建立或改名過的容器
for c in ${containers}; do
  docker ps -a --format '{{.Names}}' | grep -qx "${c}" && run docker rm -f "${c}"
done

if (( PURGE )); then
  for v in ${volumes}; do
    docker volume ls --format '{{.Name}}' | grep -qx "${v}" && run docker volume rm "${v}"
  done
  run rm -rf "${YZ_ROOT}/data/models"
  (( KEEP_ENV )) || run shred -u "${YZ_ROOT}/.env" 2>/dev/null || run rm -f "${YZ_ROOT}/.env"
fi

if (( FULL )); then
  info "移除映像…"
  for i in ${images}; do run docker rmi "${i}"; done
  run docker builder prune -f --filter 'label=com.docker.compose.project=yunzhi'
fi

run rm -f "${YZ_LOCK_FILE}"

# 開機自動啟動的 unit。留著的話，重開機時 systemd 會試著在一個
# 已經沒有容器的目錄裡跑 docker compose up，於是每次開機都多一則
# failed 的服務 —— 那是自架系統移除後最典型的殘留物。
if [[ -f /etc/systemd/system/yunzhi-docker.service ]]; then
  info "移除開機自動啟動的 systemd unit…"
  if [[ "${EUID}" -eq 0 ]]; then
    run systemctl disable --now yunzhi-docker.service
    run rm -f /etc/systemd/system/yunzhi-docker.service
    run systemctl daemon-reload
  else
    warn "需要 root 才能移除 systemd unit。請自行執行："
    dim "  sudo systemctl disable --now yunzhi-docker.service"
    dim "  sudo rm /etc/systemd/system/yunzhi-docker.service && sudo systemctl daemon-reload"
  fi
fi

# ═══════════════════════════════════════════════════════════════
section "驗證移除結果"
# ═══════════════════════════════════════════════════════════════

leftover=0
check_gone() {
  local what="$1" cmd="$2"
  local found
  found="$(eval "${cmd}" 2>/dev/null || true)"
  if [[ -n "${found}" ]]; then
    warn "${what} 仍有殘留："
    # shellcheck disable=SC2086  # 刻意分詞
    printf '    %s\n' ${found}
    leftover=1
  else
    ok "${what} 已清除"
  fi
}

check_gone "容器" "docker ps -a --filter 'name=yunzhi' --format '{{.Names}}'"
check_gone "網路" "docker network ls --filter 'name=yunzhi' --format '{{.Name}}'"
(( PURGE )) && check_gone "Volume" "docker volume ls --filter 'name=yunzhi' --format '{{.Name}}'"
(( FULL ))  && check_gone "映像" "docker images --filter 'reference=yunzhi/*' --format '{{.Repository}}:{{.Tag}}'"

echo
if (( leftover )); then
  warn "有殘留項目，請手動確認上列內容。"
else
  ok "移除完成，沒有殘留。"
fi

echo
if (( ! PURGE )); then
  dim "資料 volume 仍在。重新安裝會接上原本的資料："
  dim "  ./deploy/scripts/docker-install.sh"
  dim ""
  dim "要連資料一起刪除："
  dim "  ./deploy/scripts/docker-uninstall.sh --purge"
else
  dim "資料已刪除。備份仍在 ${BACKUP_DIR:-${YZ_ROOT}/data/backups}。"
  dim "從備份重建："
  dim "  ./deploy/scripts/docker-install.sh && ./deploy/scripts/restore.sh <備份檔>"
fi
echo
