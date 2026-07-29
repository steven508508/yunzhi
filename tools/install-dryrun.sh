#!/usr/bin/env bash
# 雲端智學 — 安裝前的乾跑檢查
#
# 在**還沒動這台機器之前**回答一個問題：這裡裝得起來嗎。
#
# 存在的理由是 ubuntu-install.sh 的前半段會改機器（裝 Docker、改時區、
# 動防火牆、加群組），而它的檢查與那些動作是交錯的 —— 撞到第 6 步才
# 發現連不到 binaries.prisma.sh 時，Docker 已經裝好、ufw 已經啟用、
# 使用者已經被加進 docker 群組了。這一支只讀不寫，可以在正式安裝前
# 隨便跑幾次，也可以拿去問網管「這幾個位址幫我開一下」。
#
# **為什麼是 bash 而不是 node。**
# 這台機器在跑這支腳本的當下通常什麼都還沒有：Docker 部署路徑從頭到尾
# 不需要宿主機上的 Node。要求先 `apt-get install -y nodejs` 才能檢查
# 「這台機器能不能用」本末倒置，而且 Ubuntu 22.04 的 nodejs 套件是
# 12.22 —— 連 `?.` 都不支援，寫成 .mjs 會在半數的支援平台上直接
# 語法錯誤。bash 在每一台 Ubuntu 上都在。
#
# 輸出格式與 tools/deploy-check.mjs 一致，因為維護老師會連著跑這兩支。
#
# 用法：
#   ./tools/install-dryrun.sh
#   ./tools/install-dryrun.sh --no-network   # 略過對外連線測試（很慢或機房封閉）
#
# 結束碼：0 = 可以安裝；1 = 有必須先處理的項目。

# 刻意不用 `set -e`：這支腳本的價值在於**一次列出所有問題**。
# 撞到第一項就結束的話，維護老師得修一項跑一次，而他的時間是
# 暑假的一個下午。
set -uo pipefail

YZ_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${YZ_ROOT}/.env"
CHECK_NETWORK=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-network) CHECK_NETWORK=0; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) printf '不認得的參數：%s\n' "$1" >&2; exit 2 ;;
  esac
done

# ── 輸出 ────────────────────────────────────────────────────────
# 非 TTY 時關掉顏色，否則貼進工單或郵件的是一堆跳脫序列。
if [[ -t 1 ]] && [[ "${NO_COLOR:-}" != "1" ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_DIM=''
fi

PASSED=0; FAILED=0; WARNED=0

section() { printf '\n%s── %s%s\n' "${C_BOLD}" "$*" "${C_RESET}"; }
pass()    { printf '   %s✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; PASSED=$((PASSED + 1)); }
skip()    { printf '   %s·%s %s\n' "${C_DIM}" "${C_RESET}" "$*"; }
# 失敗與警告都要**在同一行講清楚怎麼修**。維護老師不會回頭翻文件，
# 他會照著螢幕上最後看到的那一句做。
fail()    { printf '   %s✗%s %s\n' "${C_RED}" "${C_RESET}" "$1"; printf '     %s\n' "$2"; FAILED=$((FAILED + 1)); }
warned()  { printf '   %s!%s %s\n' "${C_YELLOW}" "${C_RESET}" "$1"; printf '     %s\n' "$2"; WARNED=$((WARNED + 1)); }

# ── .env 讀取 ───────────────────────────────────────────────────
# 只取字面值，不 source。source 會把 .env 當 bash 腳本執行，而這支
# 腳本的工作正是檢查那份檔案有沒有問題 —— 用會被它影響的方式讀它，
# 等於把要檢查的東西放進檢查工具裡。
env_get() {
  local key="$1" raw
  [[ -f "${ENV_FILE}" ]] || return 0
  raw="$(grep -E "^${key}=" "${ENV_FILE}" 2>/dev/null | tail -1 | cut -d= -f2-)"
  raw="${raw%$'\r'}"
  if [[ "${raw}" == \"*\" ]]; then raw="${raw:1:${#raw}-2}"; fi
  if [[ "${raw}" == \'*\' ]]; then raw="${raw:1:${#raw}-2}"; fi
  printf '%s' "${raw}"
}

printf '\n%s雲端智學 — 安裝前乾跑檢查%s\n' "${C_BOLD}" "${C_RESET}"
printf '%s這支腳本只讀不寫，不會改動這台機器。%s\n' "${C_DIM}" "${C_RESET}"

# ════════════════════════════════════════════════════════════════
section "作業系統"
# ════════════════════════════════════════════════════════════════

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu)
      _major="${VERSION_ID%%.*}"; _major="${_major//[^0-9]/}"
      if (( ${_major:-0} < 22 )); then
        fail "Ubuntu ${VERSION_ID:-?} 過舊" "需要 22.04 LTS 以上（建議 24.04 LTS）。這台機器要先升級或重灌。"
      else
        pass "Ubuntu ${VERSION_ID}（${VERSION_CODENAME:-?}）"
      fi
      ;;
    debian) warned "Debian ${VERSION_ID:-?} 未經完整測試" "套件名稱與 Ubuntu 相同，多半可行。出問題時請對照 docs/UBUNTU.md 的手動安裝一節。" ;;
    *)      warned "發行版 '${ID:-未知}' 未經測試" "ubuntu-install.sh 的 apt 步驟可能不適用，請走 docs/UBUNTU.md 的手動安裝。" ;;
  esac
else
  fail "讀不到 /etc/os-release" "無法判斷發行版。這不是一台標準的 Ubuntu，請人工確認。"
fi

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|aarch64) pass "架構 ${ARCH}" ;;
  *) fail "架構 ${ARCH} 不支援" "基底映像（pgvector、minio）只發布 amd64 與 arm64，換一台機器。" ;;
esac

# 核心。Docker 名義上 3.10 就能跑，但 overlay2 ＋ cgroup v2 ＋ 現代
# seccomp 的實際下限高得多，低於 4.15 會落在「容器起得來但掛載與網路
# 偶發失敗」這種最難查的狀態。
KVER="$(uname -r)"
_kmaj="${KVER%%.*}"; _krest="${KVER#*.}"; _kmin="${_krest%%.*}"; _kmin="${_kmin//[^0-9]/}"
if (( ${_kmaj:-0} < 4 || (${_kmaj:-0} == 4 && ${_kmin:-0} < 15) )); then
  fail "核心 ${KVER} 過舊" "Docker 需要 4.15 以上（Ubuntu 22.04 出廠是 5.15）。"
else
  pass "核心 ${KVER}"
fi

if [[ -d /run/systemd/system ]]; then
  pass "systemd 運作中"
else
  fail "沒有 systemd" "安裝腳本用 systemctl 管理 Docker 與開機自動啟動，容器化或精簡的環境跑不了。"
fi

# cgroup 的記憶體控制器。
#
# **這一項不做的後果最貴。** docker-compose.yml 給每個服務都設了記憶體
# 上限，而控制器不可用時 Docker 會安靜地忽略它們（只在 `docker info`
# 的 WARNING 裡提一句）。於是 AI 服務解析一份 200 頁題本可以把整台機器
# 的記憶體吃光，OOM killer 挑最大的行程砍 —— 那是 PostgreSQL，
# 正在考試的學生全部斷線。
if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
  if grep -qw memory /sys/fs/cgroup/cgroup.controllers; then
    pass "cgroup v2，記憶體控制器可用"
  else
    fail "cgroup v2 的記憶體控制器沒有啟用" "容器的記憶體上限會被靜默忽略。多半是開機參數缺 cgroup_enable=memory（ARM 板子常見）。"
  fi
elif [[ -d /sys/fs/cgroup/memory ]]; then
  warned "還在 cgroup v1" "可以跑，但 24.04 之後的 Docker 只在 v2 上完整測試。"
else
  fail "找不到 cgroup 的記憶體控制器" "v1 與 v2 都沒有，容器的記憶體上限完全無效。"
fi

# ════════════════════════════════════════════════════════════════
section "硬體資源"
# ════════════════════════════════════════════════════════════════

CPUS="$(nproc 2>/dev/null || echo 1)"
if (( CPUS < 2 )); then
  fail "CPU ${CPUS} 核" "最低 2 核。"
elif (( CPUS < 4 )); then
  warned "CPU ${CPUS} 核" "可以跑，但 300 人同時作答時 AI 匯入會明顯拖慢作答回應。"
else
  pass "CPU ${CPUS} 核"
fi

MEM="$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)"
if (( ${MEM:-0} < 4 )); then
  fail "記憶體 ${MEM}GB" "最低 4GB —— 低於此值 PostgreSQL 與 AI 服務會互相搶記憶體並被 OOM killer 砍掉。"
elif (( MEM < 8 )); then
  warned "記憶體 ${MEM}GB" "可以跑，但要把 .env 的 AI_MEMORY_LIMIT 調到 2g。"
else
  pass "記憶體 ${MEM}GB"
fi

# next build 在記憶體不足的機器上會被 OOM killer 砍掉，而 Docker 回報的是
# 「build worker exited with code: 137」—— 那個數字沒有任何一個字提到
# 記憶體，很容易被當成程式碼有問題，然後花一個下午查錯方向。
SWAP_MB="$(awk '/SwapTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
if (( ${MEM:-0} < 6 )) && (( ${SWAP_MB:-0} < 2048 )); then
  warned "記憶體 ${MEM}GB 且 swap 只有 ${SWAP_MB}MB" "建置 next build 那一步可能被 OOM killer 砍掉（錯誤碼 137）。先加 swap：sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
else
  pass "swap ${SWAP_MB}MB"
fi

# 看 Docker 真正會用的那一顆磁碟。/ 有空間但 /var 是獨立分割區且滿了，
# 是機房配出來的機器上很常見的組態。
DOCKER_ROOT="/var/lib/docker"
[[ -d "${DOCKER_ROOT}" ]] || DOCKER_ROOT="/var/lib"
FREE="$(df -BG --output=avail "${DOCKER_ROOT}" 2>/dev/null | tail -1 | tr -dc '0-9')"
if (( ${FREE:-0} < 20 )); then
  fail "${DOCKER_ROOT} 剩餘 ${FREE:-0}GB" "映像約 5GB、資料庫與題本原檔會持續成長，最低 20GB。"
elif (( FREE < 50 )); then
  warned "${DOCKER_ROOT} 剩餘 ${FREE}GB" "建議 50GB 以上，否則一個學期之後要處理磁碟。"
else
  pass "${DOCKER_ROOT} 剩餘 ${FREE}GB"
fi

# ════════════════════════════════════════════════════════════════
section "連接埠"
# ════════════════════════════════════════════════════════════════

PROXY_MODE="$(env_get PROXY_MODE)"; PROXY_MODE="${PROXY_MODE:-caddy}"
WEB_BIND_PORT="$(env_get WEB_BIND_PORT)"; WEB_BIND_PORT="${WEB_BIND_PORT:-3000}"

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
  else
    return 2
  fi
}
port_holder() {
  ss -Hltnp "sport = :$1" 2>/dev/null | grep -oP 'users:\(\("\K[^"]+' | head -1
}
# 這個埠是不是本系統自己的容器佔著的？
# 沒有這一項，裝好之後再跑一次乾跑檢查會報「80 被佔用」——
# 而佔用它的正是剛裝好的 Caddy。
port_is_ours() {
  local port="$1" name
  command -v docker >/dev/null 2>&1 || return 1
  for name in $(docker ps --filter 'name=yunzhi' --format '{{.Names}}' 2>/dev/null); do
    docker port "${name}" 2>/dev/null | grep -qE ":${port}\$" && return 0
  done
  return 1
}

# compose 裡發布的每一個埠都要檢查，不是只有 80／443。
#
# **從 docker-compose.yml 直接解析，不呼叫 `docker compose config`**：
# 這支腳本要在 Docker 還沒安裝的機器上跑得動，而那正是它最該被跑的
# 時候。有人在 compose 檔加了一行 ports: 時，這裡會自動跟著檢查。
collect_published_ports() {
  local compose="${YZ_ROOT}/docker-compose.yml"
  [[ -f "${compose}" ]] || return 0
  # 取出 `- "…:…"` 形式的埠對映，展開 ${VAR:-default}，留下宿主機側的埠。
  grep -oE '^\s+-\s+"[^"]*:[0-9]+"' "${compose}" 2>/dev/null \
    | grep -oE '"[^"]*"' | tr -d '"' \
    | while IFS= read -r spec; do
        # ${WEB_BIND_PORT:-3000} → 先用 .env 的值，沒有就用預設值
        while [[ "${spec}" =~ \$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\} ]]; do
          local var="${BASH_REMATCH[1]}" def="${BASH_REMATCH[3]:-}" val
          val="$(env_get "${var}")"; val="${val:-${def}}"
          spec="${spec//${BASH_REMATCH[0]}/${val}}"
        done
        # 宿主機側是倒數第二段（addr:host:container 或 host:container）
        local host_port
        host_port="$(awk -F: '{print $(NF-1)}' <<<"${spec}")"
        [[ "${host_port}" =~ ^[0-9]+$ ]] && printf '%s\n' "${host_port}"
      done | sort -un
}

PORTS_TO_CHECK=()
while IFS= read -r p; do
  [[ -n "${p}" ]] && PORTS_TO_CHECK+=("${p}")
done < <(collect_published_ports)

# caddy 服務掛在 caddy profile 底下，PROXY_MODE=external 時不會啟動，
# 那時候 80／443 本來就該被既有的 nginx 佔著 —— 報它是錯的。
if [[ "${PROXY_MODE}" == "external" ]]; then
  _filtered=()
  for p in "${PORTS_TO_CHECK[@]:-}"; do
    [[ -z "${p}" || "${p}" == "80" || "${p}" == "443" ]] && continue
    _filtered+=("${p}")
  done
  PORTS_TO_CHECK=("${_filtered[@]:-}")
  skip "PROXY_MODE=external，80／443 交給既有的反向代理，不檢查"
fi

if ! command -v ss >/dev/null 2>&1; then
  warned "沒有 ss 指令，無法檢查連接埠" "sudo apt-get install -y iproute2 之後重跑。"
else
  for p in "${PORTS_TO_CHECK[@]:-}"; do
    [[ -n "${p}" ]] || continue
    if port_is_ours "${p}"; then
      pass "連接埠 ${p} 由本系統自己的容器佔用（已安裝過，正常）"
    elif port_in_use "${p}"; then
      _holder="$(port_holder "${p}")"
      if [[ "${p}" == "80" || "${p}" == "443" ]]; then
        fail "連接埠 ${p} 已被 ${_holder:-未知的行程} 佔用" "內建 Caddy 需要 80 與 443。機器上已有 nginx／Apache 時**不要停用它** —— 在 .env 設 PROXY_MODE=external 改用它。"
      else
        fail "連接埠 ${p} 已被 ${_holder:-未知的行程} 佔用" "改 .env 的 WEB_BIND_PORT，或停掉佔用它的行程。"
      fi
    else
      pass "連接埠 ${p} 可用"
    fi
  done
fi

# ════════════════════════════════════════════════════════════════
section "對外網路"
# ════════════════════════════════════════════════════════════════

# **三個目標分開測，而且分開講。**
#
# 企業與校園防火牆很常見的組態是「放行 Docker Hub、擋掉其他」，
# 而 binaries.prisma.sh 被擋的話建置會在**第 8 分鐘**才失敗 ——
# 那時候已經沒有人記得是網路問題。分開測才問得出「請幫我開這一個」。
probe_host() {
  local url="$1" label="$2" why="$3"
  # 用 curl 而不是自己接 TCP：curl 會照 HTTPS_PROXY／NO_PROXY 走，
  # 而需要走 proxy 的校園網路正是最可能出問題的那一種。安裝腳本
  # 也是用 curl 測同樣的位址，兩邊結果才會一致。
  local code
  code="$(curl -sS --max-time 12 -o /dev/null -w '%{http_code}' "${url}" 2>/dev/null)"
  # 2xx／3xx／4xx 都算連得到：registry-1.docker.io/v2/ 對未認證的
  # 請求回 401，那代表「通了而且對方是 Docker Registry」。
  if [[ "${code}" =~ ^[234] ]]; then
    pass "${label} 連得到（HTTP ${code}）"
  else
    fail "連不到 ${label}：${url}" "${why}"
  fi
}

if (( ! CHECK_NETWORK )); then
  skip "已指定 --no-network，略過對外連線測試"
elif ! command -v curl >/dev/null 2>&1; then
  fail "沒有 curl，無法測試對外連線" "sudo apt-get install -y curl 之後重跑。"
else
  probe_host "https://registry-1.docker.io/v2/" "Docker Hub" \
    "基底映像（pgvector、redis、minio、caddy）都在這裡。請網管放行 registry-1.docker.io 與 auth.docker.io，或改走離線包（見 docs/UBUNTU.md 第 5 節）。"
  probe_host "https://binaries.prisma.sh/" "binaries.prisma.sh" \
    "Prisma 的查詢引擎在建置時從這裡下載並烤進映像，是執行期的硬相依 —— 不是「少一個功能」而是整個映像不能用。**這一個最常被單獨擋掉**，請特別指名請網管放行。"
  probe_host "https://download.docker.com/linux/ubuntu/gpg" "download.docker.com" \
    "Docker Engine 本身從這個 apt 儲存庫安裝。連不到的話 ubuntu-install.sh 會停在「設定 Docker 官方 apt 儲存庫」那一步。"
fi

# ════════════════════════════════════════════════════════════════
section "設定檔"
# ════════════════════════════════════════════════════════════════

if [[ ! -f "${ENV_FILE}" ]]; then
  fail "找不到 .env" "先建立設定：cp .env.example .env && ./deploy/scripts/gen-secrets.sh"
else
  pass "找到 .env"

  # 權限。裡面有資料庫密碼、AI 金鑰與備份加密金鑰，644 等於同一台
  # 機器上的任何帳號都讀得到 —— 包含跑在上面的其他服務。
  _perms="$(stat -c '%a' "${ENV_FILE}" 2>/dev/null)"
  if [[ "${_perms}" == "600" || "${_perms}" == "400" ]]; then
    pass ".env 權限 ${_perms}"
  else
    fail ".env 權限是 ${_perms:-未知}" "裡面有資料庫密碼與備份加密金鑰。修正：chmod 600 .env"
  fi

  # 必填項。這幾個是 apps/web/lib/env.ts 會擋下來的，少了任何一個
  # web 容器會起來又立刻退出，而日誌要翻到最底才看得到原因。
  _missing=()
  for v in APP_DOMAIN APP_URL POSTGRES_PASSWORD REDIS_PASSWORD AUTH_SECRET S3_SECRET_KEY; do
    [[ -n "$(env_get "${v}")" ]] || _missing+=("${v}")
  done
  if ((${#_missing[@]})); then
    fail "必填設定是空的：${_missing[*]}" "自動產生的欄位請執行 ./deploy/scripts/gen-secrets.sh；APP_DOMAIN 與 APP_URL 要自己填。"
  else
    pass "必填設定都有值"
  fi

  # 範例值。拿 .env.example 直接上線是很常見的失誤，而且完全靜默：
  # 系統會正常啟動，然後憑證簽給一個不存在的網域。
  _samples=()
  [[ "$(env_get APP_DOMAIN)" == "yunzhi.example.edu.tw" ]] && _samples+=("APP_DOMAIN")
  [[ "$(env_get APP_URL)" == "https://yunzhi.example.edu.tw" ]] && _samples+=("APP_URL")
  [[ "$(env_get BOOTSTRAP_ADMIN_EMAIL)" == "admin@example.edu.tw" ]] && _samples+=("BOOTSTRAP_ADMIN_EMAIL")
  if ((${#_samples[@]})); then
    fail "這幾項還是 .env.example 的範例值：${_samples[*]}" "改成實際的網域與信箱。憑證會照 APP_DOMAIN 簽發，填錯的話學生連進來就是憑證錯誤。"
  else
    pass "沒有留著範例值"
  fi

  _auth="$(env_get AUTH_SECRET)"
  if [[ -n "${_auth}" ]] && (( ${#_auth} < 32 )); then
    fail "AUTH_SECRET 只有 ${#_auth} 字元" "至少 32 字元。執行 ./deploy/scripts/gen-secrets.sh --rotate AUTH_SECRET 重新產生，不要自己想一個。"
  elif [[ -n "${_auth}" ]]; then
    pass "AUTH_SECRET 長度 ${#_auth}"
  fi

  # APP_URL 要含協定，否則 Auth.js 的回呼網址會組不出來，
  # 症狀是登入之後被導到一個 404。
  _url="$(env_get APP_URL)"
  if [[ -n "${_url}" && "${_url}" != http://* && "${_url}" != https://* ]]; then
    fail "APP_URL=${_url} 沒有協定" "要寫成完整網址，例如 https://yunzhi.你的學校.edu.tw"
  elif [[ -n "${_url}" ]]; then
    pass "APP_URL=${_url}"
  fi

  # WEB_BIND。compose 是無條件發布 web 埠的，所以這一項與 PROXY_MODE
  # 無關：綁在 0.0.0.0 就是把應用的 HTTP 埠直接開在網際網路上 ——
  # 明文、沒有 Caddy 的安全標頭、沒有速率限制，而網站本身仍然從
  # https:// 正常打得開，所以不會有人發現。
  _bind="$(env_get WEB_BIND)"; _bind="${_bind:-127.0.0.1}"
  case "${_bind}" in
    127.0.0.1|localhost|::1) pass "WEB_BIND=${_bind}，應用只聽本機" ;;
    0.0.0.0|'*'|'::')
      fail "WEB_BIND=${_bind}" "會把應用的 HTTP 埠 ${WEB_BIND_PORT} 直接開在網路上，繞過 TLS、安全標頭與速率限制。請改為 127.0.0.1。"
      ;;
    *) warned "WEB_BIND=${_bind} 不是回送位址" "請確認這個位址只有反向代理到得了。" ;;
  esac

  # TLS。letsencrypt 模式的兩個前提如果不成立，Caddy 會反覆向
  # Let's Encrypt 要憑證並被限流，而網站在那段時間是打不開的。
  _tls="$(env_get TLS_MODE)"; _tls="${_tls:-internal}"
  if [[ "${PROXY_MODE}" == "caddy" && "${_tls}" == "letsencrypt" ]]; then
    if [[ -z "$(env_get ACME_EMAIL)" ]]; then
      fail "TLS_MODE=letsencrypt 但 ACME_EMAIL 是空的" "填一個收得到信的信箱，憑證到期通知會寄到那裡。"
    elif [[ "$(env_get APP_DOMAIN)" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      fail "TLS_MODE=letsencrypt 不能用 IP 位址" "Let's Encrypt 不簽 IP。純內網部署請改 TLS_MODE=internal。"
    else
      pass "TLS_MODE=letsencrypt，ACME_EMAIL 已填"
    fi
  else
    pass "TLS_MODE=${_tls}"
  fi

  if [[ "$(env_get BACKUP_ENCRYPTION_ENABLED)" != "false" && -z "$(env_get BACKUP_ENCRYPTION_KEY)" ]]; then
    fail "啟用了備份加密但 BACKUP_ENCRYPTION_KEY 是空的" "執行 ./deploy/scripts/gen-secrets.sh 產生。"
  else
    pass "備份加密設定完整"
  fi

  # 異地備份。這一項在裝機當天看起來最不急，而它是唯一一個
  # 「發生的時候什麼都救不回來」的設定。
  #
  # 預設是四個欄位全空，也就是：資料庫在這顆磁碟、每天的備份在**同一顆
  # 磁碟**、而解密備份用的 BACKUP_ENCRYPTION_KEY 在**同一台機器**的 .env 裡。
  # 磁碟壞掉或機器被偷，三樣一起沒有；而且備份是加密的，
  # 就算有人手上有一份複本，沒有那把金鑰在數學上也還原不回來。
  #
  # 這裡刻意不是 fail：小型補習班第一天不見得有 S3 端點，
  # 擋住安裝只會讓人把它註解掉。但它必須被看見一次。
  if [[ -z "$(env_get BACKUP_REMOTE_ENDPOINT)" || -z "$(env_get BACKUP_REMOTE_BUCKET)" ]]; then
    if [[ "$(env_get BACKUP_ENCRYPTION_ENABLED)" != "false" ]]; then
      warned "沒有異地備份：備份、資料庫、解密金鑰三樣都在這一台機器上" \
        "這台機器毀了就全沒了（金鑰在 .env，.env 也只在這裡）。上線前至少做兩件事：把 BACKUP_ENCRYPTION_KEY 抄進密碼管理器，並設定 BACKUP_REMOTE_*。做法見 docs/UBUNTU.md 的「異地備份與金鑰保管」。"
    else
      warned "沒有異地備份：備份與資料庫在同一顆磁碟上" \
        "磁碟壞掉時兩者一起消失。設定 BACKUP_REMOTE_*，做法見 docs/UBUNTU.md 的「異地備份與金鑰保管」。"
    fi
  else
    pass "異地備份已設定（$(env_get BACKUP_REMOTE_ENDPOINT)）"
  fi

  _ai="$(env_get AI_PROVIDER)"; _ai="${_ai:-mock}"
  if [[ "${_ai}" != "mock" && -z "$(env_get AI_API_KEY)" ]]; then
    fail "AI_PROVIDER=${_ai} 但 AI_API_KEY 是空的" "填入金鑰，或先設 AI_PROVIDER=mock 完成安裝，之後改設定重跑 ./deploy/scripts/docker-install.sh 即可。"
  elif [[ "${_ai}" == "mock" ]]; then
    warned "AI_PROVIDER=mock" "AI 功能會回傳假資料。驗證安裝可以，正式使用前要填真的金鑰。"
  else
    pass "AI_PROVIDER=${_ai}，金鑰已填"
  fi
fi

# ════════════════════════════════════════════════════════════════
section "時間與時區"
# ════════════════════════════════════════════════════════════════

# 考試的開放與截止時間、備份檔名、稽核記錄全部依賴系統時區。
# 資料庫存 UTC、畫面顯示台北時間，中間的換算靠的就是這個設定 ——
# 設錯不會有任何錯誤訊息，只會讓每一場考試的開關時間差八小時。
WANT_TZ="$(env_get TZ)"; WANT_TZ="${WANT_TZ:-Asia/Taipei}"
CUR_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo '?')"

if [[ ! -f "/usr/share/zoneinfo/${WANT_TZ}" ]]; then
  fail ".env 的 TZ=${WANT_TZ} 在這台機器上不存在" "打錯了？台灣請用 Asia/Taipei。安裝腳本會照這個值設定系統時區，設不起來的話時間全部會是 UTC。"
elif [[ "${CUR_TZ}" == "${WANT_TZ}" ]]; then
  pass "系統時區 ${CUR_TZ}，與 .env 的 TZ 一致"
else
  # 這不是失敗：ubuntu-install.sh 會把它設成 .env 裡的值。
  # 講出來是為了讓維護老師知道「機器現在是 UTC」是預期中的、會被修正的。
  skip "系統時區目前是 ${CUR_TZ}，安裝時會設成 ${WANT_TZ}"
fi

if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then
  pass "時間已與 NTP 同步"
else
  warned "時間沒有與 NTP 同步" "考試倒數與稽核記錄都依賴正確的時間，TLS 憑證驗證在時間偏差幾分鐘後也會出怪事。安裝腳本會嘗試開啟：sudo timedatectl set-ntp true"
fi

# 語系。最小安裝常常只有 C/POSIX（charmap 是 ASCII），這時候備份 tar
# 裡的中文檔名會在**還原的時候**才變成一串問號 —— 而那是最不能出錯的
# 時刻。安裝腳本會改成 C.UTF-8，這裡只是先讓人知道。
CHARMAP="$(locale charmap 2>/dev/null || echo '?')"
if [[ "${CHARMAP}" == "UTF-8" ]]; then
  pass "語系字元集 UTF-8"
else
  skip "目前字元集是 ${CHARMAP}，安裝時會改成 C.UTF-8（中文檔名才不會壞）"
fi

# ════════════════════════════════════════════════════════════════
section "Docker"
# ════════════════════════════════════════════════════════════════

# snap 版的 Docker 跑在嚴格 confinement 底下，只存取得到 $HOME 與
# /media，而本系統 bind mount 了 deploy/postgres、deploy/caddy 與
# /var/backups/yunzhi。症狀不是「掛載失敗」而是**掛載變成空目錄**：
# Postgres 起得來但吃的是預設設定，WAL 歸檔沒開，RPO 從 15 分鐘
# 悄悄變成 24 小時，而所有健康檢查都是綠的。
if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
  fail "偵測到 snap 版的 Docker" "它的 confinement 會讓本系統的 bind mount 靜默失效。請先 sudo snap remove docker，安裝腳本會改裝 apt 版。"
fi

if ! command -v docker >/dev/null 2>&1; then
  skip "還沒有 Docker —— ubuntu-install.sh 會用官方 apt 儲存庫安裝（這是正常的）"
else
  _dv="$(docker --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  _dmaj="${_dv%%.*}"; _drest="${_dv#*.}"; _dmin="${_drest%%.*}"
  if (( ${_dmaj:-0} > 20 || (${_dmaj:-0} == 20 && ${_dmin:-0} >= 10) )); then
    pass "Docker ${_dv}"
  else
    fail "Docker ${_dv:-未知} 過舊" "需要 20.10 以上。移除後讓 ubuntu-install.sh 重裝官方版本。"
  fi

  # compose v2 是 plugin（`docker compose`），不是 docker-compose。
  # 舊的 v1 不認得這份 compose 檔裡的 profiles 與 condition。
  if docker compose version >/dev/null 2>&1; then
    pass "Docker Compose $(docker compose version --short 2>/dev/null)"
  else
    fail "沒有 docker compose（v2 plugin）" "注意 docker-compose（有連字號）是舊版 v1，不能用。安裝：sudo apt-get install -y docker-compose-plugin"
  fi

  if docker info >/dev/null 2>&1; then
    pass "Docker daemon 連得上"
  else
    # 不是失敗：這支腳本刻意不需要 sudo，而沒有 sudo 也不在 docker
    # 群組時本來就連不上 daemon。安裝腳本會處理群組。
    skip "目前這個帳號連不上 Docker daemon（還沒加進 docker 群組，安裝腳本會處理）"
  fi
fi

# ════════════════════════════════════════════════════════════════
printf '\n'
if (( FAILED > 0 )); then
  printf '%s%d 項必須先處理%s，%d 項提醒，%d 項通過。\n' \
    "${C_RED}" "${FAILED}" "${C_RESET}" "${WARNED}" "${PASSED}"
  printf '%s上面每一項 ✗ 都寫了怎麼修。修完再跑一次這支腳本。%s\n\n' "${C_DIM}" "${C_RESET}"
  exit 1
fi

printf '%s可以安裝%s（%d 項通過，%d 項提醒）。\n' "${C_GREEN}" "${C_RESET}" "${PASSED}" "${WARNED}"
if (( WARNED > 0 )); then
  printf '%s提醒不會擋住安裝，但每一項都會在某一天變成故障。%s\n' "${C_DIM}" "${C_RESET}"
fi
printf '\n下一步：sudo ./deploy/scripts/ubuntu-install.sh\n\n'
