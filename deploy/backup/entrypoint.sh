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

#: 最後一次失敗的原因。**這是「三個指示燈全綠」的解藥。**
#:
#: 原本備份失敗只寫一行容器日誌，而沒有人會去看容器日誌。三層
#: 指示燈同時是綠的：healthcheck 只看心跳（迴圈裡無條件寫）、
#: doctor.sh 的服務清單沒有 backup、backup.age 要超過 48 小時才紅。
#: 於是「天天失敗的備份」的正常狀態是——全綠。
#:
#: 它負責的是**原因**，不是「有沒有事」：doctor.sh 讀它（這個目錄
#: 就是宿主機的 ${BACKUP_DIR}）才說得出「上一次備份為什麼失敗」。
#: 「有沒有事」由 healthy() 依「多久沒有成功過」判定——因為備份失敗
#: 最常見的原因就是這顆磁碟出問題，而那時這個檔可能根本寫不進去。
#: 成功一次就刪掉。
FAILURE_FILE=/backups/.last-failure

log() { printf '%s [backup] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

#: 記下失敗，順便把原因留給宿主機上的 doctor.sh。
record_failure() {
  local reason="$1"
  log "備份失敗：${reason}"
  printf '%s|%s\n' "$(date -Iseconds)" "${reason}" > "${FAILURE_FILE}" 2>/dev/null || true
}

clear_failure() { rm -f "${FAILURE_FILE}" 2>/dev/null || true; }

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

# ── 磁碟 ─────────────────────────────────────────────────────
#
# 磁碟寫滿是這個容器唯一會遇到、而且會**自己把情況推得更糟**的
# 故障：滿了 → pg_dump 失敗 → 迴圈每 90 秒重試一次 → 每一次都在
# 一台滿了的機器上寫暫存檔。同一時間 Postgres 寫不進 WAL，
# 考試中的每一次存檔都失敗，而前端沒有本機暫存。
#
# 所以「快滿了」要在還來得及的時候講出來，而且要講在容器日誌的
# 最上層，不是埋在 pg_dump 的錯誤訊息裡。
disk_used_pct() {
  df -P "$1" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}'
}

warn_if_tight() {
  local path="$1" label="$2" used
  [[ -d "${path}" ]] || return 0
  used="$(disk_used_pct "${path}")"
  [[ "${used}" =~ ^[0-9]+$ ]] || return 0
  if (( used >= 90 )); then
    log "【磁碟】${label} 已用 ${used}%。備份與 Postgres 的 WAL 都寫在這裡——"
    log "【磁碟】寫滿的下一步是考試中斷。立刻處理：調低 BACKUP_RETENTION_DAYS"
    log "【磁碟】與 WAL_ARCHIVE_RETENTION_DAYS，或刪掉最舊的幾份備份。"
    return 1
  elif (( used >= 80 )); then
    log "【磁碟】${label} 已用 ${used}%，剩餘空間開始吃緊。"
  fi
  return 0
}

# 暫存目錄的清理**不用 `trap ... RETURN`**。
#
# bash 的 RETURN trap 不是函式範圍的：在 do_backup 裡設一次，
# 它會一直留著，於是**下一個返回的函式**（backup_cycle 的 return）
# 也會觸發它，而那時 work 這個 local 已經不在了——配上 set -u
# 就是 `work: unbound variable`，備份迴圈當場整個死掉。
# 出口只有兩個，寫明白比留一個全域陷阱安全。
do_backup() {
  local work rc=0
  work="$(mktemp -d)"
  _do_backup "${work}" || rc=1
  rm -rf "${work}"
  return "${rc}"
}

_do_backup() {
  local work="$1"
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local out="/backups/yunzhi-${stamp}.tar.gz"

  log "開始備份"
  if ! pg_dump --format=custom --compress=6 --no-owner --no-privileges > "${work}/database.dump"; then
    record_failure "pg_dump 失敗（多半是磁碟空間或資料庫連線）"
    return 1
  fi

  # ── 實體基礎備份 ───────────────────────────────────────────────
  #
  # **這裡是「RPO 15 分鐘」真正兌現的地方。** 誤刪成績那天，手邊有的
  # 是這個容器每晚產出的 tarball，不是誰在某個時候手動跑的那一份。
  # 上面的 pg_dump 是邏輯備份，WAL 重放不到它上面；要回到「今天下午
  # 三點」，唯一的起點是 pg_basebackup 產出的實體副本。
  #
  # 這一段原本不存在，而 archive_timeout=900 收集了半年的 WAL——
  # 全部沒有東西可以重放上去。
  local has_base=false base_bytes=0
  if [[ "${BACKUP_BASE_BACKUP:-true}" == "true" ]]; then
    # -Xfetch：把復原需要的 WAL 段收進同一份 tar，讓這份基礎備份
    # 自己就能起得來。--checkpoint=fast：不等下一次自然檢查點，
    # 否則備份可能卡住十幾分鐘不動。
    if pg_basebackup -D - --format=tar --gzip --wal-method=fetch \
         --checkpoint=fast > "${work}/base.tar.gz" 2>"${work}/base.err"; then
      base_bytes="$(stat -c %s "${work}/base.tar.gz" 2>/dev/null || echo 0)"
      [[ "${base_bytes}" =~ ^[0-9]+$ ]] || base_bytes=0
      if (( base_bytes > 1024 )); then
        has_base=true
      else
        base_bytes=0
        rm -f "${work}/base.tar.gz"
      fi
    fi
    if [[ "${has_base}" != true ]]; then
      # 不 return 1：dump 已經好了，為了基礎備份失敗而整晚沒有備份
      # 是把小損失換成大損失。但要說出後果，而且要說得出下一步——
      # 最常見的原因是 pg_hba.conf 沒有 replication 規則。
      log "【注意】實體基礎備份失敗，這份備份無法做時間點還原。"
      log "【注意】$(head -1 "${work}/base.err" 2>/dev/null)"
      log "【注意】若訊息是 no pg_hba.conf entry for replication connection，"
      log "【注意】表示 deploy/postgres/pg_hba.conf 沒有生效：確認它有掛進"
      log "【注意】postgres 容器，然後 docker compose restart postgres。"
    fi
    rm -f "${work}/base.err"
  fi

  # WAL 歸檔以唯讀掛載進來。**只收最近的**：整個目錄複製進每一份
  # 每日 tarball（保留 30 天）等於把同一批 WAL 存三十遍。
  if [[ -d /wal_archive ]]; then
    mkdir -p "${work}/wal"
    find /wal_archive -maxdepth 1 -type f -mtime -2 \
      -exec cp {} "${work}/wal/" \; 2>/dev/null || true
  fi

  local has_objects=false object_count=0
  if dump_objects "${work}/objects"; then
    has_objects=true
    object_count="$(find "${work}/objects" -type f 2>/dev/null | wc -l)"
  fi

  # 字形對照快取。重裝之後歸零的話，每一家出版社的自製符號字型
  # 都要重新付費問一次視覺模型——那正是這個快取存在的理由。
  if [[ -d /models ]]; then
    mkdir -p "${work}/models"
    cp -r /models/. "${work}/models/" 2>/dev/null || true
  fi

  # schemaHash：**日常還原用的正是這一批備份**，而它原本沒有這個欄位。
  # restore.sh 讀不到時 b_hash 是 unknown，於是「備份的結構與目前不同」
  # 那道相容性確認整段被跳過——手動 backup.sh 產的備份有保護，
  # 每天自動產的那些沒有。
  local schema_hash
  schema_hash="$(psql -tAc "SELECT md5(string_agg(table_name || column_name || data_type, ',' ORDER BY table_name, column_name)) FROM information_schema.columns WHERE table_schema='public'" 2>/dev/null | tr -d '\r' | head -1)"
  [[ -n "${schema_hash}" ]] || schema_hash="unknown"

  # objectCount 讓還原端問得出「這份備份該有幾個物件」。沒有它，
  # 「objects/ 目錄不在」與「這份備份本來就沒有物件」長得一模一樣，
  # 而 restore.sh 對兩者都只能靜靜跳過。
  # includesBaseBackup 與 objectCount 是同一個道理：讓還原端**問得出來**
  # 這份備份少了什麼。沒有這個欄位的話，「base.tar.gz 不在」與「這份備份
  # 本來就不做基礎備份」長得一模一樣，而兩者要跟使用者說的話完全不同。
  cat > "${work}/manifest.json" <<JSON
{"name":"yunzhi-${stamp}","createdAt":"$(date -Iseconds)","appVersion":"${APP_VERSION:-unknown}",
 "source":"scheduled","schemaHash":"${schema_hash}",
 "includesBaseBackup":${has_base},"baseBackupSizeBytes":${base_bytes},
 "includesObjects":${has_objects},"objectCount":${object_count},
 "encrypted":${BACKUP_ENCRYPTION_ENABLED:-true}}
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
  if [[ "${has_objects}" != true ]]; then
    # 這一份還原出來的樣子是：題目文字都在，每一道「如右圖」的題目
    # 變成一片空白，題本原檔全部消失。而完成訊息看起來完全正常，
    # 所以這一句必須自己說出後果。
    log "【注意】這份備份不含物件儲存。用它還原會缺少題本原檔與題目附圖。"
  fi
  if [[ "${has_base}" != true ]]; then
    log "【注意】這份備份不含實體基礎備份，只能還原到備份當下（無法指定時間點）。"
  fi

  date +%s > "${STATE_FILE}"
  clear_failure

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
}

#: 一輪備份週期。**WAL 清理與備份成敗解耦，就是在這裡做的。**
#:
#: prune_wal 原本是 do_backup 的最後一行，而 pg_dump 失敗時
#: do_backup 在第一步就 return 1 —— 於是「備份失敗」等於
#: 「WAL 永遠不清」，而備份失敗最常見的原因正是磁碟滿。
#: 磁碟滿 → 備份失敗 → WAL 不清 → 磁碟更滿，一條會自己收緊的迴圈。
#:
#: 現在 prune_wal 在 pg_dump **之前**就先跑：那是這個容器唯一能
#: 主動騰出空間的動作，而磁碟吃緊時它比備份本身更急。備份結束後
#: 再跑一次，把這次 pg_switch_wal 之後歸檔的舊段一併收掉。
backup_cycle() {
  warn_if_tight /backups "備份目錄 /backups" || true
  warn_if_tight /wal_archive "WAL 歸檔 /wal_archive" || true

  prune_wal

  local rc=0
  do_backup || rc=1

  prune_wal
  return "${rc}"
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

#: healthcheck 要回答的問題是「備份這件事現在正常嗎」，
#: 不是「這個行程還在嗎」。
#:
#: docker-compose.yml 的 healthcheck 看的是 /tmp/backup-daemon-alive
#: 的新鮮度，而心跳原本在迴圈裡**無條件**寫——所以一個天天失敗的
#: 備份容器，狀態永遠是綠的。現在心跳只在 healthy() 為真時才寫，
#: 於是「連續失敗到超過保鮮期」會讓心跳停止更新，300 秒後容器轉成
#: unhealthy，doctor.sh 的服務檢查也就看得到它。
#:
#: 判斷刻意留有餘裕：跑過一輪、而上一份成功的備份還在 26 小時內，
#: 就算健康（中間失敗一次不要緊，下一輪會重試，RPO 也還守得住）。
#:
#: **依據是「有沒有成功過」而不是「有沒有失敗紀錄」。** 失敗紀錄寫在
#: /backups，而備份失敗最常見的原因就是那顆磁碟出問題——寫不進去的話
#: 標記不會存在，健康狀態就永遠是綠的。恰好在最需要它變紅的時候失效。
#: 失敗紀錄留給 doctor.sh 當「原因」用，不當「有沒有事」的依據。
#:
#: ATTEMPTED 讓全新安裝在跑完第一輪之前保持綠燈：那段補跑可能好幾分鐘，
#: 把它標成 unhealthy 只會讓裝機的人以為壞了。
ATTEMPTED=0
healthy() {
  (( ATTEMPTED )) || return 0
  overdue || return 0
  return 1
}

log "備份排程啟動：每日 $(printf '%02d:%02d' "${BACKUP_HOUR}" "${BACKUP_MIN}")"
# 寫**時間戳**而不是 touch 一個空檔。healthcheck 算的是
# `$(date +%s) - $(cat /tmp/backup-daemon-alive)`，空檔會讓它變成
# `$(( 1785... -  ))`——那是算術語法錯誤，不是「不新鮮」。
# 全新安裝時第一件事就是補跑一次備份（下面的 overdue），那段時間
# 可能好幾分鐘，容器會被標成 unhealthy，而裝機的人看到的是
# 「backup 服務有問題」——實際上它正在正常工作。
date +%s > /tmp/backup-daemon-alive

# 起來的第一件事就是清 WAL，不等第一份備份。
# 容器如果是在「磁碟已經滿了」的狀態下被重啟的（很常見：滿了 →
# 有人重啟服務 → 備份容器又起來），這一步是唯一能立刻騰出空間的
# 動作，而備份本身在空間不足時根本跑不完。
prune_wal

# 開機時先確認有沒有漏掉的。關機一晚就少一份備份是不能接受的，
# 而 RPO 15 分鐘的承諾建立在「每天真的有備份」之上。
if overdue; then
  log "距離上次成功備份已超過 $((STALE_SECONDS / 3600)) 小時，立即補跑"
  backup_cycle || true
  ATTEMPTED=1
fi

#: 連續失敗時的退避。
#:
#: 原本失敗之後照樣每約 90 秒重試一次，而失敗最常見的原因是磁碟滿——
#: 於是每 90 秒就在一台已經滿了的機器上再寫一次 pg_dump 的暫存檔，
#: 把情況推得更深。退避讓它從 5 分鐘一路退到一小時一次：
#: 該修的還是要人去修，但機器不會在等人的期間繼續自傷。
FAIL_STREAK=0
RETRY_AFTER=0          # 下一次可以重試的時間戳（0 = 隨時）
MAX_BACKOFF=$(( 3600 ))

while true; do
  now=$(date +%s)
  now_h=$(date +%-H); now_m=$(date +%-M)

  # 排程時間到了就一定跑（不受退避影響——每天那一次是承諾）；
  # 補跑則要等退避結束。
  scheduled=0
  (( now_h == BACKUP_HOUR && now_m == BACKUP_MIN )) && scheduled=1

  if (( scheduled )) || { overdue && (( now >= RETRY_AFTER )); }; then
    ATTEMPTED=1
    if backup_cycle; then
      FAIL_STREAK=0
      RETRY_AFTER=0
    else
      FAIL_STREAK=$(( FAIL_STREAK + 1 ))
      backoff=$(( 300 * (1 << (FAIL_STREAK > 4 ? 4 : FAIL_STREAK - 1)) ))
      (( backoff > MAX_BACKOFF )) && backoff="${MAX_BACKOFF}"
      RETRY_AFTER=$(( $(date +%s) + backoff ))
      log "第 ${FAIL_STREAK} 次連續失敗，$(( backoff / 60 )) 分鐘後再試"
      if ! healthy; then
        log "【健康狀態】備份已經超過 $((STALE_SECONDS / 3600)) 小時沒有成功，"
        log "【健康狀態】這個容器會被標成 unhealthy。原因見上方，或跑"
        log "【健康狀態】./deploy/scripts/doctor.sh（宿主機）。"
      fi
    fi
    sleep 61
  fi

  # 存活檔要寫**內容**而不是只 touch：healthcheck 檢查的是新鮮度，
  # 而不是「這個檔存不存在」——存在性檢查在行程卡死時永遠是綠的。
  #
  # 而且**只在備份本身健康時才寫**。心跳無條件寫的話，這個檔回答的
  # 是「行程還活著嗎」，而那個問題的答案在備份天天失敗時也是「是」。
  if healthy; then
    date +%s > /tmp/backup-daemon-alive
  fi
  sleep 30
done
