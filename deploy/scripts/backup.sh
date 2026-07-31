#!/usr/bin/env bash
# 雲端智學 — 備份
#
# 一份備份包含五樣東西，缺任何一樣還原後都是壞的：
#   1. PostgreSQL 全庫 dump（成績、題庫、作答）— 日常還原用這一份
#   2. 實體基礎備份 base.tar.gz（pg_basebackup）— 時間點還原用這一份
#   3. WAL 歸檔（把第 2 項往前滾到指定的那一分鐘）
#   4. MinIO 物件（題本原檔、圖片、掃描答卷）
#   5. .env 的**結構**（欄位名稱，不含值）與版本資訊
#
# **第 1 項與第 2 項不能互相取代，這是這支腳本最容易被誤解的地方。**
# WAL 只能重放在實體基礎備份（第 2 項）上，重放不到 pg_restore 還原
# 出來的邏輯資料庫上。所以：
#   · 只有第 1 項 → 只能還原到「上一次備份的那一刻」，中間全掉
#   · 有第 2、3 項 → 才有「回到今天下午三點整」這件事
# 這份腳本原本只有第 1 項，而文件寫著 RPO 15 分鐘。
#
# 第 5 項容易被忽略但很重要：還原到一台新機器時，如果不知道
# 原本的版本與設定欄位，會用新版程式去讀舊版 schema。
#
# 備份檔本身加密（BACKUP_ENCRYPTION_KEY），因為它含全體學生
# 個資，而備份通常會被複製到隨身碟或 NAS 這些管控較鬆的地方。
#
# 用法：
#   ./deploy/scripts/backup.sh
#   ./deploy/scripts/backup.sh --tag pre-upgrade
#   ./deploy/scripts/backup.sh --no-objects      # 只備資料庫（快）

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

TAG=""
QUIET=0
INCLUDE_OBJECTS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --quiet|-q) QUIET=1; shift ;;
    --no-objects) INCLUDE_OBJECTS=0; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

(( QUIET )) && { info() { :; }; ok() { :; }; section() { :; }; dim() { :; }; }

acquire_lock "backup"
load_env
require_env POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD

BACKUP_DIR="${BACKUP_DIR:-${YZ_ROOT}/data/backups}"
mkdir -p "${BACKUP_DIR}"

STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="yunzhi-${STAMP}${TAG:+-${TAG}}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/yunzhi-backup-XXXXXX")"
# 失敗時不要留下半成品 —— 半成品在還原時看起來像是有效備份。
trap 'rm -rf "${WORK}"' EXIT

section "備份 ${NAME}"

started="$(date +%s)"

# ── 空間檢查 ────────────────────────────────────────────────────
# 備份寫到一半磁碟滿了，會同時毀掉這次備份與資料庫的寫入能力。
db_size_bytes="$(pg_scalar "SELECT pg_database_size('${POSTGRES_DB}')")"
db_size_bytes="${db_size_bytes:-0}"
# dump 加壓縮的暫存抓兩倍，實體基礎備份再算一份（它是整個資料目錄的
# 壓縮副本，通常比 dump 大），最後加 2GB 的餘裕。
need_gb=$(( (db_size_bytes / 1073741824) * 3 + 2 ))
free_gb="$(disk_free_gb "${BACKUP_DIR}")"
if (( ${free_gb:-0} < need_gb )); then
  die "備份目錄剩餘 ${free_gb}GB，估計需要 ${need_gb}GB。請先清理或調低 BACKUP_RETENTION_DAYS。"
fi
info "資料庫大小 $(human_size "${db_size_bytes}")，可用空間 ${free_gb}GB"

# ── 1. 資料庫 ───────────────────────────────────────────────────
info "匯出資料庫…"
# custom 格式（-Fc）而非純 SQL：支援平行還原、選擇性還原單一表格，
# 而且體積小得多。代價是必須用 pg_restore 而不能直接 psql。
if ! pg_exec pg_dump \
      -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
      --format=custom --compress=6 --no-owner --no-privileges \
      > "${WORK}/database.dump" 2>"${WORK}/pg_dump.err"; then
  err "pg_dump 失敗："
  cat "${WORK}/pg_dump.err" >&2
  die "備份中止。"
fi
dump_size="$(stat -c %s "${WORK}/database.dump")"
(( dump_size < 1024 )) && die "資料庫 dump 只有 ${dump_size} 位元組，明顯不對。備份中止。"
ok "資料庫 $(human_size "${dump_size}")"

# ── 2. 實體基礎備份 ─────────────────────────────────────────────
#
# **這一份才是時間點還原的起點。** 上面那份 dump 是邏輯備份，
# 它記的是「有哪些資料」；WAL 記的是「資料庫檔案的哪個位元組被改了」，
# 兩者不在同一個層次上，所以 WAL 重放不到 dump 還原出來的資料庫上。
# 沒有這一段的話，「回到今天下午三點」這件事在技術上不存在，
# 不管收集了多少 WAL。
#
# 失敗不中止整份備份：dump 是日常還原的主力，為了拿不到基礎備份
# 而讓當晚連 dump 都沒有，是把小損失換成大損失。但 manifest 會記下
# 這件事，還原端與 verify-restore.sh 會據此說出「這份不能做 PITR」。
BASE_OK=false
BASE_SIZE=0
if [[ "${BACKUP_BASE_BACKUP:-true}" == "true" ]]; then
  info "取得實體基礎備份…"
  # 三個參數都不是可有可無的：
  #   -D -      整份寫到 stdout。不必在資料庫容器裡找一個寫得下
  #             整個資料目錄的暫存位置（那個位置多半就是快滿的那顆磁碟）。
  #   -Xfetch   把復原所需的 WAL 段一起收進同一份 tar。少了它，這份
  #             基礎備份自己起不來——而錯誤要到真的要用的那天才出現。
  #             （-Xstream 需要另外開一條連線寫第二個檔，和 -D - 不相容。）
  #   --checkpoint=fast
  #             不等下一次自然檢查點。省下來的是「備份卡在那裡不動」
  #             的十幾分鐘，代價是那一刻多一些磁碟 I/O；凌晨三點值得換。
  # 不指定 -h：docker 模式在容器裡走 unix socket（pg_hba 的 local
  # replication trust），原生模式由 pg_exec 帶 PGHOST/PGPASSWORD 走
  # 127.0.0.1（Debian 預設的 host replication 規則）。兩邊都通。
  if pg_exec pg_basebackup -U "${POSTGRES_USER}" \
        -D - --format=tar --gzip --wal-method=fetch --checkpoint=fast \
        > "${WORK}/base.tar.gz" 2>"${WORK}/basebackup.err"; then
    BASE_SIZE="$(stat -c %s "${WORK}/base.tar.gz" 2>/dev/null || echo 0)"
    if (( BASE_SIZE > 1024 )); then
      BASE_OK=true
      ok "基礎備份 $(human_size "${BASE_SIZE}")"
    else
      err "基礎備份只有 ${BASE_SIZE} 位元組，不是有效的備份。"
      rm -f "${WORK}/base.tar.gz"
      BASE_SIZE=0
    fi
  fi
  if [[ "${BASE_OK}" != true ]]; then
    err "實體基礎備份失敗——**這份備份不能做時間點還原**。"
    dim "後果：誤刪資料時只能還原到備份當下，中間的作答與成績回不來。"
    sed -n '1,3p' "${WORK}/basebackup.err" 2>/dev/null | while IFS= read -r l; do dim "  ${l}"; done
    dim "最常見的原因是 pg_hba.conf 少了 replication 規則："
    dim "  deploy/postgres/pg_hba.conf 有沒有掛進容器（docker compose config | grep pg_hba）"
    dim "改好之後：docker compose restart postgres，再重跑一次備份。"
  fi
else
  warn "BACKUP_BASE_BACKUP=false：這份備份不含實體基礎備份，無法做時間點還原。"
fi

# ── 3. WAL 歸檔 ─────────────────────────────────────────────────
if [[ "${WAL_ARCHIVE_ENABLED:-true}" == "true" ]]; then
  info "收集 WAL 歸檔…"
  # 先切換一次 WAL，把當前還沒歸檔的交易也納入 ——
  # 少了這一步，RPO 就等於「上一次自動切換到現在」的時間。
  pg_exec psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    -c "SELECT pg_switch_wal();" >/dev/null 2>&1 || warn "WAL 切換失敗，時間點還原的精度會降低。"
  sleep 2
  mkdir -p "${WORK}/wal"
  pg_sh "tar -cf - -C '$(wal_archive_dir)' . 2>/dev/null" \
    | tar -xf - -C "${WORK}/wal" 2>/dev/null || warn "WAL 歸檔收集失敗。"
  wal_count="$(find "${WORK}/wal" -type f 2>/dev/null | wc -l)"
  ok "WAL 檔案 ${wal_count} 個"
else
  warn "WAL 歸檔未啟用，這份備份只能還原到備份當下，無法指定時間點。"
fi

# ── 4. 物件儲存 ─────────────────────────────────────────────────
#
# 失敗的後果值得寫清楚：資料庫還原之後題目文字全都在，但每一道
# 「如右圖」的題目變成一片空白，每一份題本原檔消失。而完成訊息會說
# 「資料表 68 張、使用者 213 位」，看起來完全正常。
#
# 所以這裡要做兩件事：**在檔案上留下痕跡**（manifest 的
# includesObjects 與 objectCount，讓還原端問得出來），
# 以及**在畫面上講出後果**（不是一句「匯出失敗」）。
OBJECTS_OK=false
OBJ_COUNT=0
if (( INCLUDE_OBJECTS )); then
  info "匯出物件儲存…"
  mkdir -p "${WORK}/objects"
  if s3_sh "
        mc alias set local http://localhost:9000 '${S3_ACCESS_KEY}' '${S3_SECRET_KEY}' >/dev/null 2>&1
        mc mirror --quiet local/${S3_BUCKET} /tmp/mirror >/dev/null 2>&1
        tar -cf - -C /tmp/mirror . ; rm -rf /tmp/mirror" 2>/dev/null \
      | tar -xf - -C "${WORK}/objects" 2>/dev/null; then
    OBJ_COUNT="$(find "${WORK}/objects" -type f 2>/dev/null | wc -l)"
    OBJECTS_OK=true
    ok "物件 ${OBJ_COUNT} 個"
  else
    err "物件儲存匯出失敗。"
    err "這份備份**只有資料庫**：題目文字在，題本原檔與題目附圖不在。"
    dim "用它還原出來的系統，每一道帶圖的題目是空白的，而畫面上不會報錯。"
    dim "常見原因：MinIO 沒起來（docker compose ps minio）、S3_SECRET_KEY 不對。"
    dim "manifest 已記下 includesObjects: false，還原時 restore.sh 會擋一次。"
  fi
else
  info "已指定 --no-objects，略過物件儲存。"
fi

# ── 5. 中繼資料 ─────────────────────────────────────────────────
app_version="${APP_VERSION:-$(cat "${YZ_ROOT}/VERSION" 2>/dev/null || echo unknown)}"
schema_hash="$(pg_scalar "SELECT md5(string_agg(table_name || column_name || data_type, ',' ORDER BY table_name, column_name)) FROM information_schema.columns WHERE table_schema='public'")"
schema_hash="${schema_hash:-unknown}"

cat > "${WORK}/manifest.json" <<EOF
{
  "name": "${NAME}",
  "createdAt": "$(date -Iseconds)",
  "tag": "${TAG}",
  "appVersion": "${app_version}",
  "schemaHash": "${schema_hash}",
  "postgres": { "database": "${POSTGRES_DB}", "sizeBytes": ${db_size_bytes}, "dumpFormat": "custom" },
  "walArchive": ${WAL_ARCHIVE_ENABLED:-true},
  "includesBaseBackup": ${BASE_OK},
  "baseBackupSizeBytes": ${BASE_SIZE},
  "includesObjects": ${OBJECTS_OK},
  "objectCount": ${OBJ_COUNT},
  "encrypted": ${BACKUP_ENCRYPTION_ENABLED:-true},
  "envKeys": [$(grep -oE '^[A-Z_]+=' "${YZ_ROOT}/.env" 2>/dev/null | tr -d '=' | sed 's/.*/"&"/' | paste -sd, - || echo '')]
}
EOF
ok "中繼資料"

# ── 打包 ────────────────────────────────────────────────────────
info "打包…"
ARCHIVE="${BACKUP_DIR}/${NAME}.tar.gz"
tar -czf "${ARCHIVE}" -C "${WORK}" .

# ── 加密 ────────────────────────────────────────────────────────
if [[ "${BACKUP_ENCRYPTION_ENABLED:-true}" == "true" ]]; then
  [[ -n "${BACKUP_ENCRYPTION_KEY:-}" ]] || die "啟用了備份加密但 BACKUP_ENCRYPTION_KEY 是空的。"
  info "加密…"
  # -pbkdf2 與 -iter 是必要的。沒有它們，openssl 用的是 1990 年代
  # 的單輪 MD5 金鑰衍生，等於加密強度大打折扣。
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "${ARCHIVE}" -out "${ARCHIVE}.enc" -pass "pass:${BACKUP_ENCRYPTION_KEY}"
  shred -u "${ARCHIVE}" 2>/dev/null || rm -f "${ARCHIVE}"
  ARCHIVE="${ARCHIVE}.enc"
  ok "已加密"
fi

chmod 600 "${ARCHIVE}"

# ── 校驗碼 ──────────────────────────────────────────────────────
# 靜默的位元腐蝕在長期保存的備份上是真實存在的。
sha256sum "${ARCHIVE}" > "${ARCHIVE}.sha256"

# ── 異地複製 ────────────────────────────────────────────────────
if [[ -n "${BACKUP_REMOTE_ENDPOINT:-}" ]] && [[ -n "${BACKUP_REMOTE_BUCKET:-}" ]]; then
  info "複製到異地…"
  if command -v mc >/dev/null 2>&1; then
    mc alias set yzremote "${BACKUP_REMOTE_ENDPOINT}" "${BACKUP_REMOTE_ACCESS_KEY}" "${BACKUP_REMOTE_SECRET_KEY}" >/dev/null 2>&1
    # shellcheck disable=SC2015  # ok() 是 printf 包裝、必定回 0，warn 不會被誤觸發
    mc cp --quiet "${ARCHIVE}" "yzremote/${BACKUP_REMOTE_BUCKET}/" \
      && mc cp --quiet "${ARCHIVE}.sha256" "yzremote/${BACKUP_REMOTE_BUCKET}/" \
      && ok "異地複製完成" || warn "異地複製失敗，本機備份仍然有效。"
  else
    warn "未安裝 mc（MinIO client），略過異地複製。"
  fi
fi

# ── 清理過期 ────────────────────────────────────────────────────
retention="${BACKUP_RETENTION_DAYS:-30}"
info "清理 ${retention} 天前的備份…"
removed=0
while IFS= read -r -d '' old; do
  # 帶 tag 的備份（pre-upgrade、pre-uninstall）不自動刪除，
  # 它們對應的是特定事件，事後追查時價值最高。
  [[ "${old}" =~ -(pre-upgrade|pre-uninstall|pre-migrate|manual) ]] && continue
  rm -f "${old}" "${old}.sha256"
  removed=$((removed + 1))
done < <(find "${BACKUP_DIR}" -maxdepth 1 -name 'yunzhi-*.tar.gz*' ! -name '*.sha256' \
         -type f -mtime "+${retention}" -print0 2>/dev/null)
(( removed > 0 )) && ok "清理 ${removed} 份過期備份"

elapsed=$(( $(date +%s) - started ))
final_size="$(stat -c %s "${ARCHIVE}")"

section "完成"
ok "$(basename "${ARCHIVE}")"
dim "位置：${ARCHIVE}"
dim "大小：$(human_size "${final_size}")"
dim "耗時：${elapsed} 秒"
if [[ "${BASE_OK}" == true ]]; then
  dim "基礎備份：$(human_size "${BASE_SIZE}")（時間點還原用）"
else
  # 「備份完成」不可以在沒有基礎備份的情況下單獨出現：少了它，
  # 這份備份能給的只有「還原到備份當下」，而文件承諾的是 15 分鐘。
  err "基礎備份：**沒有**。這份備份無法做時間點還原。"
fi
if [[ "${OBJECTS_OK}" == true ]]; then
  dim "物件：${OBJ_COUNT} 個（題本原檔與題目附圖）"
else
  # 完成訊息不可以看起來一切正常。這一份備份還原出來會缺圖，
  # 而那是還原完成之後才會被學生發現的事。
  err "物件：**沒有**。這份備份只含資料庫。"
fi

if (( ! QUIET )); then
  echo
  warn "備份完成不等於備份可用。"
  dim "定期執行還原演練：./deploy/scripts/verify-restore.sh"
  dim "未經還原驗證的備份，在真的需要它的那一天可能是壞的。"
  if [[ "${OBJECTS_OK}" != true ]] && (( INCLUDE_OBJECTS )); then
    echo
    err "這一份不要當成完整備份。"
    dim "排除 MinIO 的問題之後重跑一次：./deploy/scripts/backup.sh"
  fi
fi

# 給呼叫端（upgrade.sh、uninstall.sh）用
echo "${ARCHIVE}"
