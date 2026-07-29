#!/usr/bin/env bash
# 雲端智學 — Ubuntu 從零安裝
#
# 對象是一台**剛開好的 Ubuntu Server 22.04／24.04**：只有 SSH 與
# sudo，沒有 Docker、沒有設過防火牆、時區可能還是 UTC。從這個狀態
# 到「瀏覽器打得開登入頁」，這支腳本負責中間的每一步。
#
# docker-install.sh 假設 Docker 已經裝好而且你在 docker 群組裡；
# 這一支負責讓那個假設成立，然後把後半段交給它。
#
# **可重複執行。** 每一步都先確認現況再動手，重跑只會補齊缺的東西。
#
# 用法：
#   sudo ./deploy/scripts/ubuntu-install.sh
#   sudo ./deploy/scripts/ubuntu-install.sh --check-only    # 只檢查，不安裝
#   sudo ./deploy/scripts/ubuntu-install.sh --offline       # 用離線包，不建置
#   sudo ./deploy/scripts/ubuntu-install.sh --as-user alice # 指定服務的擁有者
#   sudo ./deploy/scripts/ubuntu-install.sh --no-firewall   # 不動 ufw（自行負責）
#   sudo ./deploy/scripts/ubuntu-install.sh --monitoring    # 一併啟用監控

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CHECK_ONLY=0
OFFLINE=0
WITH_MONITORING=0
MANAGE_FIREWALL=1
LOCK_DOCKER_PORTS=1
TARGET_USER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only) CHECK_ONLY=1; shift ;;
    --offline) OFFLINE=1; shift ;;
    --monitoring) WITH_MONITORING=1; shift ;;
    --as-user) TARGET_USER="$2"; shift 2 ;;
    --no-firewall) MANAGE_FIREWALL=0; shift ;;
    --no-docker-port-lock) LOCK_DOCKER_PORTS=0; shift ;;
    --yes|-y) export YZ_ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

need_root

cat <<'BANNER'

  ╔══════════════════════════════════════════════════════════╗
  ║                      雲端智學                             ║
  ║          Ubuntu 從零安裝（Docker 部署）                    ║
  ╚══════════════════════════════════════════════════════════╝

BANNER

TOTAL_STEPS=10
STEP=0
step() { STEP=$((STEP + 1)); section "${STEP}／${TOTAL_STEPS}  $*"; }

FAILURES=0
WARNINGS=0
req_fail() { err "$*"; FAILURES=$((FAILURES + 1)); }
req_warn() { warn "$*"; WARNINGS=$((WARNINGS + 1)); }

# ════════════════════════════════════════════════════════════════
step "服務的擁有者"
#
# **這一步排在最前面是有理由的。**
#
# 用 sudo 跑安裝，後面每一個檔案都會是 root 的：.env 是 600 root:root，
# 於是使用者登出 root 之後連 doctor.sh 都跑不起來（讀不到設定），
# 而錯誤訊息是「找不到設定檔」—— 檔案明明就在那裡。
#
# 所以要先決定「這套系統平常是誰在操作」，後面所有產生的檔案都歸他。
# ════════════════════════════════════════════════════════════════

if [[ -z "${TARGET_USER}" ]]; then
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    TARGET_USER="${SUDO_USER}"
  else
    # 直接以 root 登入（沒有經過 sudo）時，用 repo 的擁有者當線索：
    # 那通常就是 git clone 的人。
    repo_owner="$(stat -c '%U' "${YZ_ROOT}" 2>/dev/null || echo root)"
    TARGET_USER="${repo_owner}"
  fi
fi

id "${TARGET_USER}" >/dev/null 2>&1 || die "使用者 ${TARGET_USER} 不存在。請用 --as-user 指定一個既有的帳號。"
TARGET_GROUP="$(id -gn "${TARGET_USER}")"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"

if [[ "${TARGET_USER}" == "root" ]]; then
  req_warn "找不到非 root 的操作者，所有檔案會歸 root。"
  dim "之後只能用 sudo 操作這套系統。要改的話：sudo ./deploy/scripts/ubuntu-install.sh --as-user <帳號>"
else
  ok "服務擁有者：${TARGET_USER}（群組 ${TARGET_GROUP}，家目錄 ${TARGET_HOME}）"
fi

# repo 本身的擁有者。root clone 而使用者操作的話，gen-secrets 寫不進 .env。
repo_owner="$(stat -c '%U' "${YZ_ROOT}" 2>/dev/null || echo '?')"
if [[ "${repo_owner}" != "${TARGET_USER}" ]]; then
  info "程式目錄目前屬於 ${repo_owner}，改歸 ${TARGET_USER}。"
  (( CHECK_ONLY )) || chown -R "${TARGET_USER}:${TARGET_GROUP}" "${YZ_ROOT}"
fi

# 以目標使用者身分執行某個指令。
#
# **用 sudo -u 而不是 su 或直接跑**，因為 sudo 會重新讀 /etc/group：
# 上面剛把人加進 docker 群組，這個 session 的群組清單裡還沒有它，
# 但 sudo 開出來的新行程有。這正是「加了群組要重新登入」那條規則
# 的例外，也是這支腳本能一路跑完不用中途登出的原因。
as_user() {
  if [[ "${TARGET_USER}" == "root" ]]; then
    ( cd "${YZ_ROOT}" && "$@" )
  else
    sudo -u "${TARGET_USER}" -H --preserve-env=YZ_ASSUME_YES,APP_VERSION \
      env -C "${YZ_ROOT}" "$@"
  fi
}

# ════════════════════════════════════════════════════════════════
step "設定檔"
# ════════════════════════════════════════════════════════════════

if [[ -f "${YZ_ROOT}/.env" ]]; then
  info "已有 .env，補齊缺漏的自動產生欄位。"
  (( CHECK_ONLY )) || as_user "${YZ_SCRIPTS_DIR}/gen-secrets.sh" >/dev/null
  ok "設定檔就緒"
elif (( CHECK_ONLY )); then
  info "（--check-only）尚未建立 .env。"
else
  info "建立 .env 並產生密碼。"
  as_user "${YZ_SCRIPTS_DIR}/gen-secrets.sh"
fi

# 只取需要的幾個值，不 source 整份 .env —— 那會把 TZ 灌進當前 shell，
# 讓這一次執行的日誌時間戳在中途跳掉，看起來像日誌被竄改過。
PROXY_MODE="$(env_get_value PROXY_MODE)"; PROXY_MODE="${PROXY_MODE:-caddy}"
WANT_TZ="$(env_get_value TZ)";            WANT_TZ="${WANT_TZ:-Asia/Taipei}"
BACKUP_DIR_VAL="$(env_get_value BACKUP_DIR)"; BACKUP_DIR_VAL="${BACKUP_DIR_VAL:-${YZ_ROOT}/data/backups}"
APP_URL_VAL="$(env_get_value APP_URL)"
WEB_BIND_PORT_VAL="$(env_get_value WEB_BIND_PORT)"; WEB_BIND_PORT_VAL="${WEB_BIND_PORT_VAL:-3000}"

# ════════════════════════════════════════════════════════════════
step "系統需求檢查"
#
# 全部檢查完再一起報，不是撞到一項就退出。維護老師的時間是暑假的
# 一個下午，讓他修一項跑一次、再撞下一項，是最浪費他時間的做法。
# ════════════════════════════════════════════════════════════════

# ── 發行版 ──
if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu)
      if (( ${VERSION_ID%%.*} < 22 )); then
        req_fail "Ubuntu ${VERSION_ID} 過舊。需要 22.04 LTS 以上（建議 24.04 LTS）。"
      else
        ok "Ubuntu ${VERSION_ID}（${VERSION_CODENAME:-?}）"
      fi
      ;;
    debian) req_warn "Debian ${VERSION_ID:-?} 未經完整測試。套件名稱相同，多半可行。" ;;
    *)      req_warn "發行版 '${ID:-未知}' 未經測試。下面的 apt 步驟可能不適用。" ;;
  esac
else
  req_fail "讀不到 /etc/os-release，無法判斷發行版。"
fi

# ── 架構 ──
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|aarch64) ok "架構 ${ARCH}" ;;
  *) req_fail "架構 ${ARCH} 不支援。基底映像（pgvector、minio）只發布 amd64 與 arm64。" ;;
esac

# ── 核心 ──
#
# Docker 本身要 3.10 就能跑，但 overlay2 ＋ cgroup v2 ＋ 現代
# seccomp 設定檔實際的下限高得多。低於 4.15 的核心會在
# 「容器起得來但網路或掛載偶發失敗」這種最難查的狀態。
KVER="$(uname -r)"
kmaj="${KVER%%.*}"; krest="${KVER#*.}"; kmin="${krest%%.*}"
kmin="${kmin//[^0-9]/}"; kmin="${kmin:-0}"
if (( kmaj < 4 || (kmaj == 4 && kmin < 15) )); then
  req_fail "核心 ${KVER} 過舊。Docker 需要 4.15 以上（Ubuntu 22.04 出廠是 5.15）。"
elif (( kmaj < 5 )); then
  req_warn "核心 ${KVER}。可以跑，但建議 5.4 以上。"
else
  ok "核心 ${KVER}"
fi

# ── cgroup 的記憶體控制器 ──
#
# **這一項不做的後果最貴。** docker-compose.yml 給每個服務都設了
# 記憶體上限，而記憶體控制器不可用時 Docker 會**安靜地忽略**它們
# （只在 `docker info` 的 WARNING 裡提一句）。於是 AI 服務解析一份
# 200 頁題本時可以把整台機器的記憶體吃光，OOM killer 挑最大的行程
# 砍 —— 那是 PostgreSQL。正在考試的學生全部斷線，而 compose 檔裡
# 明明寫著 AI_MEMORY_LIMIT=4g。
if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
  if grep -qw memory /sys/fs/cgroup/cgroup.controllers; then
    ok "cgroup v2，記憶體控制器可用"
  else
    req_fail "cgroup v2 的記憶體控制器沒有啟用。容器的記憶體上限會被靜默忽略。"
    dim "多半是核心開機參數缺 cgroup_enable=memory（ARM 板子常見）。"
  fi
elif [[ -d /sys/fs/cgroup/memory ]]; then
  req_warn "還在 cgroup v1。可以跑，但 24.04 之後的 Docker 只在 v2 上完整測試。"
else
  req_fail "找不到 cgroup 的記憶體控制器（v1 與 v2 都沒有）。容器的記憶體上限完全無效。"
fi

# ── systemd ──
if [[ -d /run/systemd/system ]]; then
  ok "systemd 運作中"
else
  req_fail "沒有 systemd。這支腳本用 systemctl 管理 Docker 與開機自動啟動。"
fi

# ── 資源 ──
CPUS="$(cpu_count)"
MEM="$(mem_total_gb)"
if (( CPUS < 2 )); then
  req_fail "CPU ${CPUS} 核。最低 2 核。"
elif (( CPUS < 4 )); then
  req_warn "CPU ${CPUS} 核。300 人同時作答時 AI 匯入會明顯拖慢作答回應。"
else
  ok "CPU ${CPUS} 核"
fi

if (( MEM < 4 )); then
  req_fail "記憶體 ${MEM}GB。最低 4GB —— 低於此值 PostgreSQL 與 AI 服務會互相搶記憶體並被 OOM killer 砍掉。"
elif (( MEM < 8 )); then
  req_warn "記憶體 ${MEM}GB。可以跑，但要把 .env 的 AI_MEMORY_LIMIT 調到 2g。"
else
  ok "記憶體 ${MEM}GB"
fi

# next build 在 4GB 機器上會被 OOM killer 砍掉，而 Docker 回報的是
# 「build worker exited with code: 137」—— 那個數字沒有任何一個字
# 提到記憶體，很容易被當成程式碼有問題。
SWAP_MB="$(awk '/SwapTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
if (( ! OFFLINE )) && (( MEM < 6 )) && (( SWAP_MB < 2048 )); then
  req_warn "記憶體 ${MEM}GB 且 swap 只有 ${SWAP_MB}MB，建置 next build 這一步可能被 OOM killer 砍掉（錯誤碼 137）。"
  dim "先加 4GB swap 再建置："
  dim "  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile"
  dim "  sudo mkswap /swapfile && sudo swapon /swapfile"
  dim "  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab"
fi

DOCKER_ROOT="/var/lib/docker"
[[ -d "${DOCKER_ROOT}" ]] || DOCKER_ROOT="/var/lib"
FREE="$(disk_free_gb "${DOCKER_ROOT}")"; FREE="${FREE:-0}"
if (( FREE < 20 )); then
  req_fail "${DOCKER_ROOT} 剩餘 ${FREE}GB。映像約 5GB、資料庫與題本原檔會持續成長，最低 20GB。"
elif (( FREE < 50 )); then
  req_warn "${DOCKER_ROOT} 剩餘 ${FREE}GB。建議 50GB 以上。"
else
  ok "${DOCKER_ROOT} 剩餘 ${FREE}GB"
fi

# ── snap 版的 Docker ──
#
# **這是 Ubuntu 上最容易踩、也最難自己看出來的一個坑。**
# snap 的 Docker 跑在嚴格 confinement 底下，只能存取 $HOME 與
# /media。而這套系統的 compose 檔 bind mount 了 deploy/postgres、
# deploy/caddy 與 /var/backups/yunzhi —— 全部在 confinement 之外。
# 症狀是 Postgres 起來但吃的是預設設定（掛載被靜默換成空目錄），
# 於是 WAL 歸檔沒開、RPO 從 15 分鐘變成 24 小時，而沒有任何錯誤。
if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
  req_fail "偵測到 snap 版的 Docker。它的 confinement 會讓本系統的 bind mount 靜默失效。"
  dim "請移除後改用 apt 版（本腳本會裝）："
  dim "  sudo snap remove docker"
fi

# ── 連接埠 ──
port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
  else
    return 1
  fi
}
port_holder() {
  ss -Hltnp "sport = :$1" 2>/dev/null | grep -oP 'users:\(\("\K[^"]+' | head -1 || true
}
# 這個埠是不是本系統自己的容器佔著的？
#
# **沒有這一項，這支腳本就不是可重複執行的。** 系統跑起來之後 Caddy
# 當然佔著 80／443，於是第二次執行（改了 .env 之後套用設定，是文件
# 教的正常做法）會被自己擋下來，訊息是「連接埠 80 已被佔用」——
# 而佔用它的正是這套系統。維護老師的合理反應是去把它停掉。
port_is_ours() {
  local port="$1" name
  command -v docker >/dev/null 2>&1 || return 1
  for name in $(docker ps --filter 'name=yunzhi' --format '{{.Names}}' 2>/dev/null); do
    docker port "${name}" 2>/dev/null | grep -qE ":${port}\$" && return 0
  done
  return 1
}

if [[ "${PROXY_MODE}" == "external" ]]; then
  log "PROXY_MODE=external，80／443 交給既有的反向代理"
  if port_is_ours "${WEB_BIND_PORT_VAL}"; then
    ok "連接埠 ${WEB_BIND_PORT_VAL} 由本系統的 web 容器佔用（重跑安裝，正常）"
  elif port_in_use "${WEB_BIND_PORT_VAL}"; then
    req_fail "連接埠 ${WEB_BIND_PORT_VAL} 已被 $(port_holder "${WEB_BIND_PORT_VAL}") 佔用。改 .env 的 WEB_BIND_PORT。"
  else
    ok "連接埠 ${WEB_BIND_PORT_VAL} 可用（供 nginx 轉發）"
  fi
else
  for p in 80 443; do
    if port_is_ours "${p}"; then
      ok "連接埠 ${p} 由本系統的 Caddy 佔用（重跑安裝，正常）"
    elif port_in_use "${p}"; then
      req_fail "連接埠 ${p} 已被 $(port_holder "${p}") 佔用。內建 Caddy 需要 80 與 443。"
      dim "機器上已有 nginx／Apache 時**不要停用它** —— 在 .env 設 PROXY_MODE=external 改用它。"
    else
      ok "連接埠 ${p} 可用"
    fi
  done
fi

# ── 對外網路 ──
#
# 兩個目標分開測。只測 github.com 會漏掉「Docker Hub 通但
# binaries.prisma.sh 不通」這種很常見的企業防火牆設定，而那會
# 讓建置在第 8 分鐘才失敗。
if (( ! OFFLINE )); then
  # 映像已經在本機時（重跑安裝），對外網路只是「最好有」而不是必要條件。
  # 一律當成致命錯誤的話，機房臨時斷外網那天連「重跑安裝套用新設定」
  # 都做不了 —— 而那正是最需要能動手的時候。
  _have_images=0
  if command -v docker >/dev/null 2>&1 \
     && docker image inspect "yunzhi/web:$(cat "${YZ_ROOT}/VERSION" 2>/dev/null || echo dev)" >/dev/null 2>&1; then
    _have_images=1
  fi
  for host in https://registry-1.docker.io/v2/ https://binaries.prisma.sh/; do
    if curl -fsS --max-time 10 -o /dev/null "${host}" 2>/dev/null \
       || curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "${host}" 2>/dev/null | grep -qE '^[234]'; then
      ok "連得到 ${host}"
    elif (( _have_images )); then
      req_warn "連不到 ${host}，但本機已經有建好的映像，安裝可以繼續（不會重新建置）。"
    else
      req_fail "連不到 ${host}。"
      case "${host}" in
        *prisma*) dim "Prisma 的查詢引擎在建置時從這裡下載並烤進映像，是執行期的硬相依。" ;;
        *)        dim "基底映像（pgvector、redis、minio、caddy）都在 Docker Hub 上。" ;;
      esac
      dim "封閉網段請改走離線包：在有網路的同架構機器上 ./deploy/scripts/build-offline-bundle.sh，"
      dim "搬過來之後 sudo ./deploy/scripts/ubuntu-install.sh --offline"
    fi
  done
else
  ok "離線模式，跳過對外網路檢查"
  [[ -f "${YZ_ROOT}/offline/MANIFEST" ]] \
    || req_fail "指定了 --offline 但找不到 ${YZ_ROOT}/offline/MANIFEST。離線包解開了嗎？"
fi

echo
if (( FAILURES > 0 )); then
  die "${FAILURES} 項不合格、${WARNINGS} 項警告。上面每一項都寫了怎麼修，修完重跑這支腳本。"
fi
ok "系統需求檢查通過（${WARNINGS} 項警告）"

if (( CHECK_ONLY )); then
  echo
  ok "--check-only：只做了檢查，沒有安裝任何東西。"
  exit 0
fi

# ════════════════════════════════════════════════════════════════
step "時區與語系"
# ════════════════════════════════════════════════════════════════

# 時區。備份排程（BACKUP_SCHEDULE 的「凌晨三點」）、稽核記錄的時間、
# 考試的開始與結束時間全部依賴它。機器出廠是 UTC，差八小時 ——
# 「昨天下午的備份」會出現在今天早上的檔名裡，而查稽核記錄的人
# 會對不上學生說的時間。
CUR_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo '?')"
if [[ "${CUR_TZ}" == "${WANT_TZ}" ]]; then
  ok "時區 ${CUR_TZ}"
elif [[ -f "/usr/share/zoneinfo/${WANT_TZ}" ]]; then
  info "時區 ${CUR_TZ} → ${WANT_TZ}"
  if timedatectl set-timezone "${WANT_TZ}"; then
    ok "時區已設為 ${WANT_TZ}"
  else
    req_warn "設定時區失敗，保持 ${CUR_TZ}。備份檔名與稽核記錄的時間會差 8 小時。"
  fi
else
  req_warn "時區 ${WANT_TZ} 在這台機器上不存在（.env 的 TZ 打錯了？），保持 ${CUR_TZ}。"
fi

# NTP。時間飄掉的機器上，考試倒數計時與稽核記錄都不可信；
# 而 TLS 憑證驗證也會在時間差超過幾分鐘時開始出怪事。
if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then
  ok "時間已與 NTP 同步"
else
  info "啟用 NTP 時間同步…"
  timedatectl set-ntp true 2>/dev/null || req_warn "無法啟用 NTP，請自行確認機器時間正確。"
fi

# 語系。Ubuntu Server 的最小安裝常常只有 POSIX/C locale，charmap 是
# ANSI_X3.4-1968（＝ASCII）。這時候：
#   · tar 進備份的中文檔名（老師上傳的「數學A_第三次模擬考.pdf」）
#     在還原時會變成一串問號，而且是**還原的時候**才發現
#   · 宿主機上直接跑的 CSV 名冊工具排序與比對會出錯
CHARMAP="$(locale charmap 2>/dev/null || echo '?')"
if [[ "${CHARMAP}" == "UTF-8" ]]; then
  ok "語系 $(locale | grep -E '^LANG=' | cut -d= -f2 || echo '?')（UTF-8）"
else
  info "目前語系的字元集是 ${CHARMAP}，中文檔名會壞掉。改用 C.UTF-8。"
  # C.UTF-8 在 Ubuntu 上一律存在，不必 locale-gen，也不會影響
  # 日誌訊息的語言。要中文訊息的話另外跑 locale-gen zh_TW.UTF-8。
  if grep -qE '^LANG=' /etc/default/locale 2>/dev/null; then
    sed -i 's|^LANG=.*|LANG=C.UTF-8|' /etc/default/locale
  else
    printf 'LANG=C.UTF-8\n' >>/etc/default/locale
  fi
  export LANG=C.UTF-8 LC_ALL=C.UTF-8
  ok "已寫入 /etc/default/locale（下次登入生效；本次執行已套用）"
fi

# ════════════════════════════════════════════════════════════════
step "Docker Engine"
# ════════════════════════════════════════════════════════════════

# **只問「裝了沒」，不問「daemon 活著沒」。**
# 用 `docker version`（會連 daemon）判斷的話，一台裝好了但 daemon
# 剛好沒啟動的機器會被判定成「沒裝」，於是走進安裝分支、看到一堆
# 已安裝的套件、然後跳出「要移除舊套件嗎」的確認 —— 而使用者真正
# 需要的只是 systemctl start docker。下面的 enable --now 會處理啟動。
docker_ok=0
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker_ok=1
fi

if (( docker_ok )); then
  ok "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1)｜Compose $(docker compose version --short)"
  info "已安裝，跳過。"
else
  # 發行版自帶的 docker.io／podman-docker 與 Docker 官方的 docker-ce
  # 會互相衝突（同樣的執行檔路徑、不同的 containerd）。官方文件要求
  # 先移除，但**移除會停掉機器上正在跑的其他容器**，所以要先問。
  conflicting=()
  for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
    # 注意用 if 而不是 `dpkg -s … && arr+=()`：後者在套件不存在時
    # 整個複合指令回非零，errexit 會直接把腳本收掉。
    if dpkg -s "${pkg}" >/dev/null 2>&1; then
      conflicting+=("${pkg}")
    fi
  done
  if ((${#conflicting[@]})); then
    warn "偵測到會與 Docker 官方套件衝突的舊套件：${conflicting[*]}"
    running="$(docker ps -q 2>/dev/null | wc -l || echo 0)"
    if (( running > 0 )); then
      err "而且目前有 ${running} 個容器在執行 —— 移除套件會把它們全部停掉。"
      dim "先確認那些容器是什麼：docker ps"
    fi
    confirm_phrase "將移除上列套件，改裝 Docker 官方版本。" "REPLACE DOCKER"
    apt-get remove -y "${conflicting[@]}" || warn "移除舊套件時有錯誤，繼續。"
  fi

  info "設定 Docker 官方 apt 儲存庫…"
  # 用官方 apt repo 而不是 `curl get.docker.com | sh`：後者是一支會
  # 隨時改變的遠端腳本，而且在企業稽核時說不清楚裝了什麼。
  # 更不能用 snap —— 見上面 confinement 那一段。
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || die "apt-get update 失敗。這台機器連得到 archive.ubuntu.com 嗎？"
  apt-get install -y -qq ca-certificates curl gnupg \
    || die "安裝 ca-certificates／curl 失敗。"

  install -m 0755 -d /etc/apt/keyrings
  DIST_ID="${ID:-ubuntu}"
  [[ "${DIST_ID}" == "debian" ]] || DIST_ID="ubuntu"
  # Ubuntu 衍生版（Mint 等）的 VERSION_CODENAME 是自己的名字，
  # Docker 的 repo 不認得。UBUNTU_CODENAME 才是上游的代號。
  CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
  [[ -n "${CODENAME}" ]] || die "讀不出 Ubuntu 代號（VERSION_CODENAME），無法設定 apt 儲存庫。"

  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL "https://download.docker.com/linux/${DIST_ID}/gpg" -o /etc/apt/keyrings/docker.asc \
      || die "下載 Docker 的 GPG 金鑰失敗。"
    chmod a+r /etc/apt/keyrings/docker.asc
  fi

  DEB_ARCH="$(dpkg --print-architecture)"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "${DEB_ARCH}" "${DIST_ID}" "${CODENAME}" >/etc/apt/sources.list.d/docker.list

  info "安裝 Docker Engine 與 compose plugin…"
  apt-get update -qq || die "加入 Docker 儲存庫後 apt-get update 失敗。"
  apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    || die "安裝 Docker 失敗。看上面的 apt 訊息。"

  ok "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1) 安裝完成"
  docker compose version >/dev/null 2>&1 \
    || die 'compose plugin 沒裝起來。「docker compose version」不能用的話後面每一步都不能跑。'
fi

# 這兩個服務必須是 enabled，否則重開機之後 Docker 不會起來，
# 而 compose 的 restart: unless-stopped 也就無從發揮。
for unit in docker.service containerd.service; do
  if systemctl is-enabled --quiet "${unit}" 2>/dev/null; then
    ok "${unit} 已設為開機啟動"
  else
    systemctl enable --now "${unit}" >/dev/null 2>&1 \
      && ok "${unit} 已設為開機啟動" \
      || req_warn "無法 enable ${unit}，重開機後可能不會自動啟動。"
  fi
done
systemctl start docker.service >/dev/null 2>&1 || true

# 到這裡 daemon 一定要是活的，否則後面每一步都會失敗，
# 而失敗訊息會散在七、八個不同的地方。
docker info >/dev/null 2>&1 \
  || die "Docker daemon 連不上。診斷：sudo systemctl status docker；sudo journalctl -u docker -n 50"

# ════════════════════════════════════════════════════════════════
step "docker 群組"
#
# 沒有這一步，使用者跑 docker-install.sh 的第一個 docker 指令就是
#   permission denied while trying to connect to the Docker daemon socket
# 而多數人的反應是「那我加 sudo」—— 於是 .env 與 data/ 全部變成
# root 的，日後每一個維運操作都要 sudo，備份腳本以一般身分跑不動。
# ════════════════════════════════════════════════════════════════

if [[ "${TARGET_USER}" == "root" ]]; then
  info "服務擁有者是 root，不需要 docker 群組。"
elif id -nG "${TARGET_USER}" | tr ' ' '\n' | grep -qx docker; then
  ok "${TARGET_USER} 已在 docker 群組"
else
  usermod -aG docker "${TARGET_USER}"
  ok "${TARGET_USER} 已加入 docker 群組"
  echo
  warn "※ 群組要**重新登入**才會對互動 shell 生效。"
  dim "這支腳本用 sudo -u 執行後半段，所以現在不必登出；"
  dim "但你自己下一次要跑 docker 指令之前，請先 exit 再 ssh 進來一次。"
  dim "沒有重新登入就下 docker ps，會得到 permission denied。"
  echo
fi

echo
warn "安全提醒：docker 群組等同 root。"
dim "群組成員可以掛載宿主機的 / 到容器裡並改任何檔案，這是 Docker 的設計，不是這套系統的問題。"
dim "只把真正需要維運這台機器的人加進來。"

# ════════════════════════════════════════════════════════════════
step "防火牆"
#
# **Ubuntu 上最常見的自架安全事故就在這裡。**
#
# Docker 發布連接埠時，是在 iptables 的 nat/PREROUTING 與 FORWARD
# 動手腳，而 ufw 的規則掛在 INPUT。也就是說：
#
#     sudo ufw default deny incoming     ← 看起來全部擋掉了
#     sudo ufw status                    ← 顯示 80/443 以外都是 deny
#     docker compose up -d               ← 任何 publish 的埠都對全世界開著
#
# `ufw status` 不會顯示這件事，`ss -ltn` 顯示的是 0.0.0.0 但看起來
# 跟被 ufw 擋住的其他服務一樣。所以一台「已經設好防火牆」的機器上，
# 一個 ports: "5432:5432" 就等於把學生個資資料庫直接開在網際網路上。
#
# 這一步做兩件事：把 ufw 設對，以及在 DOCKER-USER 鏈補上真正會生效
# 的過濾。DOCKER-USER 是 Docker 保證不會覆寫的使用者鏈。
# ════════════════════════════════════════════════════════════════

UFW_MARK_BEGIN="### BEGIN 雲端智學 DOCKER-USER"
UFW_MARK_END="### END 雲端智學 DOCKER-USER"

if (( ! MANAGE_FIREWALL )); then
  warn "已指定 --no-firewall，完全不動防火牆。"
  warn "請自行確認：Docker publish 的連接埠**不受 ufw 規則約束**。"
  dim "本系統預設只有 Caddy 對外（80／443），web 綁在 127.0.0.1。"
  dim "任何時候在 compose 檔加了 ports:，那個埠就是對全網開放的。"
elif ! command -v ufw >/dev/null 2>&1; then
  warn "沒有安裝 ufw，跳過防火牆設定。"
  dim "要用的話：sudo apt-get install -y ufw，然後重跑這支腳本。"
else
  # ── SSH 一定要先放行 ──
  #
  # 順序錯了就是把自己鎖在門外，而且是**遠端**鎖在門外 ——
  # 沒有 KVM 的雲主機到這裡就結束了。
  SSH_PORTS=()
  while IFS= read -r p; do
    [[ "${p}" =~ ^[0-9]+$ ]] && SSH_PORTS+=("${p}")
  done < <(
    { grep -rhoiE '^[[:space:]]*Port[[:space:]]+[0-9]+' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null \
        | grep -oE '[0-9]+'
      ss -Hltnp 2>/dev/null | grep sshd | awk '{print $4}' | sed 's/.*://'
      printf '22\n'
    } | sort -un
  )
  for p in "${SSH_PORTS[@]}"; do
    if ufw allow "${p}/tcp" >/dev/null 2>&1; then
      ok "ufw 放行 SSH ${p}/tcp"
    else
      req_warn "ufw 放行 ${p}/tcp 失敗。**在繼續之前請自己確認 SSH 進得來**，否則下一步可能把你鎖在門外。"
    fi
  done

  if [[ "${PROXY_MODE}" == "external" ]]; then
    info "PROXY_MODE=external：80／443 由既有代理處理，這裡不改它們的規則。"
  else
    for p in 80 443; do
      if ufw allow "${p}/tcp" >/dev/null 2>&1; then
        ok "ufw 放行 ${p}/tcp（Caddy）"
      else
        req_warn "ufw 放行 ${p}/tcp 失敗，學生可能連不進來。"
      fi
    done
  fi

  FIREWALL_CHANGED=0
  if ufw status 2>/dev/null | head -1 | grep -qi 'inactive'; then
    info "啟用 ufw…"
    if ufw --force enable >/dev/null 2>&1; then
      ok "ufw 已啟用"
      FIREWALL_CHANGED=1
    else
      req_warn "ufw 啟用失敗。"
    fi
  else
    ok "ufw 已啟用"
  fi

  # ── DOCKER-USER：讓 ufw 的「拒絕」對容器也算數 ──
  if (( LOCK_DOCKER_PORTS )); then
    PUBIF="$(ip route show default 2>/dev/null | awk '{print $5}' | head -1)"
    if [[ -z "${PUBIF}" ]]; then
      req_warn "找不到預設路由的網路介面，跳過 DOCKER-USER 規則。"
    else
      AFTER_RULES=/etc/ufw/after.rules
      [[ -f "${AFTER_RULES}" ]] || die "找不到 ${AFTER_RULES}。ufw 的安裝不完整，請 sudo apt-get install --reinstall ufw 後重試。"
      BAK="${AFTER_RULES}.yunzhi-bak-$(date +%Y%m%d-%H%M%S)"
      cp -a "${AFTER_RULES}" "${BAK}"

      # 先把舊的區塊拿掉（冪等：重跑不會疊上去）
      sed -i "/${UFW_MARK_BEGIN}/,/${UFW_MARK_END}/d" "${AFTER_RULES}"

      ALLOWED_PORTS="80,443"
      [[ "${PROXY_MODE}" == "external" ]] && ALLOWED_PORTS=""

      {
        printf '%s\n' "${UFW_MARK_BEGIN}"
        printf '%s\n' "# 由 deploy/scripts/ubuntu-install.sh 產生。手動編輯會在下次安裝時被覆寫。"
        printf '%s\n' "# 移除方式：刪掉本區塊後 sudo ufw reload && sudo systemctl restart docker"
        printf '%s\n' '*filter'
        printf '%s\n' ':DOCKER-USER - [0:0]'
        # 回程封包一律放行，否則容器對外的每一個連線都會在收回應時斷掉
        printf '%s\n' '-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN'
        # **只過濾「從對外介面進來」的封包。** 少了這一行，容器主動
        # 對外的流量（AI API、異地備份、apt）也會經過這條鏈而被 DROP，
        # 症狀是 AI 全部逾時而網路看起來是通的。
        printf '%s\n' "-A DOCKER-USER ! -i ${PUBIF} -j RETURN"
        if [[ -n "${ALLOWED_PORTS}" ]]; then
          printf -- '-A DOCKER-USER -p tcp -m multiport --dports %s -j RETURN\n' "${ALLOWED_PORTS}"
        fi
        # 註解刻意用純 ASCII：iptables 的 comment 模組對非 ASCII
        # 的處理在不同版本之間不一致，而這個字串是後面驗證規則
        # 有沒有套上去的唯一依據。
        printf '%s\n' '-A DOCKER-USER -m comment --comment "yunzhi-docker-user-drop" -j DROP'
        printf '%s\n' 'COMMIT'
        printf '%s\n' "${UFW_MARK_END}"
      } >>"${AFTER_RULES}"

      if cmp -s "${BAK}" "${AFTER_RULES}"; then
        ok "DOCKER-USER 規則已是最新（對外介面 ${PUBIF}）"
        rm -f "${BAK}"
      else
        info "套用 DOCKER-USER 規則（對外介面 ${PUBIF}，放行 ${ALLOWED_PORTS:-無}）…"
        if ufw reload >/dev/null 2>&1 && iptables -S DOCKER-USER 2>/dev/null | grep -q 'yunzhi-docker-user-drop'; then
          ok "容器的連接埠現在也受防火牆約束了"
          dim "SSH 不受影響：它走 INPUT 鏈，DOCKER-USER 只管「轉發到容器」的封包。"
          FIREWALL_CHANGED=1
        else
          err "規則套用失敗，已還原原本的 ${AFTER_RULES}。"
          cp -a "${BAK}" "${AFTER_RULES}"
          ufw reload >/dev/null 2>&1 || true
          req_warn "DOCKER-USER 規則未生效。容器 publish 的埠目前不受 ufw 約束。"
          dim "備份留在 ${BAK}。手動處理見 docs/UBUNTU.md 的「防火牆」一節。"
        fi
      fi
    fi
  else
    warn "已指定 --no-docker-port-lock，容器 publish 的埠不受 ufw 約束。"
    dim "也就是說 compose 檔裡任何一行 ports: 都是對全網開放的，ufw deny 擋不住。"
  fi

  # ufw 啟用／重載會重建 iptables 的內建鏈，Docker 掛在 FORWARD 上的
  # 跳轉可能一起被沖掉 —— 症狀是「容器之間通、對外不通」，而 AI 服務
  # 會變成每一次呼叫都逾時。重啟 Docker 讓它把規則重新插回去。
  #
  # **只在防火牆真的動過時才重啟。** 這支腳本是可重複執行的，而
  # 無條件重啟 Docker 等於每次重跑都讓正在作答的學生斷線一次。
  if (( FIREWALL_CHANGED )); then
    info "防火牆規則有變動，重啟 Docker 讓它把 iptables 規則插回去…"
    if systemctl restart docker; then
      ok "Docker 已重啟"
    else
      req_warn "Docker 重啟失敗，請手動 sudo systemctl restart docker，否則容器可能連不到外面。"
    fi
  else
    ok "防火牆規則沒有變動，不重啟 Docker"
  fi
fi

# ════════════════════════════════════════════════════════════════
step "目錄與權限"
# ════════════════════════════════════════════════════════════════

# 備份目錄。預設是 /var/backups/yunzhi，一般使用者在那底下 mkdir
# 會被拒絕；不先建好的話 Docker 會用 root 幫你建一個，然後宿主機上
# 手動跑的 backup.sh／restore.sh／verify-restore.sh 全部寫不進去 ——
# 而那三支正是「出事那天」才會第一次被執行的腳本。
_bak_owner_before="$(stat -c '%U' "${BACKUP_DIR_VAL}" 2>/dev/null || echo '')"
install -d -m 0750 -o "${TARGET_USER}" -g "${TARGET_GROUP}" "${BACKUP_DIR_VAL}"
if [[ -n "${_bak_owner_before}" && "${_bak_owner_before}" != "${TARGET_USER}" ]]; then
  # 目錄本身改了擁有者還不夠：既有的備份檔是 backup 容器（root）寫的，
  # 檔案權限 0600 root:root。不一起改的話，還原演練與手動還原都會在
  # 「讀不到備份檔」失敗 —— 而那是唯一救得回資料的東西。
  info "既有備份檔的擁有者是 ${_bak_owner_before}，一併改為 ${TARGET_USER}。"
  chown -R "${TARGET_USER}:${TARGET_GROUP}" "${BACKUP_DIR_VAL}" 2>/dev/null || true
fi
ok "備份目錄 ${BACKUP_DIR_VAL}（0750 ${TARGET_USER}:${TARGET_GROUP}）"

# compose 裡每一個 bind mount 的宿主機來源都要先存在且屬於使用者。
# Docker 對不存在的來源不報錯 —— 它以 root 幫你建一個空目錄，
# 於是 upgrade.sh 寫維護頁時 Permission denied（時機正好在
# 備份做完、遷移還沒開始）。
for d in deploy/caddy/certs deploy/caddy/maintenance data/models; do
  install -d -o "${TARGET_USER}" -g "${TARGET_GROUP}" "${YZ_ROOT}/${d}"
done
# AI 容器以 uid 10001 執行，而 bind mount 沿用宿主機的擁有者。
# 不放寬的話字形對照快取寫不進去，而 save_cache 包在 try/except 裡
# 不會報錯 —— 每一份出版社講義都會重新付費問一次視覺模型。
chmod 0777 "${YZ_ROOT}/data/models"
ok "掛載點就緒（deploy/caddy/certs、maintenance、data/models）"

if [[ -f "${YZ_ROOT}/.env" ]]; then
  chown "${TARGET_USER}:${TARGET_GROUP}" "${YZ_ROOT}/.env"
  chmod 600 "${YZ_ROOT}/.env"
  ok ".env 權限 600，擁有者 ${TARGET_USER}"
fi

# 日誌與狀態目錄。common.sh 用得到，而一般使用者建不出 /var/lib 下的東西。
install -d -m 0755 -o "${TARGET_USER}" -g "${TARGET_GROUP}" /var/log/yunzhi /var/lib/yunzhi

# ════════════════════════════════════════════════════════════════
step "開機自動啟動"
# ════════════════════════════════════════════════════════════════

UNIT_SRC="${YZ_DEPLOY_DIR}/systemd/yunzhi-docker.service"
UNIT_DST=/etc/systemd/system/yunzhi-docker.service

if [[ -f "${UNIT_SRC}" ]]; then
  sed -e "s|__YZ_ROOT__|${YZ_ROOT}|g" \
      -e "s|__YZ_USER__|${TARGET_USER}|g" \
      -e "s|__YZ_GROUP__|${TARGET_GROUP}|g" \
      "${UNIT_SRC}" >"${UNIT_DST}"
  systemctl daemon-reload
  systemctl enable yunzhi-docker.service >/dev/null 2>&1 \
    && ok "yunzhi-docker.service 已設為開機啟動" \
    || req_warn "無法 enable yunzhi-docker.service。"
  dim "它補的是 restart: unless-stopped 補不到的那一半："
  dim "有人下過一次 docker compose stop 之後，重開機不會自己回來。"
else
  req_warn "找不到 ${UNIT_SRC}，跳過開機自動啟動設定。"
fi

# ════════════════════════════════════════════════════════════════
step "安裝應用"
# ════════════════════════════════════════════════════════════════

# **刻意不加 --skip-preflight。**
# 上面做的是「這台機器能不能跑 Docker」，preflight 做的是「這份設定
# 能不能上線」（AUTH_SECRET 長度、範例值沒改、TLS 兩個變數是否一致、
# 備份加密金鑰有沒有產生）。兩者沒有重疊到可以省掉任何一邊 ——
# 硬體項目重複報幾行，換掉的是「設定錯了但要等學生登入才發現」。
INSTALL_ARGS=()
if (( OFFLINE ));         then INSTALL_ARGS+=(--offline); fi
if (( WITH_MONITORING )); then INSTALL_ARGS+=(--monitoring); fi
if [[ "${YZ_ASSUME_YES:-0}" == "1" ]]; then INSTALL_ARGS+=(--yes); fi

# 部署鎖檔。之前若有人以 root 跑過任何一支腳本，它會是 root:root 644，
# 而 acquire_lock 用 `exec 9>` 開它 —— 一般使用者開不了寫入，
# 於是安裝在第一行就以「Permission denied」結束，訊息裡完全看不出
# 是一個 /tmp 底下的鎖檔造成的。
if [[ -e "${YZ_LOCK_FILE}" ]]; then
  chown "${TARGET_USER}:${TARGET_GROUP}" "${YZ_LOCK_FILE}" 2>/dev/null || true
fi

info "系統層的檢查上面已經做完，這裡直接進安裝流程。"
echo

# **以目標使用者身分執行，不是 root。** 這樣 .env、data/、
# 以及 compose 建立的所有東西都歸他，日後維運不必 sudo。
if ! as_user "${YZ_SCRIPTS_DIR}/docker-install.sh" "${INSTALL_ARGS[@]}"; then
  err "應用安裝失敗。"
  dim "系統層的東西（Docker、防火牆、開機啟動）都已經設好了，"
  dim "修完問題之後可以只重跑後半段："
  dim "  sudo -u ${TARGET_USER} ./deploy/scripts/docker-install.sh"
  dim ""
  dim "先看這幾個："
  dim "  docker compose ps"
  dim "  docker compose logs --tail 100 web"
  dim "  ./deploy/scripts/doctor.sh"
  exit 1
fi

# ════════════════════════════════════════════════════════════════
section "驗收"
#
# 安裝腳本自己也驗過一次，這裡再驗一次的理由是**視角不同**：
# 它驗的是「容器內部覺得自己好了」，這裡驗的是「從宿主機打得通」。
# 兩者之間差一整層網路設定，而防火牆規則正是這一步剛改過的東西。
# ════════════════════════════════════════════════════════════════

verify_fail=0
probe() {
  local name="$1" url="$2" expect="$3"
  local body
  if body="$(curl -fsS --max-time 10 "${url}" 2>/dev/null)" && grep -q "${expect}" <<<"${body}"; then
    ok "${name}：${body:0:100}"
  else
    err "${name} 沒有通過（${url}）"
    verify_fail=1
  fi
}

probe "存活檢查 healthz" "http://127.0.0.1:${WEB_BIND_PORT_VAL}/api/healthz" '"alive":true'
probe "就緒檢查 readyz"  "http://127.0.0.1:${WEB_BIND_PORT_VAL}/api/readyz"  '"ready":true'
probe "版本 version"     "http://127.0.0.1:${WEB_BIND_PORT_VAL}/api/version"  'appVersion'

if [[ "${PROXY_MODE}" != "external" ]]; then
  # Caddy 那一層。憑證在 internal 模式下是本地 CA 簽的，所以 -k。
  if curl -fsSk --max-time 10 -o /dev/null "https://127.0.0.1/api/healthz" 2>/dev/null; then
    ok "Caddy 的 HTTPS 通了"
  else
    warn "從宿主機打 https://127.0.0.1 沒有通。"
    dim "letsencrypt 模式下這是正常的（憑證綁網域，還沒簽好）。"
    dim "internal／custom 模式下請看：docker compose logs caddy"
  fi
fi

if (( verify_fail )); then
  err "驗收沒有全過。系統可能還在啟動，也可能真的有問題。"
  dim "  ./deploy/scripts/doctor.sh          # 一次跑完所有健檢"
  dim "  docker compose logs --tail 100 web"
  exit 1
fi

# ════════════════════════════════════════════════════════════════
ADMIN_USER="$(env_get_value BOOTSTRAP_ADMIN_USERNAME)"
ADMIN_PASS="$(env_get_value BOOTSTRAP_ADMIN_PASSWORD)"

echo
cat <<EOF
  ╔══════════════════════════════════════════════════════════╗
  ║  安裝完成                                                 ║
  ╚══════════════════════════════════════════════════════════╝

  登入網址    ${APP_URL_VAL}
  管理帳號    ${ADMIN_USER:-admin}
  初始密碼    ${ADMIN_PASS:-（見 .env 的 BOOTSTRAP_ADMIN_PASSWORD）}

  首次登入會強制更換密碼。換完之後把 .env 裡的
  BOOTSTRAP_ADMIN_PASSWORD 清空。

  操作手冊    docs/UBUNTU.md
  健康檢查    ./deploy/scripts/doctor.sh
  日誌        docker compose logs -f web
  備份        ./deploy/scripts/backup.sh
  升級        ./deploy/scripts/upgrade.sh
  回滾        ./deploy/scripts/rollback.sh

EOF

warn "接下來請務必做這三件事："
dim "1. 重新登入一次（exit 再 ssh 進來），docker 群組才會對你的 shell 生效。"
dim "2. 把 .env 備份到密碼管理器或離線儲存。"
dim "   遺失 BACKUP_ENCRYPTION_KEY 等於所有加密備份作廢，沒有救援途徑。"
dim "3. 跑一次還原演練並記錄 RTO：./deploy/scripts/verify-restore.sh"
dim "   未驗證過的備份等於沒有備份。"
echo

if [[ "${PROXY_MODE}" == "external" ]]; then
  warn "PROXY_MODE=external：還差最後一步，設定 nginx 把流量轉進來。"
  dim "  sudo ./deploy/scripts/setup-nginx.sh"
  echo
fi
