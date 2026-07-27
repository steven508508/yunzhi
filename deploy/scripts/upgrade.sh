#!/usr/bin/env bash
# 雲端智學 — 升級
#
# 升級流程的每一步都可回滾，而且**回滾點在做任何破壞性動作之前
# 就已經建立**。這是與「先升級、壞了再想辦法」最重要的差別。
#
# 步驟：
#   1. 檢查是否在考試進行中（有人在作答就不升級）
#   2. 記錄目前版本 → rollback.sh 靠它知道要退回哪裡
#   3. 完整備份（含 tag pre-upgrade，不受保留期限清除）
#   4. 拉取／建置新版映像 —— 此步失敗不影響現有服務
#   5. 進維護模式（Caddy 回 503 加友善頁面，而不是讓學生看到亂七八糟的錯誤）
#   6. 資料庫遷移
#   7. 滾動重啟
#   8. 健康驗證；失敗自動回滾
#
# 用法：
#   ./deploy/scripts/upgrade.sh
#   ./deploy/scripts/upgrade.sh --to 1.2.0
#   ./deploy/scripts/upgrade.sh --force        # 忽略考試進行中的警告

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

TARGET_VERSION=""
FORCE=0
NO_AUTO_ROLLBACK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to) TARGET_VERSION="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --no-auto-rollback) NO_AUTO_ROLLBACK=1; shift ;;
    --yes|-y) export YZ_ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

acquire_lock "upgrade"
load_env

CURRENT_VERSION="$(curl -fsS --max-time 5 http://127.0.0.1:3000/api/version 2>/dev/null \
  | grep -oP '"appVersion":"\K[^"]+' || echo "${APP_VERSION:-unknown}")"
NEW_VERSION="${TARGET_VERSION:-$(cat "${YZ_ROOT}/VERSION" 2>/dev/null || echo 'unknown')}"

section "升級 ${CURRENT_VERSION} → ${NEW_VERSION}"

# ═══════════════════════════════════════════════════════════════
section "1／8  安全檢查"
# ═══════════════════════════════════════════════════════════════

# 升級把正在作答的學生踢出去，是這套系統能造成的最直接傷害。
active_exams="$(pg_scalar "SELECT count(*) FROM information_schema.tables WHERE table_name='exam_sessions'")"

if [[ "${active_exams}" == "1" ]]; then
  in_progress="$(pg_scalar "SELECT count(*) FROM exam_sessions WHERE status='IN_PROGRESS'")"
  if (( ${in_progress:-0} > 0 )); then
    err "目前有 ${in_progress} 位學生正在作答。"
    err "升級會中斷他們的考試 —— 前端雖有本地暫存，但體驗上等同當機。"
    if (( FORCE )); then
      warn "已指定 --force，繼續升級。"
    else
      die "請等考試結束，或加上 --force（不建議）。"
    fi
  else
    ok "沒有進行中的考試"
  fi
fi

"${YZ_SCRIPTS_DIR}/doctor.sh" >/dev/null 2>&1 \
  && ok "升級前系統健康" \
  || warn "升級前已有異常。建議先執行 ./deploy/scripts/doctor.sh 處理完再升級。"

confirm_phrase "將升級到 ${NEW_VERSION}，期間服務會短暫中斷。" "UPGRADE"

# ═══════════════════════════════════════════════════════════════
section "2／8  記錄回滾點"
# ═══════════════════════════════════════════════════════════════

ROLLBACK_FILE="${YZ_ROOT}/.rollback-state"
{
  echo "PREVIOUS_VERSION=${CURRENT_VERSION}"
  echo "UPGRADE_STARTED=$(date -Iseconds)"
  echo "TARGET_VERSION=${NEW_VERSION}"
} > "${ROLLBACK_FILE}"
ok "回滾點已記錄"

# ═══════════════════════════════════════════════════════════════
section "3／8  升級前備份"
# ═══════════════════════════════════════════════════════════════

BACKUP_PATH="$("${YZ_SCRIPTS_DIR}/backup.sh" --tag "pre-upgrade" | tail -1)"
[[ -f "${BACKUP_PATH}" ]] || die "備份失敗，已中止升級。沒有退路就不升級。"
echo "BACKUP_PATH=${BACKUP_PATH}" >> "${ROLLBACK_FILE}"
ok "備份：$(basename "${BACKUP_PATH}")"

# ═══════════════════════════════════════════════════════════════
section "4／8  建置新版"
# ═══════════════════════════════════════════════════════════════

# 這一步刻意放在停機之前。建置失敗（網路不通、相依套件抓不到）
# 是最常見的升級失敗原因，而在這裡失敗時服務還好好地跑著。
export APP_VERSION="${NEW_VERSION}"
if ! compose build --pull; then
  err "建置失敗。"
  ok "現有服務未受影響，仍在正常運作。"
  rm -f "${ROLLBACK_FILE}"
  die "請排除建置問題後重試。"
fi
ok "新版映像就緒"

# ═══════════════════════════════════════════════════════════════
section "5／8  維護模式"
# ═══════════════════════════════════════════════════════════════

# 讓使用者看到「系統升級中，預計 X 分鐘後恢復」，
# 而不是瀏覽器的預設錯誤頁 —— 後者會引來一堆電話。
MAINT_DIR="${YZ_ROOT}/deploy/caddy/maintenance"
mkdir -p "${MAINT_DIR}"
cat > "${MAINT_DIR}/index.html" <<HTML
<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>系統升級中 — 雲端智學</title></head>
<body style="font-family:system-ui,sans-serif;background:#f7f8fa;color:#1a1d21;
             display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px;padding:24px">
  <h1 style="font-size:22px;margin-bottom:8px">系統升級中</h1>
  <p style="color:#5b6470;line-height:1.7">
    正在更新到 ${NEW_VERSION}，通常需要 3 到 10 分鐘。<br>
    你先前的作答已經儲存，恢復後可以接續。
  </p>
  <p style="color:#8b949e;font-size:13px">開始時間 $(date '+%H:%M')</p>
</div></body></html>
HTML
touch "${YZ_ROOT}/.maintenance"
ok "維護頁已啟用"

# 任何時候失敗都要嘗試自動回滾，否則會停在維護模式回不去。
_upgrade_failed() {
  err "升級失敗。"
  rm -f "${YZ_ROOT}/.maintenance"
  if (( NO_AUTO_ROLLBACK )); then
    warn "已指定 --no-auto-rollback，保持現狀供你手動診斷。"
    warn "要回滾：./deploy/scripts/rollback.sh"
  else
    warn "自動回滾中…"
    "${YZ_SCRIPTS_DIR}/rollback.sh" --yes || err "自動回滾也失敗了。請照 docs/DISASTER-RECOVERY.md 手動處理。"
  fi
  exit 1
}
trap _upgrade_failed ERR

# ═══════════════════════════════════════════════════════════════
section "6／8  資料庫遷移"
# ═══════════════════════════════════════════════════════════════

info "停止寫入端（資料庫保持運行）…"
app_stop

info "執行遷移…"
compose run --rm migrate
ok "遷移完成"

# ═══════════════════════════════════════════════════════════════
section "7／8  重啟服務"
# ═══════════════════════════════════════════════════════════════

if [[ "$(detect_mode)" == "docker" ]]; then
  compose up -d --force-recreate web worker ai
else
  app_start
fi
ok "服務已重啟"

# ═══════════════════════════════════════════════════════════════
section "8／8  驗證"
# ═══════════════════════════════════════════════════════════════

sleep 5
if ! wait_for_http "http://127.0.0.1:3000/api/readyz" 180 "主應用"; then
  err "新版未能就緒。"
  _upgrade_failed
fi

deployed="$(curl -fsS http://127.0.0.1:3000/api/version 2>/dev/null | grep -oP '"appVersion":"\K[^"]+' || echo unknown)"
if [[ "${deployed}" != "${NEW_VERSION}" && "${NEW_VERSION}" != "unknown" ]]; then
  warn "回報的版本是 ${deployed}，預期 ${NEW_VERSION}。可能是快取或建置參數問題。"
fi

trap - ERR
rm -f "${YZ_ROOT}/.maintenance"

# 升級成功才恢復對外流量
compose up -d caddy >/dev/null
ok "維護模式已解除"

if "${YZ_SCRIPTS_DIR}/doctor.sh" >/dev/null 2>&1; then
  ok "升級後健康檢查通過"
else
  warn "升級後健康檢查有異常，請執行 ./deploy/scripts/doctor.sh 查看。"
fi

pg_exec psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "
  INSERT INTO deployment_records (id, \"appVersion\", \"schemaVersion\", action, \"finishedAt\", succeeded, \"backupPath\")
  VALUES (md5(random()::text), '${NEW_VERSION}', 'current', 'upgrade', now(), true, '${BACKUP_PATH}');" >/dev/null 2>&1 || true

section "完成"
ok "已升級到 ${deployed}"
echo
dim "升級前備份：${BACKUP_PATH}"
dim "若發現問題，24 小時內可用以下指令回滾："
dim "  ./deploy/scripts/rollback.sh"
echo
warn "回滾會把資料庫還原到升級前的狀態 —— 升級後產生的作答與成績會遺失。"
dim "所以回滾要趁早。超過一個營業日就應該考慮往前修而不是往後退。"
echo
