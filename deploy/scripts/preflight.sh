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

# 這個埠是不是本系統自己的容器佔著的？
#
# **沒有這一項，安裝腳本就不是可重複執行的。** 系統跑起來之後
# Caddy 當然佔著 80／443，於是第二次執行 docker-install.sh
# （改了 .env 之後套用設定，是文件教的正常做法）會在安裝前檢查
# 就被自己擋下來，訊息是「連接埠 80 已被佔用」——而佔用它的正是
# 這套系統。維護老師的合理反應是去把它停掉，於是補習班在營業時間
# 斷線一次，只為了改一行設定。
port_is_ours() {
  local port="$1" name names
  command -v docker >/dev/null 2>&1 || return 1
  # `|| true` 的理由見 ubuntu-install.sh 的同名函式：docker 裝了但
  # daemon 沒起來時，$( ) 子 shell 裡的 ERR trap 會印出誤導人的
  # 「腳本失敗」。這支腳本目前把 ERR trap 關掉了所以看不到，
  # 但兩份要一致 —— 哪天有人把 trap 加回來，不該再踩一次。
  names="$(docker ps --filter 'name=yunzhi' --format '{{.Names}}' 2>/dev/null || true)"
  # shellcheck disable=SC2086  # 容器名稱不含空白，這裡要的就是斷詞
  for name in ${names}; do
    docker port "${name}" 2>/dev/null | grep -qE ":${port}\$" && return 0
  done
  return 1
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
  if port_is_ours "${_bind_port}"; then
    ok "連接埠 ${_bind_port} 由本系統的 web 容器佔用（重跑安裝，正常）"
  elif port_in_use "${_bind_port}"; then
    check_fail "連接埠 ${_bind_port} 已被佔用，應用無法綁定。改 .env 的 WEB_BIND_PORT，或停掉佔用的行程。"
  else
    ok "連接埠 ${_bind_port} 可用（供 nginx 轉發）"
  fi

else
  for port in 80 443; do
    if port_is_ours "${port}"; then
      ok "連接埠 ${port} 由本系統的 Caddy 佔用（重跑安裝，正常）"
    elif port_in_use "${port}"; then
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
  # snap 版的 Docker 跑在嚴格 confinement 底下，只看得到 $HOME 與 /media。
  # 本系統 bind mount 了 deploy/postgres、deploy/caddy 與 /var/backups/yunzhi，
  # 全部在 confinement 之外。症狀不是「掛載失敗」而是**掛載變成空目錄**：
  # Postgres 起得來但吃的是預設設定，WAL 歸檔沒開，RPO 從 15 分鐘悄悄
  # 變成 24 小時，而所有健康檢查都是綠的。
  if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
    check_fail "偵測到 snap 版的 Docker。confinement 會讓本系統的 bind mount 靜默失效（掛載變成空目錄）。請 sudo snap remove docker，改用 apt 版：sudo ./deploy/scripts/ubuntu-install.sh"
  fi

  if command -v docker >/dev/null 2>&1; then
    dv="$(docker --version 2>/dev/null | grep -oP '\d+\.\d+' | head -1)"
    ok "Docker ${dv}"
    if docker info >/dev/null 2>&1; then
      ok "Docker daemon 運作中"

      # docker-compose.yml 給每個服務都設了記憶體上限。Docker 在
      # 記憶體控制器不可用時**安靜地忽略**它們，只在 `docker info`
      # 的最後印一行 WARNING。於是 AI 服務解析一份 200 頁題本可以
      # 把整台機器吃光，OOM killer 挑最大的行程砍——那是 PostgreSQL，
      # 正在考試的學生全部斷線，而 compose 檔裡明明寫著 4g。
      _dinfo="$(docker info 2>&1 || true)"
      if grep -qi 'No memory limit support' <<<"${_dinfo}"; then
        check_fail "Docker 回報「No memory limit support」。compose 裡所有的記憶體上限都不會生效。核心開機參數需要 cgroup_enable=memory。"
      else
        ok "容器記憶體上限可用"
      fi
      grep -qi 'No swap limit support' <<<"${_dinfo}" \
        && check_warn "Docker 回報「No swap limit support」。記憶體上限仍生效，但容器可以無限用 swap，尖峰時磁碟 I/O 會拖垮資料庫。"
    else
      check_fail "Docker daemon 連不上。請確認：sudo systemctl start docker，以及目前使用者是否在 docker 群組（**加入群組之後要重新登入才生效**）。"
    fi
    if docker compose version >/dev/null 2>&1; then
      ok "Docker Compose $(docker compose version --short 2>/dev/null)"
    else
      check_fail "缺少 Docker Compose plugin。注意 docker-compose（有連字號）是舊版 v1，本系統要的是 v2 的 plugin：sudo apt-get install -y docker-compose-plugin"
    fi
    # 開機自動啟動。少了它，機房停電復電之後補習班早上開門是關的，
    # 而且 docker ps 一個容器都沒有、日誌裡沒有任何錯誤。
    if command -v systemctl >/dev/null 2>&1; then
      # shellcheck disable=SC2015  # ok() 是 printf 包裝、必定回 0，check_warn 不會被誤觸發
      systemctl is-enabled --quiet docker.service 2>/dev/null \
        && ok "docker.service 開機自動啟動" \
        || check_warn "docker.service 沒有設為開機啟動，重開機後整套系統不會回來：sudo systemctl enable docker"
    fi
  else
    check_fail "未安裝 Docker。全新的 Ubuntu 請執行：sudo ./deploy/scripts/ubuntu-install.sh（它會用 Docker 官方 apt 儲存庫安裝，並處理群組、防火牆與開機啟動）"
  fi
else
  # 這三項刻意寫成 if／else 而不是 `A && { … } || C`。
  #
  # 後者能成立只因為 check_fail 的最後一行是賦值、剛好回 0；哪天有人
  # 讓它回非零，「版本過舊」就會**連帶**觸發「未安裝」，而使用者看到的是
  # 兩行互相矛盾的訊息：node 明明裝了，卻被告知沒裝。這種相依不該存在
  # 於兩個檔案之間。
  if command -v node >/dev/null 2>&1; then
    nv="$(node -v 2>/dev/null | tr -d 'v' | cut -d. -f1)"
    if (( ${nv:-0} >= 22 )); then
      ok "Node.js $(node -v)"
    else
      check_fail "Node.js $(node -v) 過舊，需要 22 以上。"
    fi
  else
    check_fail "未安裝 Node.js 22+"
  fi

  if command -v psql >/dev/null 2>&1; then
    ok "PostgreSQL client"
  else
    check_fail "未安裝 postgresql-client"
  fi

  if command -v python3 >/dev/null 2>&1; then
    pv="$(python3 -c 'import sys;print(sys.version_info[1])' 2>/dev/null)"
    if (( ${pv:-0} >= 11 )); then
      ok "Python 3.${pv}"
    else
      check_fail "Python 3.${pv:-?} 過舊，需要 3.11 以上。"
    fi
  else
    check_fail "未安裝 Python 3.11+"
  fi
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

# cgroup 的記憶體控制器。上面 docker info 那一項是從 Docker 的角度問，
# 這一項是從核心的角度問——Docker 沒裝起來時仍然要能診斷。
if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
  if grep -qw memory /sys/fs/cgroup/cgroup.controllers; then
    ok "cgroup v2，記憶體控制器可用"
  else
    check_fail "cgroup v2 的記憶體控制器沒有啟用，容器的記憶體上限會被靜默忽略。核心開機參數需要 cgroup_enable=memory。"
  fi
elif [[ -d /sys/fs/cgroup/memory ]]; then
  check_warn "還在 cgroup v1。可以跑，但 Ubuntu 22.04 以後預設是 v2，這台機器可能被改過 systemd.unified_cgroup_hierarchy。"
else
  check_fail "找不到 cgroup 的記憶體控制器（v1 與 v2 都沒有）。容器的記憶體上限完全無效。"
fi

# ═══════════════════════════════════════════════════════════════
section "語系"
# ═══════════════════════════════════════════════════════════════

# Ubuntu Server 的最小安裝常常只有 POSIX/C locale（charmap 是
# ANSI_X3.4-1968＝ASCII）。這時候備份 tar 裡的中文檔名
# （老師上傳的「數學A_第三次模擬考.pdf」）會在**還原的時候**
# 才變成一串問號——也就是最不能出事的那一刻。
_charmap="$(locale charmap 2>/dev/null || echo '?')"
if [[ "${_charmap}" == "UTF-8" ]]; then
  ok "語系字元集 UTF-8"
else
  check_warn "語系字元集是 ${_charmap}（不是 UTF-8）。備份與還原時中文檔名會壞掉。修正：echo 'LANG=C.UTF-8' | sudo tee /etc/default/locale，然後重新登入。"
fi

# ═══════════════════════════════════════════════════════════════
section "防火牆"
# ═══════════════════════════════════════════════════════════════

# **Docker 發布的連接埠不受 ufw 約束。**
# Docker 在 nat/PREROUTING 與 FORWARD 動手腳，而 ufw 的規則掛在
# INPUT。`sudo ufw default deny incoming` 之後 `ufw status` 顯示
# 一切安全，但任何 `ports:` 都對全世界開著，而且看不出來。
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -qi 'Status: active'; then
  if command -v iptables >/dev/null 2>&1 && iptables -S DOCKER-USER 2>/dev/null | grep -q 'yunzhi-docker-user-drop'; then
    ok "ufw 已啟用，且 DOCKER-USER 有本系統的過濾規則"
  else
    check_warn "ufw 已啟用，但 Docker 發布的連接埠**不受它約束**（Docker 走 FORWARD，ufw 走 INPUT）。目前只有 Caddy 對外，風險有限；但只要有人在 compose 加一行 ports:，那個埠就是對全網開放的。補上過濾：sudo ./deploy/scripts/ubuntu-install.sh"
  fi
elif command -v ufw >/dev/null 2>&1; then
  check_warn "ufw 已安裝但未啟用。設定方式：sudo ./deploy/scripts/ubuntu-install.sh（它會先放行 SSH 再啟用，不會把你鎖在門外）。"
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

  # TLS_MODE 與 TLS_DIRECTIVE 是同一件事的兩個變數，而 Caddy 只讀後者。
  # 不一致的症狀是「憑證發錯但每一項健康檢查都是綠的」：改了 TLS_MODE
  # 卻沒改 TLS_DIRECTIVE 的機器，會用本地 CA 簽一張憑證發給全校，
  # 每一台學生電腦都看到「你的連線不是私人連線」。
  if [[ "${PROXY_MODE:-caddy}" == "caddy" ]]; then
    if "${YZ_SCRIPTS_DIR}/render-caddy.sh" --check >/dev/null 2>&1; then
      ok "TLS 設定一致（TLS_MODE=${TLS_MODE:-internal}）"
    else
      "${YZ_SCRIPTS_DIR}/render-caddy.sh" --check || true
      check_fail "TLS_MODE 與 TLS_DIRECTIVE 不一致。執行 ./deploy/scripts/render-caddy.sh 修正（安裝腳本會自動跑，手動改過 .env 才會出現這一項）。"
    fi
  fi

  # WEB_BIND 決定 web 容器的連接埠**綁在哪一個位址**，而 compose 是
  # 無條件發布它的（`${WEB_BIND:-127.0.0.1}:${WEB_BIND_PORT:-3000}:3000`，
  # web 服務沒有 profile）。所以這一項與 PROXY_MODE 無關 ——
  # 綁在 0.0.0.0 就是把應用的 HTTP 埠直接開在網際網路上：
  # 明文、沒有 Caddy 的 HSTS 與安全標頭、沒有速率限制，
  # 而網站本身仍然從 https:// 正常打得開，所以不會有人發現。
  #
  # **本來這一項只在 PROXY_MODE=external 時檢查**，但預設的 caddy 模式
  # 才是絕大多數人用的那一條路，漏掉的正好是會出事的那一邊。
  _bind_addr="${WEB_BIND:-127.0.0.1}"
  case "${_bind_addr}" in
    127.0.0.1|localhost|::1|'') ok "WEB_BIND=${_bind_addr:-（空，取預設 127.0.0.1）}，應用只聽本機" ;;
    0.0.0.0|'*'|'::')
      check_fail "WEB_BIND=${_bind_addr} 會把應用的 HTTP 埠 ${WEB_BIND_PORT:-3000} 直接開在網路上，繞過 TLS、安全標頭與速率限制。請改為 127.0.0.1。"
      ;;
    *)
      check_warn "WEB_BIND=${_bind_addr} 不是回送位址。請確認這個位址只有反向代理到得了。"
      ;;
  esac

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

# 已經建好映像的機器不需要對外網路，所以這一節一律是警告而不是失敗。
# 但兩個目標要**分開**測：企業防火牆放行 Docker Hub 卻擋掉
# binaries.prisma.sh 是很常見的設定，而那會讓建置在第 8 分鐘
# 才以一個看不出原因的錯誤失敗。
_net_ok=1
if curl -fsS --max-time 8 -o /dev/null https://registry-1.docker.io/v2/ 2>/dev/null \
   || curl -fsS --max-time 8 -o /dev/null https://github.com 2>/dev/null; then
  ok "連得到 Docker Hub"
else
  check_warn "連不到 Docker Hub（registry-1.docker.io）。基底映像 pgvector／redis／minio／caddy 都在那裡。"
  _net_ok=0
fi

# Prisma 的查詢引擎是**執行期**的硬相依，但它在建置時下載並烤進映像。
# 抓不到的話 `docker compose build` 會失敗，而錯誤訊息是一個
# 403 Forbidden 加一串網址，看起來像是 Prisma 官方掛了。
if curl -fsS --max-time 8 -o /dev/null -w '' https://binaries.prisma.sh/ 2>/dev/null \
   || curl -sS --max-time 8 -o /dev/null -w '%{http_code}' https://binaries.prisma.sh/ 2>/dev/null | grep -qE '^[234]'; then
  ok "連得到 binaries.prisma.sh"
else
  check_warn "連不到 binaries.prisma.sh。Prisma 查詢引擎在建置時從那裡下載並烤進映像，抓不到就建置失敗。"
  _net_ok=0
fi

if (( ! _net_ok )); then
  dim "封閉網段的做法：在有網路的**同架構**機器上執行"
  dim "  ./deploy/scripts/build-offline-bundle.sh"
  dim "把產出的 yunzhi-offline-*.tar.gz 搬過來，解開之後"
  dim "  sudo ./deploy/scripts/ubuntu-install.sh --offline"
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
