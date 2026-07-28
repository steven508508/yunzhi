#!/usr/bin/env bash
# 備份排程常駐行程。
# 用簡單的睡眠迴圈而不是 cron：不需要多一個守護行程，
# 而且容器日誌就是備份日誌，維運人員少一個要找的地方。
set -euo pipefail

: "${BACKUP_SCHEDULE:=15 3 * * *}"
BACKUP_HOUR="$(echo "${BACKUP_SCHEDULE}" | awk '{print $2}')"
BACKUP_MIN="$(echo "${BACKUP_SCHEDULE}" | awk '{print $1}')"
[[ "${BACKUP_HOUR}" =~ ^[0-9]+$ ]] || BACKUP_HOUR=3
[[ "${BACKUP_MIN}"  =~ ^[0-9]+$ ]] || BACKUP_MIN=15

#: 上一次備份成功的時間戳檔。**這是「補跑」的依據。**
#: 沒有它的話，睡眠迴圈只會比對「現在是不是 03:15」——錯過就是
#: 錯過，沒有補跑。晚上關機的補習班（很常見）一份自動備份都不會
#: 有，而且完全靜默。systemd 版本用 Persistent=true 解決了同一件事。
STATE_FILE=/backups/.last-backup

log() { printf '%s [backup] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# ── 物件儲存 ─────────────────────────────────────────────────
#
# **沒有這一段的備份是不能用的備份。**
# 資料庫裡存的是物件鍵，題本原檔、頁面影像、題目附圖、掃描答卷
# 全部在 MinIO 裡。只備份資料庫的話，磁碟掛掉之後還原出來的是
# 一整套指向不存在檔案的死連結：題目文字在，圖沒了，原稿沒了，
# 而還原腳本找不到 objects/ 就直接跳過，不會有人發現。
dump_objects() {
  local dest="$1"
  if [[ -z "${S3_ENDPOINT:-}" || -z "${S3_ACCESS_KEY:-}" ]]; then
    log "未設定物件儲存，略過（還原時會缺少題本原檔與附圖）"
    return 1
  fi
  mc alias set yz "${S3_ENDPOINT}" "${S3_ACCESS_KEY}" "${S3_SECRET_KEY}" >/dev/null 2>&1 || {
    log "無法連上物件儲存 ${S3_ENDPOINT}"
    return 1
  }
  mkdir -p "${dest}"
  # --preserve 保留物件的中繼資料；沒有它，還原後的 content-type
  # 會全部變成 application/octet-stream，瀏覽器不再直接顯示圖片。
  if mc mirror --quiet --preserve "yz/${S3_BUCKET:-yunzhi}" "${dest}" >/dev/null 2>&1; then
    log "物件儲存已納入備份（$(du -sh "${dest}" | cut -f1)）"
    return 0
  fi
  log "物件儲存複製失敗"
  return 1
}

# ── WAL 歸檔 ─────────────────────────────────────────────────
#
# 歸檔目錄**必須有人清**。archive_timeout=900 保證每 15 分鐘至少
# 產生一個 16MB 段，加上 worker 的寫入，下限約 1.5GB/天且只增不減。
# 一個學期就把磁碟撐爆，而 Postgres 寫不進去 = 補習班停業。
#
# WAL_ARCHIVE_RETENTION_DAYS 原本在整個 repo 沒有任何一行程式讀取。
prune_wal() {
  local days="${WAL_ARCHIVE_RETENTION_DAYS:-14}"
  [[ -d /wal_archive ]] || return 0
  [[ "${days}" =~ ^[0-9]+$ ]] || days=14

  # 保留期不可以短於資料庫備份的保留期——WAL 是用來把某一份
  # 資料庫備份往前滾到某個時間點的，比備份還早被刪掉就沒有意義。
  local keep="${BACKUP_RETENTION_DAYS:-30}"
  [[ "${keep}" =~ ^[0-9]+$ ]] || keep=30
  (( days < 1 )) && days=1
  (( days > keep )) && days="${keep}"

  local before after
  before="$(du -sm /wal_archive 2>/dev/null | cut -f1 || echo 0)"
  find /wal_archive -type f -mtime "+${days}" -delete 2>/dev/null || true
  after="$(du -sm /wal_archive 2>/dev/null | cut -f1 || echo 0)"
  (( before > after )) && log "WAL 歸檔已清理 $((before - after)) MB（保留 ${days} 天）"
  return 0
}

do_backup() {
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local out="/backups/yunzhi-${stamp}.tar.gz"
  local work; work="$(mktemp -d)"
  trap 'rm -rf "${work}"' RETURN

  log "開始備份"
  if ! pg_dump --format=custom --compress=6 --no-owner --no-privileges > "${work}/database.dump"; then
    log "pg_dump 失敗"; return 1
  fi

  # WAL 歸檔以唯讀掛載進來。**只收最近的**：整個目錄複製進每一份
  # 每日 tarball（保留 30 天）等於把同一批 WAL 存三十遍。
  if [[ -d /wal_archive ]]; then
    mkdir -p "${work}/wal"
    find /wal_archive -maxdepth 1 -type f -mtime -2 \
      -exec cp {} "${work}/wal/" \; 2>/dev/null || true
  fi

  local has_objects=false
  if dump_objects "${work}/objects"; then has_objects=true; fi

  # 字形對照快取。重裝之後歸零的話，每一家出版社的自製符號字型
  # 都要重新付費問一次視覺模型——那正是這個快取存在的理由。
  if [[ -d /models ]]; then
    mkdir -p "${work}/models"
    cp -r /models/. "${work}/models/" 2>/dev/null || true
  fi

  cat > "${work}/manifest.json" <<JSON
{"name":"yunzhi-${stamp}","createdAt":"$(date -Iseconds)","appVersion":"${APP_VERSION:-unknown}",
 "source":"scheduled","includesObjects":${has_objects},"encrypted":${BACKUP_ENCRYPTION_ENABLED:-true}}
JSON

  tar -czf "${out}" -C "${work}" .

  if [[ "${BACKUP_ENCRYPTION_ENABLED:-true}" == "true" && -n "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -in "${out}" -out "${out}.enc" -pass "pass:${BACKUP_ENCRYPTION_KEY}"
    rm -f "${out}"; out="${out}.enc"
  fi

  chmod 600 "${out}"
  sha256sum "${out}" > "${out}.sha256"
  log "完成：$(basename "${out}") ($(du -h "${out}" | cut -f1))$(
       [[ "${has_objects}" == true ]] || printf '　※ 不含物件儲存')"

  date +%s > "${STATE_FILE}"

  # 異地副本。**與資料庫同一顆磁碟上的備份，在磁碟故障時會一起
  # 陪葬。** 沒設定就明講，不要讓人以為有。
  if [[ -n "${BACKUP_REMOTE_ENDPOINT:-}" && -n "${BACKUP_REMOTE_ACCESS_KEY:-}" ]]; then
    if mc alias set yzoff "${BACKUP_REMOTE_ENDPOINT}" \
         "${BACKUP_REMOTE_ACCESS_KEY}" "${BACKUP_REMOTE_SECRET_KEY}" >/dev/null 2>&1 \
       && mc cp --quiet "${out}" "yzoff/${BACKUP_REMOTE_BUCKET:-yunzhi-backup}/" >/dev/null 2>&1; then
      log "已複製到異地：${BACKUP_REMOTE_ENDPOINT}"
    else
      log "異地複製失敗——這份備份只存在本機磁碟上"
    fi
  fi

  # 清理過期，但保留帶事件標籤的備份
  find /backups -maxdepth 1 -name 'yunzhi-*.tar.gz*' ! -name '*.sha256' \
       ! -name '*pre-upgrade*' ! -name '*pre-uninstall*' ! -name '*pre-restore*' \
       -type f -mtime "+${BACKUP_RETENTION_DAYS:-30}" -delete 2>/dev/null || true

  prune_wal
}

#: 超過這麼久沒有成功備份就補跑一次。設成一天多一點，
#: 讓「昨天關機、今天開機」一定補得到。
STALE_SECONDS=$(( 26 * 3600 ))

overdue() {
  [[ -f "${STATE_FILE}" ]] || return 0
  local last; last="$(cat "${STATE_FILE}" 2>/dev/null || echo 0)"
  [[ "${last}" =~ ^[0-9]+$ ]] || return 0
  (( $(date +%s) - last > STALE_SECONDS ))
}

log "備份排程啟動：每日 $(printf '%02d:%02d' "${BACKUP_HOUR}" "${BACKUP_MIN}")"
# 寫**時間戳**而不是 touch 一個空檔。healthcheck 算的是
# `$(date +%s) - $(cat /tmp/backup-daemon-alive)`，空檔會讓它變成
# `$(( 1785... -  ))`——那是算術語法錯誤，不是「不新鮮」。
# 全新安裝時第一件事就是補跑一次備份（下面的 overdue），那段時間
# 可能好幾分鐘，容器會被標成 unhealthy，而裝機的人看到的是
# 「backup 服務有問題」——實際上它正在正常工作。
date +%s > /tmp/backup-daemon-alive

# 開機時先確認有沒有漏掉的。關機一晚就少一份備份是不能接受的，
# 而 RPO 15 分鐘的承諾建立在「每天真的有備份」之上。
if overdue; then
  log "距離上次成功備份已超過 $((STALE_SECONDS / 3600)) 小時，立即補跑"
  do_backup || log "補跑失敗"
fi

while true; do
  now_h=$(date +%-H); now_m=$(date +%-M)
  if (( now_h == BACKUP_HOUR && now_m == BACKUP_MIN )) || overdue; then
    do_backup || log "備份失敗，稍後再試"
    sleep 61
  fi
  # 存活檔要寫**內容**而不是只 touch：healthcheck 檢查的是新鮮度，
  # 而不是「這個檔存不存在」——存在性檢查在行程卡死時永遠是綠的。
  date +%s > /tmp/backup-daemon-alive
  sleep 30
done
