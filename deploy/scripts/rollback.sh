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
#   ./deploy/scripts/rollback.sh --force        # 保險備份失敗也照樣回滾

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CODE_ONLY=0
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --code-only) CODE_ONLY=1; shift ;;
    --force) FORCE=1; shift ;;
    --yes|-y) export YZ_ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
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

# ── 前提檢查 ────────────────────────────────────────────────────
#
# 「退得回去嗎」要在**做任何破壞性動作之前**問，不是走到第 5 步
# 才發現。原本這個判斷在還原資料庫之後才做，於是失敗的樣子是：
# 資料庫已經退回舊版、程式還是新版，而腳本 die 在「無法取得舊版程式」。
#
# 而它最常見的觸發原因就在同一條因果鏈上：磁碟滿 → 有人跑
# `docker image prune` 騰空間 → 舊版映像沒了。離線 tarball 部署
# （build-offline-bundle.sh 的產出）解開來沒有 .git，所以連重建
# 這條退路也是死的。
ROLLBACK_MODE="$(detect_mode)"
if [[ "${ROLLBACK_MODE}" == "docker" ]]; then
  if docker image inspect "yunzhi/web:${PREVIOUS_VERSION}" >/dev/null 2>&1; then
    ok "找得到舊版映像 yunzhi/web:${PREVIOUS_VERSION}"
    HAVE_OLD_IMAGE=1
  elif [[ -d "${YZ_ROOT}/.git" ]] && git -C "${YZ_ROOT}" rev-parse "v${PREVIOUS_VERSION}" >/dev/null 2>&1; then
    warn "找不到 yunzhi/web:${PREVIOUS_VERSION} 的映像，回滾時要重新建置（十幾分鐘，要能連外）。"
    HAVE_OLD_IMAGE=0
  else
    HAVE_OLD_IMAGE=0
    err "拿不到舊版程式，這次回滾走不完。"
    echo
    err "映像 yunzhi/web:${PREVIOUS_VERSION} 不在本機，而且沒有可用的 .git 標籤 v${PREVIOUS_VERSION}。"
    dim "映像不見的原因幾乎都是 docker image prune —— 磁碟滿的時候最自然的動作。"
    dim "離線 tarball 部署的目錄裡本來就沒有 .git，所以重建那條路也不通。"
    echo
    dim "三條路，挑一條："
    # **這一段是在「回滾走不完」的時候印出來的**，也就是最需要它正確
    # 的一刻。原本這裡列的是 yunzhi/web、yunzhi/worker、yunzhi/ai 三個
    # 標籤，而 yunzhi/worker **從來沒有被建出來**（worker 用的就是
    # yunzhi/web 映像，只是啟動指令不同）。docker save 對不存在的
    # reference 是整個失敗，而如果照原本那樣接一個 `| gzip > 檔案`，
    # 檔案還是會產生——只是裡面沒東西。所以這裡用 -o 直接寫檔，
    # 失敗就沒有檔案。
    dim "  1. 把舊版映像找回來（有另一台裝過同版的機器時最快）："
    dim "       來源機： docker save yunzhi/web:${PREVIOUS_VERSION} yunzhi/ai:${PREVIOUS_VERSION} -o yz-${PREVIOUS_VERSION}.tar && gzip yz-${PREVIOUS_VERSION}.tar"
    dim "       這台機： gunzip -c yz-${PREVIOUS_VERSION}.tar.gz | docker load"
    dim "  2. 取回 v${PREVIOUS_VERSION} 的程式（git clone 或舊的離線 tarball），"
    dim "     解到這個目錄再跑一次本腳本。"
    dim "  3. 只退資料庫、程式維持新版（**不建議**，新程式配舊資料）："
    dim "       ./deploy/scripts/restore.sh ${BACKUP_PATH:-<升級前備份>}"
    echo
    dim "下一次升級之前，先把舊版映像存成檔案就不會再撞到這件事："
    dim "  docker save yunzhi/web:\$(cat VERSION) yunzhi/ai:\$(cat VERSION) -o ${BACKUP_DIR:-/var/backups/yunzhi}/images/yz-\$(cat VERSION).tar"
    dim "  存完看一眼檔案大小（應該好幾百 MB）：只有幾十位元組表示上面那句失敗了。"
    die "回滾中止 —— 在動資料庫之前停下來，現在的狀態還是完整的。"
  fi
else
  # 原生安裝本來就要自己 checkout 舊版再跑 install.sh，
  # 這裡先講清楚，不要等到資料庫退完了才說。
  HAVE_OLD_IMAGE=0
  if [[ -d "${YZ_ROOT}/.git" ]] && git -C "${YZ_ROOT}" rev-parse "v${PREVIOUS_VERSION}" >/dev/null 2>&1; then
    ok "找得到 v${PREVIOUS_VERSION} 的程式標籤"
  else
    warn "原生安裝：找不到 v${PREVIOUS_VERSION} 的程式標籤。"
    warn "資料庫可以退，但程式要你自己取回舊版再跑 install.sh。"
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
#
# 回滾本身也可能是錯的決定。先把「現在」存起來，
# 讓「回滾之後發現其實該往前」這條路還開著。
#
# **備份失敗就中止，不是警告。** 下面「還原資料庫」那一段呼叫
# restore.sh 時帶 --no-safety-backup（那是對的，否則會備兩次），
# 所以這一份備份是「現在」的唯一副本。它失敗而照樣往下走，
# 等於下一句直接覆蓋掉一份沒有任何副本的資料庫。
#
# 而 backup.sh 最常見的失敗原因是空間不足（backup.sh 的空間檢查會
# die）。什麼時候會回滾？升級出問題的時候。什麼最常讓升級出問題？
# 磁碟。**這兩個條件會同時成立**，所以這裡不能是 warn。
#
# 同一件事在 restore.sh 是 die（「沒有退路就不做還原」），
# 兩支腳本的判斷要一致。
info "先備份目前狀態（讓回滾也能被回滾）…"
# stderr 留著：die 的原因（通常是「剩餘 3GB，估計需要 12GB」）
# 要讓執行的人當場看到，那一句就是他的下一步。
SAFETY_OK=0
if "${YZ_SCRIPTS_DIR}/backup.sh" --tag "pre-rollback" --quiet >/dev/null; then
  ok "保險備份完成"
  SAFETY_OK=1
elif (( CODE_ONLY )); then
  # --code-only 不會覆蓋資料庫，所以沒有東西會因為缺這份備份而消失。
  # （舊版程式配新版 schema 仍可能寫壞資料，所以還是要講。）
  warn "保險備份失敗。--code-only 不動資料庫，所以繼續。"
  warn "但舊版程式讀新版 schema 有寫壞資料的風險，而現在沒有副本。"
elif (( FORCE )); then
  warn "保險備份失敗，但已指定 --force，仍繼續回滾。"
  warn "「現在」的資料從這一刻起沒有任何副本，而下一步就會覆蓋它。"
else
  err "保險備份失敗，已中止回滾。"
  echo
  err "現在的狀態沒有被存下來，而回滾的下一步就是覆蓋它。"
  dim "最常見的原因是磁碟空間不足（上面那一行會寫需要多少）。依序試："
  dim "  1. 看還剩多少：              df -h ${BACKUP_DIR:-/var/backups/yunzhi}"
  dim "  2. 找出最舊的備份刪掉：       ls -t ${BACKUP_DIR:-/var/backups/yunzhi}/yunzhi-*.tar.gz*"
  dim "  3. 清掉停掉的容器與建置快取： docker system prune -f"
  dim "     **不要跑 docker image prune** —— 那會刪掉舊版映像，讓這次回滾"
  dim "     連程式都退不回去（離線 tarball 部署沒有 .git 可以重建）。"
  dim "  4. 空間夠了再跑一次：        ./deploy/scripts/rollback.sh"
  echo
  dim "如果只是要退程式版本、資料庫維持現狀（不需要這份備份）："
  dim "  ./deploy/scripts/rollback.sh --code-only"
  dim "確定要在沒有副本的情況下覆蓋資料庫："
  dim "  ./deploy/scripts/rollback.sh --force"
  die "沒有退路就不回滾。"
fi

# ── 維護模式 ────────────────────────────────────────────────────
MAINT_DIR="${YZ_ROOT}/deploy/caddy/maintenance"
mkdir -p "${MAINT_DIR}"
touch "${MAINT_DIR}/.maintenance"
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

if [[ "${ROLLBACK_MODE}" == "native" ]]; then
  warn "原生安裝的回滾需要重新部署舊版程式碼。"
  dim "請 checkout 舊版標籤後重跑 install.sh："
  dim "  git checkout v${PREVIOUS_VERSION} && sudo ./deploy/scripts/install.sh --skip-packages"
elif (( HAVE_OLD_IMAGE )); then
  ok "找到舊版映像"
else
  # 前提檢查（上面）已經確認過 .git 與標籤都在，所以走到這裡是可以建的。
  info "重新建置舊版（十幾分鐘）…"
  git -C "${YZ_ROOT}" stash push -q --include-untracked 2>/dev/null || true
  git -C "${YZ_ROOT}" checkout -q "v${PREVIOUS_VERSION}"
  compose build || die "舊版建置失敗。資料庫已經退回 ${PREVIOUS_VERSION}，程式還是新版——請排除建置問題後重跑本腳本。"
fi

if [[ "${ROLLBACK_MODE}" == "docker" ]]; then
  compose up -d --force-recreate web worker ai
  rm -f "${MAINT_DIR}/.maintenance"
  if [[ "${PROXY_MODE:-caddy}" == "caddy" ]]; then compose up -d caddy; fi >/dev/null
else
  app_start
  rm -f "${MAINT_DIR}/.maintenance"
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
# 這句話只有在保險備份真的成功時才成立。--force 走的正是它失敗的
# 那條路，而在完成畫面上告訴人「還可以取回」是最不該說錯的一句。
if (( SAFETY_OK )); then
  dim "回滾前的狀態已備份為 pre-rollback 標籤，若判斷有誤仍可取回。"
else
  warn "**沒有 pre-rollback 備份**（保險備份失敗，你用 --force 繼續了）。"
  warn "回滾前的那份資料已經沒有了，這一步不可逆。"
fi
echo
