#!/usr/bin/env bash
# 雲端智學 — 還原
#
# 用法：
#   ./deploy/scripts/restore.sh <備份檔>
#   ./deploy/scripts/restore.sh --latest
#   ./deploy/scripts/restore.sh <備份檔> --to "2026-07-27 14:30:00"   # 時間點還原
#   ./deploy/scripts/restore.sh <備份檔> --into yunzhi_drill          # 還原到另一個資料庫（演練用）
#
# 三個安全設計：
#   1. 還原前一定先備份現況（除非 --no-safety-backup）。
#      「還原了才發現拿錯備份」是很常見的，而那時原本的資料已經沒了。
#   2. schema hash 不符時要求明確確認。用新版程式讀舊版 schema
#      會以難以預料的方式壞掉，而且往往不是立刻壞。
#   3. --into 讓演練不碰正式資料庫。

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
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
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

[[ -n "${ARCHIVE}" ]] || die "請指定備份檔，或用 --latest。可用備份：$(ls -1 "${BACKUP_DIR}" 2>/dev/null | head -5 | tr '\n' ' ')"
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
if [[ -f "${WORK}/manifest.json" ]]; then
  b_ver="$(grep -oP '"appVersion":\s*"\K[^"]+' "${WORK}/manifest.json" || echo unknown)"
  b_time="$(grep -oP '"createdAt":\s*"\K[^"]+' "${WORK}/manifest.json" || echo unknown)"
  b_hash="$(grep -oP '"schemaHash":\s*"\K[^"]+' "${WORK}/manifest.json" || echo unknown)"
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

# ── 時間點還原 ──────────────────────────────────────────────────
if [[ -n "${TARGET_TIME}" ]]; then
  if [[ -d "${WORK}/wal" ]] && [[ -n "$(ls -A "${WORK}/wal" 2>/dev/null)" ]]; then
    warn "時間點還原（PITR）需要停止資料庫並重放 WAL，是一個獨立的流程。"
    dim "本腳本已把 WAL 檔解壓到 ${WORK}/wal（$(find "${WORK}/wal" -type f | wc -l) 個檔案）。"
    dim "完整步驟見 docs/DISASTER-RECOVERY.md 的「指定時間點還原」一節。"
    dim "目標時間：${TARGET_TIME}"
    # 保留 WAL 供手動流程使用
    pitr_dir="${BACKUP_DIR}/pitr-$(date +%s)"
    mkdir -p "${pitr_dir}" && cp -r "${WORK}/wal" "${pitr_dir}/"
    info "WAL 已保留在 ${pitr_dir}"
  else
    err "這份備份不含 WAL 歸檔，無法做時間點還原。"
  fi
fi

# ── 物件儲存 ────────────────────────────────────────────────────
if (( ! SKIP_OBJECTS )) && (( ! IS_DRILL )) && [[ -d "${WORK}/objects" ]]; then
  info "還原物件儲存…"
  if tar -cf - -C "${WORK}/objects" . 2>/dev/null | s3_sh "
        rm -rf /tmp/restore && mkdir -p /tmp/restore && tar -xf - -C /tmp/restore
        mc alias set local http://localhost:9000 '${S3_ACCESS_KEY}' '${S3_SECRET_KEY}' >/dev/null 2>&1
        mc mirror --quiet --overwrite /tmp/restore local/${S3_BUCKET} >/dev/null 2>&1
        rm -rf /tmp/restore" 2>/dev/null; then
    ok "物件儲存已還原"
  else
    warn "物件儲存還原失敗。題目文字已還原，但圖片與題本原檔可能缺失。"
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
