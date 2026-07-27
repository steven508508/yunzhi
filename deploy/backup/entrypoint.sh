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

log() { printf '%s [backup] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

do_backup() {
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local out="/backups/yunzhi-${stamp}.tar.gz"
  local work; work="$(mktemp -d)"
  trap 'rm -rf "${work}"' RETURN

  log "開始備份"
  if ! pg_dump --format=custom --compress=6 --no-owner --no-privileges > "${work}/database.dump"; then
    log "pg_dump 失敗"; return 1
  fi

  # WAL 歸檔以唯讀掛載進來，直接複製即可
  [[ -d /wal_archive ]] && cp -r /wal_archive "${work}/wal" 2>/dev/null || true

  cat > "${work}/manifest.json" <<JSON
{"name":"yunzhi-${stamp}","createdAt":"$(date -Iseconds)","appVersion":"${APP_VERSION:-unknown}",
 "source":"scheduled","includesObjects":false,"encrypted":${BACKUP_ENCRYPTION_ENABLED:-true}}
JSON

  tar -czf "${out}" -C "${work}" .

  if [[ "${BACKUP_ENCRYPTION_ENABLED:-true}" == "true" && -n "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -in "${out}" -out "${out}.enc" -pass "pass:${BACKUP_ENCRYPTION_KEY}"
    rm -f "${out}"; out="${out}.enc"
  fi

  chmod 600 "${out}"
  sha256sum "${out}" > "${out}.sha256"
  log "完成：$(basename "${out}") ($(du -h "${out}" | cut -f1))"

  # 清理過期，但保留帶事件標籤的備份
  find /backups -maxdepth 1 -name 'yunzhi-*.tar.gz*' ! -name '*.sha256' \
       ! -name '*pre-upgrade*' ! -name '*pre-uninstall*' ! -name '*pre-restore*' \
       -type f -mtime "+${BACKUP_RETENTION_DAYS:-30}" -delete 2>/dev/null || true
}

log "備份排程啟動：每日 $(printf '%02d:%02d' "${BACKUP_HOUR}" "${BACKUP_MIN}")"
touch /tmp/backup-daemon-alive

while true; do
  now_h=$(date +%-H); now_m=$(date +%-M)
  if (( now_h == BACKUP_HOUR && now_m == BACKUP_MIN )); then
    do_backup || log "備份失敗，明天再試"
    sleep 61
  fi
  touch /tmp/backup-daemon-alive
  sleep 30
done
