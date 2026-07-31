#!/usr/bin/env bash
# 雲端智學 — 還原
#
# 用法：
#   ./deploy/scripts/restore.sh <備份檔>
#   ./deploy/scripts/restore.sh --latest
#   ./deploy/scripts/restore.sh <備份檔> --to "2026-07-27 14:30:00"   # 時間點還原
#   ./deploy/scripts/restore.sh <備份檔> --into yunzhi_drill          # 還原到另一個資料庫（演練用）
#   ./deploy/scripts/restore.sh <備份檔> --skip-objects                # 只還原資料庫，不動物件儲存
#
# 四個安全設計：
#   1. 還原前一定先備份現況（除非 --no-safety-backup）。
#      「還原了才發現拿錯備份」是很常見的，而那時原本的資料已經沒了。
#   2. schema hash 不符時要求明確確認。用新版程式讀舊版 schema
#      會以難以預料的方式壞掉，而且往往不是立刻壞。
#   3. --into 讓演練不碰正式資料庫。
#   4. 物件儲存缺漏會在**覆蓋資料庫之前**就擋下來。缺了它，還原出來的
#      系統是「題目文字都在、每一道帶圖的題目是空白」，而完成訊息
#      看起來完全正常 —— 那是最難被發現的一種還原失敗。

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ARCHIVE=""
USE_LATEST=0
TARGET_TIME=""
INTO_DB=""
SAFETY_BACKUP=1
SKIP_OBJECTS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest) USE_LATEST=1; shift ;;
    --to) TARGET_TIME="$2"; shift 2 ;;
    --into) INTO_DB="$2"; shift 2 ;;
    --no-safety-backup) SAFETY_BACKUP=0; shift ;;
    --skip-objects) SKIP_OBJECTS=1; shift ;;
    --yes|-y) export YZ_ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    -*) die "不認得的參數：$1" ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done

acquire_lock "restore"
load_env
require_env POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD

BACKUP_DIR="${BACKUP_DIR:-${YZ_ROOT}/data/backups}"

if (( USE_LATEST )); then
  ARCHIVE="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'yunzhi-*.tar.gz*' ! -name '*.sha256' \
    -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  [[ -n "${ARCHIVE}" ]] || die "在 ${BACKUP_DIR} 找不到任何備份。"
fi

# 提示裡要列**最新的**五份，而且只列真的能還原的檔案。
#
# 本來這裡是 `ls -1 | head -5`：檔名開頭是 yunzhi-YYYYMMDD，
# 字典序等於時間由舊到新，於是保留三十天的機器上列出來的是**最舊的
# 五份**（第一份還在的通常是一個月前）。而且 .sha256 沿檔也一起列進去，
# 看起來像是可以拿來還原的檔案。要還原的人正處在最需要正確資訊的時刻。
_recent_backups() {
  find "${BACKUP_DIR}" -maxdepth 1 -name 'yunzhi-*.tar.gz*' ! -name '*.sha256' \
    -type f -printf '%T@ %f\n' 2>/dev/null \
    | sort -rn | head -5 | cut -d' ' -f2- | tr '\n' ' '
}
[[ -n "${ARCHIVE}" ]] || die "請指定備份檔，或用 --latest。最近的備份：$(_recent_backups)"
[[ -f "${ARCHIVE}" ]] || die "找不到檔案：${ARCHIVE}"

RESTORE_DB="${INTO_DB:-${POSTGRES_DB}}"
IS_DRILL=$([[ -n "${INTO_DB}" ]] && echo 1 || echo 0)

WORK="$(mktemp -d "${TMPDIR:-/tmp}/yunzhi-restore-XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

started="$(date +%s)"

section "還原：$(basename "${ARCHIVE}")"

# ── 校驗碼 ──────────────────────────────────────────────────────
if [[ -f "${ARCHIVE}.sha256" ]]; then
  info "驗證校驗碼…"
  # shellcheck disable=SC2015  # ok() 是 printf 包裝、必定回 0，不會誤判成校驗失敗
  ( cd "$(dirname "${ARCHIVE}")" && sha256sum -c "$(basename "${ARCHIVE}").sha256" >/dev/null 2>&1 ) \
    && ok "校驗碼相符" \
    || die "校驗碼不符，備份檔已損壞。不要用它還原。"
else
  warn "沒有校驗碼檔案，無法確認完整性。"
fi

# ── 解密與解壓 ──────────────────────────────────────────────────
if [[ "${ARCHIVE}" == *.enc ]]; then
  [[ -n "${BACKUP_ENCRYPTION_KEY:-}" ]] || die "備份是加密的，但 .env 中沒有 BACKUP_ENCRYPTION_KEY。"
  info "解密…"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "${ARCHIVE}" -out "${WORK}/backup.tar.gz" -pass "pass:${BACKUP_ENCRYPTION_KEY}" \
    || die "解密失敗。金鑰不對，或備份是用不同的金鑰加密的。"
  tar -xzf "${WORK}/backup.tar.gz" -C "${WORK}" && rm -f "${WORK}/backup.tar.gz"
else
  info "解壓…"
  tar -xzf "${ARCHIVE}" -C "${WORK}"
fi

[[ -f "${WORK}/database.dump" ]] || die "備份中沒有 database.dump，檔案結構不正確。"
ok "解壓完成"

# ── 中繼資料與相容性 ────────────────────────────────────────────
B_OBJECTS="unknown"
B_OBJCOUNT="unknown"
B_BASE="unknown"
if [[ -f "${WORK}/manifest.json" ]]; then
  B_BASE="$(grep -oP '"includesBaseBackup":\s*\K(true|false)' "${WORK}/manifest.json" || echo unknown)"
  b_ver="$(grep -oP '"appVersion":\s*"\K[^"]+' "${WORK}/manifest.json" || echo unknown)"
  b_time="$(grep -oP '"createdAt":\s*"\K[^"]+' "${WORK}/manifest.json" || echo unknown)"
  b_hash="$(grep -oP '"schemaHash":\s*"\K[^"]+' "${WORK}/manifest.json" || echo unknown)"
  B_OBJECTS="$(grep -oP '"includesObjects":\s*\K(true|false)' "${WORK}/manifest.json" || echo unknown)"
  B_OBJCOUNT="$(grep -oP '"objectCount":\s*\K[0-9]+' "${WORK}/manifest.json" || echo unknown)"
  info "備份建立於 ${b_time}，版本 ${b_ver}"

  cur_ver="${APP_VERSION:-$(cat "${YZ_ROOT}/VERSION" 2>/dev/null || echo unknown)}"
  cur_hash="$(pg_scalar "SELECT md5(string_agg(table_name || column_name || data_type, ',' ORDER BY table_name, column_name)) FROM information_schema.columns WHERE table_schema='public'")"
  cur_hash="${cur_hash:-unknown}"

  if [[ "${b_hash}" != "unknown" && "${cur_hash}" != "unknown" && "${b_hash}" != "${cur_hash}" ]]; then
    warn "備份的資料庫結構與目前不同。"
    dim "備份版本 ${b_ver}／目前版本 ${cur_ver}"
    dim "還原後請立刻執行遷移：docker compose run --rm migrate"
    (( IS_DRILL )) || confirm_phrase "結構不符，仍要繼續？" "RESTORE ANYWAY"
  fi
fi

# ── 指定時間點還原（--to）───────────────────────────────────────
#
# **這一段一定要在覆蓋資料庫之前。**
#
# 原本的 --to 是這樣走的：整支腳本照常把備份**覆蓋到正式資料庫上**，
# 一路走到最後才印一句「PITR 是另一個獨立流程，WAL 已解壓到某處」。
# 也就是說，要求「回到今天下午三點」的人，實際拿到的是「回到凌晨
# 三點十五分那份備份」，而中午到下午的作答已經被蓋掉了 ——
# 那正是他打這個指令要救的東西。
#
# 現在改成：--to 完全不碰正式資料庫，只把時間點還原需要的材料備齊、
# 檢查它們夠不夠，然後把**驗證過的**步驟印出來。時間點還原要停資料庫、
# 換整個資料目錄，是一件需要人在旁邊看著的事，不適合順手做掉。
if [[ -n "${TARGET_TIME}" ]]; then
  section "指定時間點還原的準備"

  if [[ ! -f "${WORK}/base.tar.gz" ]]; then
    err "這份備份裡沒有實體基礎備份（base.tar.gz），做不了時間點還原。"
    if [[ "${B_BASE}" == "false" ]]; then
      dim "manifest 也是這麼記的：這份備份產生時就沒有取到基礎備份。"
      dim "常見原因是 pg_hba.conf 少了 replication 規則，或 BACKUP_BASE_BACKUP=false。"
    else
      dim "這份備份是舊版本產生的（v0.26.0 之前只有邏輯 dump）。"
    fi
    echo
    dim "**WAL 檔案本身不足以做時間點還原。** WAL 記的是資料庫檔案的哪個"
    dim "位元組被改了，只能重放在實體基礎備份上，重放不到 pg_restore"
    dim "還原出來的資料庫上——那是兩個不同層次的東西。"
    echo
    dim "現在可以做的：不加 --to 直接還原，得到「備份當下」的狀態。"
    dim "  ./deploy/scripts/restore.sh $(basename "${ARCHIVE}")"
    die "沒有基礎備份，時間點還原無法進行。正式資料庫未被更動。"
  fi

  PITR_DIR="${BACKUP_DIR}/pitr-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "${PITR_DIR}/wal"
  cp "${WORK}/base.tar.gz" "${PITR_DIR}/"
  if [[ -d "${WORK}/wal" ]]; then
    cp -r "${WORK}/wal/." "${PITR_DIR}/wal/" 2>/dev/null || true
  fi

  # **備份裡的 WAL 是備份「之前」的。** 要往前滾到今天下午三點，需要的
  # 是基礎備份**之後**產生的那些段，它們還在資料庫的歸檔目錄裡。
  # 少了這一步，復原會停在基礎備份的時點而且看起來像成功了。
  info "從資料庫的歸檔目錄補齊備份之後產生的 WAL…"
  if pg_sh "tar -cf - -C '$(wal_archive_dir)' . 2>/dev/null" \
       | tar -xf - -C "${PITR_DIR}/wal" 2>/dev/null; then
    ok "歸檔目錄已併入"
  else
    warn "讀不到資料庫的 WAL 歸檔目錄。只能用備份裡的那些 WAL，"
    warn "可還原的最新時點會停在備份當下。"
  fi
  wal_have="$(find "${PITR_DIR}/wal" -type f 2>/dev/null | wc -l)"

  ok "材料已備妥：${PITR_DIR}"
  dim "  base.tar.gz（實體基礎備份，備份時點 ${b_time:-未知}）"
  dim "  wal/（${wal_have} 個 WAL 段）"
  echo
  warn "接下來的步驟要停止資料庫、在旁邊看著日誌跑完，不會自動進行。"
  dim "完整步驟見 docs/DISASTER-RECOVERY.md 的「情況三」，該節已針對"
  dim "這個目錄的內容寫成可以逐行照貼的指令。"
  dim "目標時間：${TARGET_TIME}"
  echo
  ok "正式資料庫完全未被更動。"
  exit 0
fi

# ── 物件儲存的可用性 ────────────────────────────────────────────
#
# **這一段要在覆蓋資料庫之前跑完，不是等到還原完才發現。**
#
# 原本的判斷是還原到最後一步的 `[[ -d "${WORK}/objects" ]]`：目錄不在
# 就靜靜跳過。於是最壞的一條路是完全無聲的——資料庫還原成功、
# 完成訊息說「資料表 68 張、使用者 213 位」，而每一道「如右圖」的題目
# 是空白的、每一份題本原檔不見了，沒有人在過程中看到任何一個字。
#
# 三種狀態要分開，因為使用者要做的事不一樣：
#   ok       備份裡有物件，照原樣還原
#   absent   備份本身就沒有物件（備份當下 MinIO 掛了，或用了 --no-objects）
#   mismatch 備份說有物件，但解壓出來的目錄不在或是空的 → 備份檔壞了
OBJECTS_STATE=ok
if (( SKIP_OBJECTS )); then
  OBJECTS_STATE=skipped
elif [[ ! -d "${WORK}/objects" ]] || [[ -z "$(ls -A "${WORK}/objects" 2>/dev/null)" ]]; then
  if [[ "${B_OBJECTS}" == "true" ]]; then
    OBJECTS_STATE=mismatch
  else
    OBJECTS_STATE=absent
  fi
else
  have_objs="$(find "${WORK}/objects" -type f 2>/dev/null | wc -l)"
  if [[ "${B_OBJCOUNT}" =~ ^[0-9]+$ ]] && (( have_objs < B_OBJCOUNT )); then
    OBJECTS_STATE=mismatch
  fi
fi

if (( ! IS_DRILL )); then
  case "${OBJECTS_STATE}" in
    ok)
      if [[ "${B_OBJCOUNT}" =~ ^[0-9]+$ ]]; then
        ok "物件儲存：${B_OBJCOUNT} 個，備份裡都在"
      else
        ok "物件儲存：備份裡有（這份備份沒記數量）"
      fi ;;
    skipped)
      warn "已指定 --skip-objects：物件儲存不還原。"
      dim "題目文字會還原，圖片與題本原檔維持現在 MinIO 裡的內容。" ;;
    absent)
      err "這份備份**不含物件儲存**。"
      err "還原之後：題目文字都在，但每一道「如右圖」的題目會是空白，題本原檔也不在。"
      dim "備份當下 MinIO 連不上、或那次備份帶了 --no-objects，都會是這樣。"
      dim "先確認有沒有別的備份含物件：ls -t ${BACKUP_DIR}/yunzhi-*.tar.gz*"
      confirm_phrase "確定要用一份沒有圖的備份還原？" "RESTORE WITHOUT OBJECTS" ;;
    mismatch)
      err "這份備份說它含物件儲存，但解壓出來對不上。"
      err "manifest 記的是 ${B_OBJCOUNT} 個，實際解出 ${have_objs:-0} 個。"
      dim "這代表備份檔本身不完整（打包時被中斷，或磁碟寫滿）。"
      dim "換一份備份，或加 --skip-objects 只還原資料庫。"
      die "不用一份對不上的備份覆蓋資料庫。" ;;
  esac
fi

# ── 安全備份 ────────────────────────────────────────────────────
if (( SAFETY_BACKUP )) && (( ! IS_DRILL )); then
  info "還原前先備份目前的資料…"
  "${YZ_SCRIPTS_DIR}/backup.sh" --tag "pre-restore" --quiet >/dev/null \
    || die "安全備份失敗。沒有退路就不做還原。要跳過請加 --no-safety-backup。"
  ok "安全備份完成"
fi

# ── 確認 ────────────────────────────────────────────────────────
if (( ! IS_DRILL )); then
  echo
  err "這會用備份的內容**覆蓋**資料庫 ${POSTGRES_DB} 的全部內容。"
  err "目前資料庫中比這份備份新的資料都會消失。"
  confirm_phrase "確定要還原？" "RESTORE"
fi

# ── 停止應用 ────────────────────────────────────────────────────
# 還原期間應用若還在寫入，會產生一個既非舊也非新的混合狀態。
if (( ! IS_DRILL )); then
  info "停止應用（資料庫保持運行）…"
  app_stop
fi

# ── 還原資料庫 ──────────────────────────────────────────────────
if (( IS_DRILL )); then
  info "建立演練用資料庫 ${RESTORE_DB}…"
  pg_exec psql -U "${POSTGRES_USER}" -d postgres \
    -c "DROP DATABASE IF EXISTS ${RESTORE_DB};" >/dev/null 2>&1 || true
  if ! pg_exec psql -U "${POSTGRES_USER}" -d postgres \
      -c "CREATE DATABASE ${RESTORE_DB};" >/dev/null 2>"${WORK}/createdb.err"; then
    if grep -qi 'permission denied to create database' "${WORK}/createdb.err"; then
      err "資料庫角色 ${POSTGRES_USER} 沒有 CREATEDB 權限，無法建立演練資料庫。"
      dim "修正方式（原生安裝）："
      dim "  sudo -u postgres psql -c 'ALTER ROLE ${POSTGRES_USER} CREATEDB;'"
      dim "這個權限只用於還原演練，不影響日常運作 —— 但少了它就無法在"
      dim "不碰正式資料的前提下驗證備份。"
    fi
    cat "${WORK}/createdb.err" >&2
    die "無法建立演練資料庫。"
  fi
  # 擴充功能必須先建立，否則 dump 裡的 CREATE EXTENSION 會以
  # 應用帳號身分執行而失敗（pgvector 不是 trusted extension）。
  if ! ensure_extensions "${RESTORE_DB}"; then
    warn "無法在演練資料庫建立擴充功能（需要資料庫超級使用者）。"
    dim "原生安裝請用 sudo 執行本腳本；或先手動建立："
    dim "  sudo -u postgres psql -d ${RESTORE_DB} -c 'CREATE EXTENSION vector;'"
    dim "沒有擴充功能時，含向量欄位的資料表會還原失敗。"
  fi
fi

# ── 清空目標 schema ────────────────────────────────────────────
#
# 這裡刻意**不用** `pg_restore --clean`。原因是它會產生
# `DROP EXTENSION IF EXISTS vector;`，而擴充功能屬於當初建立它的
# 超級使用者，應用帳號動不了 —— 配上 --exit-on-error 就是每一次
# 還原都在第一步失敗。那會讓整套備份策略形同虛設，而且要到真的
# 需要還原的那一天才會發現。
#
# 改成自己把 public schema 裡的物件清掉（表、序列、型別、函式），
# **但保留擴充功能**，然後不帶 --clean 還原。pg_dump 產生的是
# `CREATE EXTENSION IF NOT EXISTS`，所以擴充功能已存在不會有問題。
if (( ! IS_DRILL )); then
  info "清空目標 schema（保留擴充功能）…"
  pg_exec psql -U "${POSTGRES_USER}" -d "${RESTORE_DB}" -q -c "
    DO \$\$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
      END LOOP;
      FOR r IN SELECT viewname FROM pg_views WHERE schemaname='public' LOOP
        EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.viewname);
      END LOOP;
      FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
        EXECUTE format('DROP SEQUENCE IF EXISTS public.%I CASCADE', r.sequencename);
      END LOOP;
      FOR r IN SELECT t.typname FROM pg_type t
               JOIN pg_namespace n ON n.oid = t.typnamespace
               LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
               WHERE n.nspname='public' AND t.typtype IN ('e','c') AND d.objid IS NULL LOOP
        EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
      END LOOP;
      FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
               LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
               WHERE n.nspname='public' AND d.objid IS NULL LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.sig);
      END LOOP;
    END \$\$;" 2>"${WORK}/clean.err" || {
      warn "清空 schema 時有警告："
      head -5 "${WORK}/clean.err" >&2
    }
  ok "schema 已清空"
fi

info "還原資料庫…"
# -j 平行還原，大幅縮短 RTO —— 這是 4 小時 RTO 承諾的關鍵之一。
jobs="$(cpu_count)"; (( jobs > 4 )) && jobs=4

# 刻意不用 --exit-on-error：某些訊息（擴充功能已存在、註解權限）
# 是無害的。**改為以結果驗證而非以結束碼驗證** —— 下方的資料表
# 計數才是真正的關卡，那比任何錯誤字串比對都可靠。
# 平行還原需要檔案路徑（不支援 stdin），docker 模式下先送進容器
DUMP_REMOTE="$(pg_stage_file "${WORK}/database.dump")"
pg_exec pg_restore \
      -U "${POSTGRES_USER}" -d "${RESTORE_DB}" \
      --no-owner --no-privileges --jobs="${jobs}" \
      "${DUMP_REMOTE}" 2>"${WORK}/restore.err" || true
pg_unstage_file "${DUMP_REMOTE}"

BENIGN='already exists|must be owner of extension|extension "[^"]+" does not exist|no privileges (could|were) granted|must be owner of schema public'
fatal_errors="$(grep -iE '^pg_restore: error' "${WORK}/restore.err" 2>/dev/null \
                | grep -vEi "${BENIGN}" | head -20 || true)"

if [[ -n "${fatal_errors}" ]]; then
  err "還原過程出現無法忽略的錯誤："
  printf '%s\n' "${fatal_errors}" >&2
  die "資料庫可能處於不一致狀態。請用 pre-restore 備份重試。"
fi

benign_count="$(grep -icE "${BENIGN}" "${WORK}/restore.err" 2>/dev/null || echo 0)"
(( benign_count > 0 )) && dim "略過 ${benign_count} 則無害訊息（擴充功能已存在等）"

ok "資料庫已還原到 ${RESTORE_DB}"

# 時間點還原（--to）在上面、覆蓋資料庫之前就處理完並結束了。
# 走到這裡就表示這是一次一般還原。

# ── 物件儲存 ────────────────────────────────────────────────────
# 狀態在上面（覆蓋資料庫之前）就決定好了，這裡只負責執行與回報。
OBJECTS_RESTORED=0
if (( ! IS_DRILL )) && [[ "${OBJECTS_STATE}" == "ok" ]]; then
  info "還原物件儲存…"
  if tar -cf - -C "${WORK}/objects" . 2>/dev/null | s3_sh "
        rm -rf /tmp/restore && mkdir -p /tmp/restore && tar -xf - -C /tmp/restore
        mc alias set local http://localhost:9000 '${S3_ACCESS_KEY}' '${S3_SECRET_KEY}' >/dev/null 2>&1
        mc mirror --quiet --overwrite /tmp/restore local/${S3_BUCKET} >/dev/null 2>&1
        rm -rf /tmp/restore" 2>/dev/null; then
    ok "物件儲存已還原"
    OBJECTS_RESTORED=1
  else
    # 這裡不 die：資料庫已經還原完了，中止只會讓應用停在停機狀態。
    # 但完成訊息必須說出來，而且要給下一步。
    err "物件儲存還原失敗。資料庫已經還原，圖片與題本原檔沒有。"
    dim "MinIO 是否在跑：docker compose ps minio"
    dim "排除之後可以只補物件：./deploy/scripts/restore.sh ${ARCHIVE}"
  fi
fi

# ── 重啟與驗證 ──────────────────────────────────────────────────
if (( ! IS_DRILL )); then
  info "重啟應用…"
  app_start
  wait_for_http "http://127.0.0.1:3000/api/readyz" 180 "主應用" 2>/dev/null || \
    warn "主應用未在 180 秒內就緒。docker：docker compose logs web｜原生：journalctl -u yunzhi-web -n 50"
fi

# ── 完整性檢查 ──────────────────────────────────────────────────
info "檢查還原結果…"
counts="$(pg_exec psql -U "${POSTGRES_USER}" -d "${RESTORE_DB}" -tAF'|' -c "
  SELECT
    (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'),
    (SELECT count(*) FROM users),
    (SELECT count(*) FROM tenants)" 2>/dev/null || echo "0|0|0")"
IFS='|' read -r n_tables n_users n_tenants <<< "${counts}"

if (( n_tables == 0 )); then
  die "還原後資料庫是空的。還原失敗。"
fi

elapsed=$(( $(date +%s) - started ))

section "完成"
ok "資料表 ${n_tables} 張、使用者 ${n_users} 位、租戶 ${n_tenants} 個"
dim "耗時 ${elapsed} 秒（RTO 參考值）"

# 「還原完成」這四個字不可以在缺圖的情況下單獨出現。
# 上面那一行（68 張表、213 位使用者）看起來永遠是正常的。
if (( ! IS_DRILL )); then
  case "${OBJECTS_STATE}" in
    ok)
      if (( OBJECTS_RESTORED )); then
        ok "物件儲存已還原（題本原檔與題目附圖）"
      else
        err "物件儲存**沒有**還原成功——帶圖的題目會是空白的。"
      fi ;;
    skipped) warn "物件儲存依 --skip-objects 未還原。" ;;
    absent)  err "這份備份不含物件儲存：帶圖的題目會是空白的，題本原檔不在。" ;;
  esac
fi

if (( IS_DRILL )); then
  echo
  dim "這是演練，正式資料庫 ${POSTGRES_DB} 未受影響。"
  dim "清理演練資料庫："
  dim "  docker compose exec postgres psql -U ${POSTGRES_USER} -d postgres -c 'DROP DATABASE ${RESTORE_DB};'"
else
  echo
  warn "還原後請立刻確認："
  dim "1. 登入系統，確認最近一次考試的成績正確"
  dim "2. 隨機開啟幾道題目，確認圖片顯示正常（圖片在物件儲存，與資料庫分開備份）"
  dim "3. 若備份與目前版本的 schema 不同，執行：docker compose run --rm migrate"
fi
echo
