#!/usr/bin/env bash
# 雲端智學 — 回滾
#
# 把系統退回上一次升級之前的狀態：程式版本與資料庫都退。
#
# **回滾會遺失資料**，這一點必須講在最前面：升級之後產生的
# 所有作答、成績、匯入的題目都會消失，因為資料庫要還原到
# 升級前的備份。所以回滾是「剛升級完發現不對」的手段，
# 不是「用了三天覺得不好」的手段。
#
# 用法：
#   ./deploy/scripts/rollback.sh
#   ./deploy/scripts/rollback.sh --code-only    # 只退程式，不動資料庫

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CODE_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --code-only) CODE_ONLY=1; shift ;;
    --yes|-y) export YZ_ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

acquire_lock "rollback"
load_env

ROLLBACK_FILE="${YZ_ROOT}/.rollback-state"
[[ -f "${ROLLBACK_FILE}" ]] || die "找不到回滾狀態檔 ${ROLLBACK_FILE}。沒有升級記錄就無從回滾。若要還原到特定備份，請直接用 restore.sh。"

# shellcheck disable=SC1090
source "${ROLLBACK_FILE}"

section "回滾 ${TARGET_VERSION:-?} → ${PREVIOUS_VERSION:-?}"

info "升級開始於 ${UPGRADE_STARTED:-未知}"
[[ -n "${BACKUP_PATH:-}" ]] && info "升級前備份：$(basename "${BACKUP_PATH}")"

if [[ -n "${UPGRADE_STARTED:-}" ]]; then
  elapsed_h=$(( ( $(date +%s) - $(date -d "${UPGRADE_STARTED}" +%s 2>/dev/null || echo 0) ) / 3600 ))
  if (( elapsed_h > 24 )); then
    warn "距離升級已經 ${elapsed_h} 小時。"
    warn "這段期間的作答、成績與匯入的題目都會因為資料庫還原而消失。"
    dim "若只是想退回舊版程式而保留資料，用 --code-only ——"
    dim "但要注意舊版程式配上新版 schema 可能有相容性問題。"
  fi
fi

# ── 確認 ────────────────────────────────────────────────────────
if (( CODE_ONLY )); then
  warn "只回滾程式版本，資料庫維持在升級後的結構。"
  warn "舊版程式讀新版 schema 有風險，僅在確知相容時使用。"
  confirm_phrase "只回滾程式？" "ROLLBACK CODE"
else
  err "資料庫將還原到 ${UPGRADE_STARTED:-升級時點}。"
  err "在那之後的所有資料變更都會**永久消失**。"
  confirm_phrase "確定要回滾？" "ROLLBACK"
fi

# ── 保險備份 ────────────────────────────────────────────────────
# 回滾本身也可能是錯的決定。先把「現在」存起來，
# 讓「回滾之後發現其實該往前」這條路還開著。
info "先備份目前狀態（讓回滾也能被回滾）…"
"${YZ_SCRIPTS_DIR}/backup.sh" --tag "pre-rollback" --quiet >/dev/null \
  || warn "保險備份失敗，仍繼續回滾。"

# ── 維護模式 ────────────────────────────────────────────────────
touch "${YZ_ROOT}/.maintenance"
app_stop

# ── 還原資料庫 ──────────────────────────────────────────────────
if (( ! CODE_ONLY )); then
  [[ -f "${BACKUP_PATH:-}" ]] || die "找不到升級前備份 ${BACKUP_PATH}。無法回滾資料庫。可改用 --code-only。"
  info "還原資料庫…"
  "${YZ_SCRIPTS_DIR}/restore.sh" "${BACKUP_PATH}" --no-safety-backup --yes \
    || die "資料庫還原失敗。系統目前處於不確定狀態，請照 docs/DISASTER-RECOVERY.md 處理。"
  ok "資料庫已還原"
fi

# ── 還原程式版本 ────────────────────────────────────────────────
info "切回 ${PREVIOUS_VERSION}…"
export APP_VERSION="${PREVIOUS_VERSION}"

if [[ "$(detect_mode)" == "native" ]]; then
  warn "原生安裝的回滾需要重新部署舊版程式碼。"
  dim "請 checkout 舊版標籤後重跑 install.sh："
  dim "  git checkout v${PREVIOUS_VERSION} && sudo ./deploy/scripts/install.sh --skip-packages"
elif docker image inspect "yunzhi/web:${PREVIOUS_VERSION}" >/dev/null 2>&1; then
  ok "找到舊版映像"
else
  warn "找不到 yunzhi/web:${PREVIOUS_VERSION} 的映像，需要重新建置。"
  warn "這通常表示曾執行過 docker image prune。"
  info "重新建置舊版…"
  if [[ -d "${YZ_ROOT}/.git" ]] && git -C "${YZ_ROOT}" rev-parse "v${PREVIOUS_VERSION}" >/dev/null 2>&1; then
    git -C "${YZ_ROOT}" stash push -q --include-untracked 2>/dev/null || true
    git -C "${YZ_ROOT}" checkout -q "v${PREVIOUS_VERSION}"
    compose build || die "舊版建置失敗。"
  else
    die "無法取得舊版程式。請手動 checkout 舊版標籤後再執行本腳本。"
  fi
fi

if [[ "$(detect_mode)" == "docker" ]]; then
  compose up -d --force-recreate web worker ai
  rm -f "${YZ_ROOT}/.maintenance"
  compose up -d caddy >/dev/null
else
  app_start
  rm -f "${YZ_ROOT}/.maintenance"
fi

# ── 驗證 ────────────────────────────────────────────────────────
if wait_for_http "http://127.0.0.1:3000/api/readyz" 180 "主應用"; then
  deployed="$(curl -fsS http://127.0.0.1:3000/api/version 2>/dev/null | grep -oP '"appVersion":"\K[^"]+' || echo unknown)"
  ok "已回滾到 ${deployed}"
else
  err "回滾後主應用仍未就緒。"
  dim "診斷：docker compose logs --tail 100 web"
  dim "最後手段見 docs/DISASTER-RECOVERY.md 的「完全重建」一節。"
  exit 1
fi

pg_exec psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "
  INSERT INTO deployment_records (id, \"appVersion\", \"schemaVersion\", action, \"finishedAt\", succeeded, notes)
  VALUES (md5(random()::text), '${PREVIOUS_VERSION}', 'current', 'rollback', now(), true,
          'rolled back from ${TARGET_VERSION}');" >/dev/null 2>&1 || true

mv "${ROLLBACK_FILE}" "${ROLLBACK_FILE}.done-$(date +%Y%m%d-%H%M%S)"

section "完成"
ok "系統已回到 ${PREVIOUS_VERSION}"
echo
warn "請立刻確認："
dim "1. 登入並檢查最近一次考試的成績是否正確"
dim "2. 通知老師：升級後到回滾之間的操作已經消失，需要重做"
dim "3. 記錄這次回滾的原因，避免下次升級重蹈覆轍"
echo
dim "回滾前的狀態已備份為 pre-rollback 標籤，若判斷有誤仍可取回。"
echo
