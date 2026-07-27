#!/usr/bin/env bash
# 雲端智學 — 安裝前檢查
#
# 在動任何東西之前，把所有會導致安裝失敗或上線後才爆炸的條件
# 一次檢查完並全部列出來 —— 而不是失敗一項就退出，讓使用者
# 修一項再跑一次、再撞下一項。
#
# 用法：
#   ./deploy/scripts/preflight.sh              # Docker 部署（預設）
#   ./deploy/scripts/preflight.sh --native     # 原生安裝
#   ./deploy/scripts/preflight.sh --strict     # 警告也視為失敗

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

MODE="docker"
STRICT=0
FAILURES=0
WARNINGS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --native) MODE="native"; shift ;;
    --docker) MODE="docker"; shift ;;
    --strict) STRICT=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

check_fail() { err "$*"; FAILURES=$((FAILURES + 1)); }
check_warn() { warn "$*"; WARNINGS=$((WARNINGS + 1)); }

# 這支腳本要把所有問題找完，所以暫時關掉 errexit 與 ERR trap
set +e
trap - ERR

# ═══════════════════════════════════════════════════════════════
section "作業系統"
# ═══════════════════════════════════════════════════════════════

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  log "偵測到：${PRETTY_NAME:-未知}"
  case "${ID:-}" in
    ubuntu)
      major="${VERSION_ID%%.*}"
      if (( major < 22 )); then
        check_fail "Ubuntu ${VERSION_ID} 過舊。支援 22.04 LTS 以上（24.04 LTS 為建議版本）。"
      else
        ok "Ubuntu ${VERSION_ID}"
      fi
      ;;
    debian)
      check_warn "Debian 未經完整測試，但相依套件名稱與 Ubuntu 相同，多半可行。"
      ;;
    *)
      check_warn "作業系統 '${ID:-未知}' 未經測試。Docker 部署路徑受影響較小；原生安裝可能需要調整套件名稱。"
      ;;
  esac
else
  check_warn "讀不到 /etc/os-release，無法判斷發行版。"
fi

arch="$(uname -m)"
case "${arch}" in
  x86_64|aarch64) ok "架構 ${arch}" ;;
  *) check_fail "架構 ${arch} 不支援。需要 x86_64 或 aarch64。" ;;
esac

# ═══════════════════════════════════════════════════════════════
section "硬體資源"
# ═══════════════════════════════════════════════════════════════

cpus="$(cpu_count)"
if (( cpus < 2 )); then
  check_fail "CPU 核心數 ${cpus}。最低 2 核，300 人同時作答建議 4 核以上。"
elif (( cpus < 4 )); then
  check_warn "CPU 核心數 ${cpus}。可以跑，但 300 人同時作答時 AI 匯入會明顯拖慢作答回應。"
else
  ok "CPU ${cpus} 核"
fi

mem="$(mem_total_gb)"
if (( mem < 4 )); then
  check_fail "記憶體 ${mem}GB。最低 4GB —— 低於此值 PostgreSQL 與 AI 服務會互相搶記憶體並被 OOM killer 砍掉。"
elif (( mem < 8 )); then
  check_warn "記憶體 ${mem}GB。可以跑，但要把 .env 的 AI_MEMORY_LIMIT 調低到 2g，並考慮把 EMBEDDING_PROVIDER 改為 openai（本地嵌入模型約吃 2GB）。"
else
  ok "記憶體 ${mem}GB"
fi

for path in / /var; do
  [[ -d "${path}" ]] || continue
  free="$(disk_free_gb "${path}")"
  free="${free:-0}"
  if (( free < 20 )); then
    check_fail "${path} 剩餘空間 ${free}GB。最低 20GB。"
  elif (( free < 50 )); then
    check_warn "${path} 剩餘空間 ${free}GB。題庫、題本原檔與備份會持續成長，建議 50GB 以上。"
  else
    ok "${path} 剩餘空間 ${free}GB"
  fi
done

# 磁碟寫滿是自架系統最常見的當機原因，而備份目錄成長最快。
if [[ -n "${BACKUP_DIR:-}" ]] && [[ -d "$(dirname "${BACKUP_DIR}")" ]]; then
  bfree="$(disk_free_gb "$(dirname "${BACKUP_DIR}")")"
  (( ${bfree:-0} < 30 )) && check_warn "備份目錄所在磁碟剩餘 ${bfree}GB。30 天保留期會需要更多空間。"
fi

# ═══════════════════════════════════════════════════════════════
section "連接埠"
# ═══════════════════════════════════════════════════════════════

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  else
    return 1
  fi
}

# .env 可能還沒建立，先取一次 PROXY_MODE
_proxy_mode="caddy"
if [[ -f "${YZ_ROOT}/.env" ]]; then
  _proxy_mode="$(grep -E '^PROXY_MODE=' "${YZ_ROOT}/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ' || echo caddy)"
  _proxy_mode="${_proxy_mode:-caddy}"
fi

if [[ "${_proxy_mode}" == "external" ]]; then
  # 外部代理模式：80／443 本來就該被 nginx 佔著，那是正常狀態。
  # 要檢查的反而是「代理存在嗎」與「我們要綁的埠是空的嗎」。
  log "PROXY_MODE=external，由既有的反向代理處理對外流量"
  if command -v nginx >/dev/null 2>&1; then
    ok "nginx $(nginx -v 2>&1 | grep -oP '[\d.]+' | head -1)"
    if nginx -t >/dev/null 2>&1; then
      ok "既有 nginx 設定語法正確"
    else
      check_warn "既有的 nginx 設定目前有語法錯誤。安裝雲端智學的站台之前請先修好，否則 reload 會失敗。"
    fi
  else
    check_warn "找不到 nginx。PROXY_MODE=external 需要你自行準備反向代理。"
  fi

  _bind_port="$(grep -E '^WEB_BIND_PORT=' "${YZ_ROOT}/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ' || echo 3000)"
  _bind_port="${_bind_port:-3000}"
  if port_in_use "${_bind_port}"; then
    check_fail "連接埠 ${_bind_port} 已被佔用，應用無法綁定。改 .env 的 WEB_BIND_PORT，或停掉佔用的行程。"
  else
    ok "連接埠 ${_bind_port} 可用（供 nginx 轉發）"
  fi

  _bind_addr="$(grep -E '^WEB_BIND=' "${YZ_ROOT}/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ' || echo 127.0.0.1)"
  if [[ "${_bind_addr}" == "0.0.0.0" ]]; then
    check_fail "WEB_BIND=0.0.0.0 會讓應用直接暴露在網路上，繞過 nginx 的 TLS 與速率限制。請改為 127.0.0.1。"
  fi
else
  for port in 80 443; do
    if port_in_use "${port}"; then
      holder="$(ss -Hltnp "sport = :${port}" 2>/dev/null | grep -oP 'users:\(\("\K[^"]+' | head -1 || echo '未知')"
      check_fail "連接埠 ${port} 已被佔用（${holder}）。內建 Caddy 需要 80 與 443。機器上已有 nginx 時，請在 .env 設定 PROXY_MODE=external 改用它。"
    else
      ok "連接埠 ${port} 可用"
    fi
  done
fi

if [[ "${MODE}" == "native" ]]; then
  for port in 5432 6379 8000 9000; do
    port_in_use "${port}" && check_warn "連接埠 ${port} 已被佔用，原生安裝會衝突。"
  done
fi

# ═══════════════════════════════════════════════════════════════
section "必要工具"
# ═══════════════════════════════════════════════════════════════

for c in curl tar gzip openssl flock; do
  if command -v "${c}" >/dev/null 2>&1; then ok "${c}"; else check_fail "缺少 ${c}（sudo apt-get install -y ${c}）"; fi
done

if [[ "${MODE}" == "docker" ]]; then
  if command -v docker >/dev/null 2>&1; then
    dv="$(docker --version 2>/dev/null | grep -oP '\d+\.\d+' | head -1)"
    ok "Docker ${dv}"
    if docker info >/dev/null 2>&1; then
      ok "Docker daemon 運作中"
    else
      check_fail "Docker daemon 連不上。請確認：sudo systemctl start docker，以及目前使用者是否在 docker 群組。"
    fi
    if docker compose version >/dev/null 2>&1; then
      ok "Docker Compose $(docker compose version --short 2>/dev/null)"
    else
      check_fail "缺少 Docker Compose plugin（sudo apt-get install -y docker-compose-plugin）"
    fi
  else
    check_fail "未安裝 Docker。安裝方式見 docs/INSTALL.md，或執行 curl -fsSL https://get.docker.com | sh"
  fi
else
  command -v node >/dev/null 2>&1 && {
    nv="$(node -v | tr -d 'v' | cut -d. -f1)"
    (( nv >= 22 )) && ok "Node.js $(node -v)" || check_fail "Node.js $(node -v) 過舊，需要 22 以上。"
  } || check_fail "未安裝 Node.js 22+"
  command -v psql >/dev/null 2>&1 && ok "PostgreSQL client" || check_fail "未安裝 postgresql-client"
  command -v python3 >/dev/null 2>&1 && {
    pv="$(python3 -c 'import sys;print(sys.version_info[1])')"
    (( pv >= 11 )) && ok "Python 3.${pv}" || check_fail "Python 3.${pv} 過舊，需要 3.11 以上。"
  } || check_fail "未安裝 Python 3.11+"
fi

# ═══════════════════════════════════════════════════════════════
section "核心參數"
# ═══════════════════════════════════════════════════════════════

# PostgreSQL 在記憶體超賣的機器上會被 OOM killer 優先砍掉，
# 而它被砍掉等於整套系統停擺。
overcommit="$(sysctl -n vm.overcommit_memory 2>/dev/null || echo '?')"
[[ "${overcommit}" == "2" ]] && check_warn "vm.overcommit_memory=2 可能讓 PostgreSQL 無法配置記憶體。建議設為 0。"

somaxconn="$(sysctl -n net.core.somaxconn 2>/dev/null || echo 0)"
(( somaxconn < 1024 )) && check_warn "net.core.somaxconn=${somaxconn} 偏低。300 人同時登入時會出現連線被拒。建議：sysctl -w net.core.somaxconn=4096"

nofile="$(ulimit -n)"
(( nofile < 4096 )) && check_warn "檔案描述符上限 ${nofile} 偏低，建議 65536。"

if [[ -f /proc/sys/vm/swappiness ]]; then
  sw="$(cat /proc/sys/vm/swappiness)"
  (( sw > 10 )) && check_warn "vm.swappiness=${sw}。資料庫機器建議設為 1–10，否則 Postgres 的快取會被換出，查詢延遲會突然飆高。"
fi

# ═══════════════════════════════════════════════════════════════
section "設定檔"
# ═══════════════════════════════════════════════════════════════

if [[ -f "${YZ_ROOT}/.env" ]]; then
  ok "找到 .env"
  # 保留腳本自身的時區，避免 .env 的 TZ 讓同一次執行的日誌
  # 時間戳在中途跳掉 —— 那會讓日誌看起來不可信。
  _tz_before="${TZ:-}"
  # shellcheck disable=SC1091
  set -a; source "${YZ_ROOT}/.env"; set +a
  if [[ -n "${_tz_before}" ]]; then export TZ="${_tz_before}"; else unset TZ; fi

  for v in APP_DOMAIN APP_URL POSTGRES_PASSWORD REDIS_PASSWORD AUTH_SECRET S3_SECRET_KEY; do
    if [[ -z "${!v:-}" ]]; then
      check_fail "${v} 未設定。請執行 ./deploy/scripts/gen-secrets.sh"
    fi
  done

  if [[ -n "${AUTH_SECRET:-}" ]] && (( ${#AUTH_SECRET} < 32 )); then
    check_fail "AUTH_SECRET 長度 ${#AUTH_SECRET}，至少需要 32 字元。"
  fi

  # 拿範例值直接上線是很常見的失誤，而且完全靜默。
  for pair in "APP_DOMAIN:yunzhi.example.edu.tw" "BOOTSTRAP_ADMIN_EMAIL:admin@example.edu.tw"; do
    var="${pair%%:*}"; sample="${pair#*:}"
    [[ "${!var:-}" == "${sample}" ]] && check_warn "${var} 仍是範例值 '${sample}'，請改成實際值。"
  done

  if [[ "${PROXY_MODE:-caddy}" == "caddy" && "${TLS_MODE:-}" == "letsencrypt" ]]; then
    [[ -z "${ACME_EMAIL:-}" ]] && check_fail "TLS_MODE=letsencrypt 需要 ACME_EMAIL。"
    [[ "${APP_DOMAIN:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && check_fail "TLS_MODE=letsencrypt 不能用 IP 位址。內網部署請改 TLS_MODE=internal。"
  fi

  if [[ "${AI_PROVIDER:-mock}" != "mock" ]] && [[ -z "${AI_API_KEY:-}" ]]; then
    check_fail "AI_PROVIDER=${AI_PROVIDER} 需要 AI_API_KEY。僅驗證安裝時可先設為 mock。"
  fi

  if [[ "${WAL_ARCHIVE_ENABLED:-true}" != "true" ]]; then
    check_warn "WAL_ARCHIVE_ENABLED=false，RPO 會從 15 分鐘退化為 24 小時。正式環境不建議關閉。"
  fi

  if [[ "${BACKUP_ENCRYPTION_ENABLED:-true}" == "true" ]] && [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
    check_fail "啟用了備份加密但沒有 BACKUP_ENCRYPTION_KEY。執行 gen-secrets.sh 產生。"
  fi
else
  check_fail "找不到 .env。請執行：cp .env.example .env && ./deploy/scripts/gen-secrets.sh"
fi

# ═══════════════════════════════════════════════════════════════
section "網路"
# ═══════════════════════════════════════════════════════════════

if curl -fsS --max-time 8 -o /dev/null https://registry-1.docker.io/v2/ 2>/dev/null \
   || curl -fsS --max-time 8 -o /dev/null https://github.com 2>/dev/null; then
  ok "對外網路可達"
else
  check_warn "對外網路不通或被防火牆擋住。離線安裝請用 deploy/scripts/build-offline-bundle.sh 在有網路的機器上打包。"
fi

if [[ "${PROXY_MODE:-caddy}" == "caddy" && "${TLS_MODE:-internal}" == "letsencrypt" ]] && [[ -n "${APP_DOMAIN:-}" ]]; then
  resolved="$(getent hosts "${APP_DOMAIN}" 2>/dev/null | awk '{print $1}' | head -1)"
  if [[ -z "${resolved}" ]]; then
    check_fail "網域 ${APP_DOMAIN} 無法解析。Let's Encrypt 需要它指向這台機器。"
  else
    ok "${APP_DOMAIN} 解析到 ${resolved}"
  fi
fi

# ═══════════════════════════════════════════════════════════════
section "結果"
# ═══════════════════════════════════════════════════════════════

echo
if (( FAILURES > 0 )); then
  err "${FAILURES} 項失敗、${WARNINGS} 項警告。修正失敗項之後才能安裝。"
  exit 1
elif (( WARNINGS > 0 )); then
  if (( STRICT )); then
    err "${WARNINGS} 項警告，且指定了 --strict。"
    exit 1
  fi
  warn "${WARNINGS} 項警告。可以繼續安裝，但上線前請逐項確認。"
  exit 0
else
  ok "全部通過。可以安裝。"
  exit 0
fi
