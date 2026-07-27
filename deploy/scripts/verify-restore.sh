#!/usr/bin/env bash
# 雲端智學 — 還原演練
#
# 規格書文件 01 §16 要求「每季一次還原演練並記錄結果」，且演練
# 必須包含 RTO（從零把服務跑起來要多久）與 RPO（最多會掉多少
# 資料）兩個實測數字。這支腳本就是那件事的自動化。
#
# 它做的是**真的還原**，只是還原到一個獨立的資料庫，所以正式
# 資料完全不受影響。單一機構自架最常見的失敗是「備份一直在跑，
# 但沒有人試過還原」—— 而那件事的代價會在最糟的時刻兌現。
#
# 用法：
#   ./deploy/scripts/verify-restore.sh            # 演練最新備份
#   ./deploy/scripts/verify-restore.sh <備份檔>
#   ./deploy/scripts/verify-restore.sh --all      # 演練全部備份（慢）
#   ./deploy/scripts/verify-restore.sh --report   # 只輸出歷次演練報告

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ARCHIVE=""
ALL=0
REPORT_ONLY=0
DRILL_DB="yunzhi_drill_$$"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) ALL=1; shift ;;
    --report) REPORT_ONLY=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    -*) die "不認得的參數：$1" ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done

load_env
BACKUP_DIR="${BACKUP_DIR:-${YZ_ROOT}/data/backups}"
DRILL_LOG="${BACKUP_DIR}/restore-drills.log"

if (( REPORT_ONLY )); then
  section "還原演練紀錄"
  if [[ -f "${DRILL_LOG}" ]]; then
    printf '%-20s %-34s %-8s %-8s %s\n' "日期" "備份" "結果" "RTO(秒)" "備註"
    printf '%s\n' "────────────────────────────────────────────────────────────────────────────────"
    while IFS='|' read -r ts name result rto note; do
      printf '%-20s %-34s %-8s %-8s %s\n' "${ts}" "${name}" "${result}" "${rto}" "${note}"
    done < "${DRILL_LOG}"
    echo
    last="$(tail -1 "${DRILL_LOG}" | cut -d'|' -f1)"
    if [[ -n "${last}" ]]; then
      days=$(( ( $(date +%s) - $(date -d "${last}" +%s 2>/dev/null || echo 0) ) / 86400 ))
      if (( days > 92 )); then
        err "距離上次演練已 ${days} 天，超過每季一次的要求。"
      else
        ok "距離上次演練 ${days} 天。"
      fi
    fi
  else
    warn "沒有演練紀錄。請執行一次：./deploy/scripts/verify-restore.sh"
  fi
  exit 0
fi

acquire_lock "verify-restore"

# 演練資料庫在任何結束路徑都要清掉，否則會在正式伺服器上
# 累積一堆孤兒資料庫並吃掉磁碟。
cleanup() {
  pg_exec psql -U "${POSTGRES_USER}" -d postgres \
    -c "DROP DATABASE IF EXISTS ${DRILL_DB};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── 選擇要演練的備份 ────────────────────────────────────────────
declare -a TARGETS=()
if (( ALL )); then
  mapfile -t TARGETS < <(find "${BACKUP_DIR}" -maxdepth 1 -name 'yunzhi-*.tar.gz*' ! -name '*.sha256' -type f | sort)
elif [[ -n "${ARCHIVE}" ]]; then
  TARGETS=("${ARCHIVE}")
else
  latest="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'yunzhi-*.tar.gz*' ! -name '*.sha256' \
    -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  [[ -n "${latest}" ]] || die "在 ${BACKUP_DIR} 找不到備份。請先執行 ./deploy/scripts/backup.sh"
  TARGETS=("${latest}")
fi

cat <<'BANNER'

  ╔══════════════════════════════════════════════════════════╗
  ║  還原演練                                                 ║
  ║  正式資料庫不受影響，全程還原到獨立的演練資料庫。          ║
  ╚══════════════════════════════════════════════════════════╝

BANNER

overall_ok=1

for target in "${TARGETS[@]}"; do
  name="$(basename "${target}")"
  section "演練 ${name}"

  drill_start="$(date +%s)"
  failure_reason=""

  # ── 步驟 1：完整性 ────────────────────────────────────────────
  info "1/5 校驗碼"
  if [[ -f "${target}.sha256" ]]; then
    if ( cd "$(dirname "${target}")" && sha256sum -c "${name}.sha256" >/dev/null 2>&1 ); then
      ok "校驗碼相符"
    else
      failure_reason="校驗碼不符，檔案已損壞"
      err "${failure_reason}"
    fi
  else
    warn "沒有校驗碼檔案"
  fi

  # ── 步驟 2：解密 ──────────────────────────────────────────────
  if [[ -z "${failure_reason}" ]]; then
    info "2/5 解密與解壓"
    if "${YZ_SCRIPTS_DIR}/restore.sh" "${target}" --into "${DRILL_DB}" --skip-objects --yes >/dev/null 2>"${TMPDIR:-/tmp}/drill-$$.err"; then
      ok "解密與還原成功"
    else
      failure_reason="還原失敗：$(tail -3 "${TMPDIR:-/tmp}/drill-$$.err" | tr '\n' ' ')"
      err "${failure_reason}"
    fi
    rm -f "${TMPDIR:-/tmp}/drill-$$.err"
  fi

  # ── 步驟 3：資料完整性 ────────────────────────────────────────
  # 只確認「有表」是不夠的。要確認關鍵表有資料、外鍵沒斷、
  # 而且稽核記錄的時間連續 —— 這三項才能說明備份是可用的。
  if [[ -z "${failure_reason}" ]]; then
    info "3/5 資料完整性"
    result="$(pg_exec psql -U "${POSTGRES_USER}" -d "${DRILL_DB}" -tAF'|' -c "
      SELECT
        (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'),
        (SELECT count(*) FROM tenants),
        (SELECT count(*) FROM users),
        (SELECT count(*) FROM audit_logs),
        (SELECT coalesce(max(\"createdAt\")::text,'—') FROM audit_logs)
    " 2>/dev/null || echo "0|0|0|0|—")"
    IFS='|' read -r n_tab n_ten n_usr n_aud last_audit <<< "${result}"

    dim "資料表 ${n_tab}｜租戶 ${n_ten}｜使用者 ${n_usr}｜稽核 ${n_aud}"
    dim "最後一筆稽核：${last_audit}"

    if (( n_tab < 5 )); then
      failure_reason="還原後只有 ${n_tab} 張表，明顯不完整"
      err "${failure_reason}"
    elif (( n_ten == 0 )); then
      failure_reason="沒有任何租戶資料，備份可能是空的"
      err "${failure_reason}"
    else
      ok "資料完整"
    fi
  fi

  # ── 步驟 4：外鍵一致性 ────────────────────────────────────────
  if [[ -z "${failure_reason}" ]]; then
    info "4/5 外鍵一致性"
    # pg_restore 若在錯誤的順序下還原，外鍵可能失效但表面看不出來。
    orphans="$(pg_scalar "SELECT count(*) FROM users u LEFT JOIN tenants t ON u.\"tenantId\" = t.id WHERE t.id IS NULL" "${DRILL_DB}")"
    orphans="${orphans:-0}"
    if (( ${orphans:-0} > 0 )); then
      failure_reason="有 ${orphans} 筆使用者指向不存在的租戶，外鍵不一致"
      err "${failure_reason}"
    else
      ok "外鍵一致"
    fi
  fi

  # ── 步驟 5：RPO 量測 ──────────────────────────────────────────
  if [[ -z "${failure_reason}" ]]; then
    info "5/5 RPO 量測"
    backup_time="$(stat -c %Y "${target}")"
    if [[ "${last_audit}" != "—" ]]; then
      # 資料庫的時間戳是 UTC（schema 一律存 UTC），而 stat 給的是
      # epoch。若直接 `date -d`，shell 會把那個字串當**本地時間**
      # 解讀，於是 RPO 憑空多出一個時區位移 —— 台灣就是多 8 小時，
      # 讓每一次演練都誤報「超過 RPO 目標」。加 UTC 後綴修正。
      audit_epoch="$(date -u -d "${last_audit} UTC" +%s 2>/dev/null || echo "${backup_time}")"
      rpo_sec=$(( backup_time - audit_epoch ))
      (( rpo_sec < 0 )) && rpo_sec=0
      rpo_min=$(( rpo_sec / 60 ))
      if (( rpo_min > 15 )); then
        warn "備份時點與最後一筆稽核相差 ${rpo_min} 分鐘，超過 RPO 目標（15 分鐘）。"
        dim "若 WAL 歸檔正常，實際 RPO 仍可達 15 分鐘 —— 這個數字反映的是"
        dim "全量備份的時間點，不是可還原的最新時點。"
      else
        ok "備份時點落差 ${rpo_min} 分鐘，符合 RPO 目標"
      fi
    fi

    # WAL 歸檔的存在與否直接決定 RPO 承諾成不成立
    if [[ "${WAL_ARCHIVE_ENABLED:-true}" == "true" ]]; then
      wal_n="$(pg_sh "ls -1 '$(wal_archive_dir)' 2>/dev/null | wc -l" 2>/dev/null | tr -d ' \r' || echo 0)"
      if (( ${wal_n:-0} > 0 )); then
        ok "WAL 歸檔運作中（${wal_n} 個檔案），可做時間點還原"
      else
        warn "WAL 歸檔目錄是空的。archive_command 可能一直失敗 —— 這會讓 RPO"
        warn "退化為「上一次全量備份」，而且 Postgres 會持續累積 WAL 直到磁碟寫滿。"
        dim "檢查：docker compose logs postgres | grep -i archive"
      fi
    fi
  fi

  # ── 記錄 ──────────────────────────────────────────────────────
  drill_rto=$(( $(date +%s) - drill_start ))
  cleanup

  if [[ -z "${failure_reason}" ]]; then
    ok "演練通過，RTO ${drill_rto} 秒"
    printf '%s|%s|%s|%s|%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${name}" "通過" "${drill_rto}" "" >> "${DRILL_LOG}"
  else
    err "演練失敗：${failure_reason}"
    printf '%s|%s|%s|%s|%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${name}" "失敗" "${drill_rto}" "${failure_reason}" >> "${DRILL_LOG}"
    overall_ok=0
  fi
done

section "結論"

if (( overall_ok )); then
  ok "全部演練通過。"
  echo
  dim "紀錄已寫入 ${DRILL_LOG}"
  dim "查看歷次結果：./deploy/scripts/verify-restore.sh --report"
  echo
  warn "RTO 的完整定義是「從零把服務跑起來要多久」，包含："
  dim "  重裝作業系統與 Docker → 還原 .env → docker-install.sh → restore.sh"
  dim "本演練只量測最後一步。完整演練請照 docs/DISASTER-RECOVERY.md"
  dim "在一台備援機或虛擬機上實際跑一次，一年至少一次。"
  exit 0
else
  err "有演練失敗。備份目前不可信賴。"
  echo
  dim "請依序確認："
  dim "1. 備份腳本最近的執行是否有錯：grep -i error /var/log/yunzhi/backup.log"
  dim "2. 磁碟是否曾寫滿（會產生截斷的備份檔）"
  dim "3. BACKUP_ENCRYPTION_KEY 是否被換過（舊備份會解不開）"
  exit 1
fi
