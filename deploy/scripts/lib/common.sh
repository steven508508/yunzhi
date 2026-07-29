#!/usr/bin/env bash
# 雲端智學 — 部署腳本共用函式庫
#
# 所有腳本 source 這一份。集中的理由不只是少寫幾行：
# 訊息格式、錯誤處理、確認提示、鎖的取得方式如果每個腳本
# 各寫一套，維運人員就得記住每一支腳本的脾氣。

set -Eeuo pipefail

# ── 路徑 ────────────────────────────────────────────────────────
# BASH_SOURCE[0] 是本檔，往上兩層是 deploy/，再一層是專案根目錄。
YZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YZ_SCRIPTS_DIR="$(cd "${YZ_LIB_DIR}/.." && pwd)"
YZ_DEPLOY_DIR="$(cd "${YZ_SCRIPTS_DIR}/.." && pwd)"
YZ_ROOT="$(cd "${YZ_DEPLOY_DIR}/.." && pwd)"
export YZ_ROOT YZ_DEPLOY_DIR YZ_SCRIPTS_DIR

readonly YZ_STATE_DIR="${YZ_STATE_DIR:-/var/lib/yunzhi}"
readonly YZ_LOG_DIR="${YZ_LOG_DIR:-/var/log/yunzhi}"
readonly YZ_LOCK_FILE="${YZ_LOCK_FILE:-/tmp/yunzhi-deploy.lock}"

# ── 顏色（非 TTY 時自動關閉，避免污染日誌檔） ──────────────────
if [[ -t 1 ]] && [[ "${NO_COLOR:-}" != "1" ]]; then
  readonly C_RESET=$'\033[0m'  C_DIM=$'\033[2m'   C_BOLD=$'\033[1m'
  readonly C_RED=$'\033[31m'   C_GREEN=$'\033[32m'
  readonly C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m'
else
  readonly C_RESET='' C_DIM='' C_BOLD='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE=''
fi

# ── 訊息 ────────────────────────────────────────────────────────
_ts() { date '+%Y-%m-%d %H:%M:%S'; }

log()   { printf '%s %s\n'      "$(_ts)" "$*"; }
info()  { printf '%s %s→%s %s\n' "$(_ts)" "${C_BLUE}"   "${C_RESET}" "$*"; }
ok()    { printf '%s %s✓%s %s\n' "$(_ts)" "${C_GREEN}"  "${C_RESET}" "$*"; }
warn()  { printf '%s %s!%s %s\n' "$(_ts)" "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
err()   { printf '%s %s✗%s %s\n' "$(_ts)" "${C_RED}"    "${C_RESET}" "$*" >&2; }
dim()   { printf '  %s%s%s\n' "${C_DIM}" "$*" "${C_RESET}"; }

die() { err "$*"; exit 1; }

section() {
  printf '\n%s%s%s\n' "${C_BOLD}" "── $* ────────────────────────────────────────" "${C_RESET}"
}

# ── 錯誤追蹤 ────────────────────────────────────────────────────
# 沒有這個的話，腳本在第 200 行的某個 pipe 裡失敗只會印一行
# 「Command failed」，維運人員完全不知道發生什麼事。
_on_err() {
  local exit_code=$?
  local line=${1:-?}
  err "腳本在第 ${line} 行失敗（結束碼 ${exit_code}）"
  err "指令：${BASH_COMMAND}"
  if [[ -n "${YZ_ERROR_HINT:-}" ]]; then
    warn "${YZ_ERROR_HINT}"
  fi
  exit "${exit_code}"
}
trap '_on_err ${LINENO}' ERR

# ── 互斥鎖 ──────────────────────────────────────────────────────
# 備份與升級同時跑會產生一份「升級到一半」的備份，
# 那種備份在還原時比沒有備份更糟 —— 它看起來是有效的。
#
# **必須是可重入的。** 這些腳本會互相呼叫：
#   verify-restore.sh → restore.sh
#   upgrade.sh        → backup.sh
#   uninstall.sh      → backup.sh
#   restore.sh        → backup.sh（安全備份）
# 若不可重入，這四條路徑全部會卡在自己持有的鎖上 —— 而且症狀是
# 「另一個部署操作正在進行中」這種完全誤導人的訊息。
#
# 作法是把持有狀態放在環境變數中，子行程繼承後直接通過。
# 用 PID 而非單純的布林值，是為了讓「同一棵行程樹」與
# 「剛好殘留的環境變數」能被區分開。
acquire_lock() {
  local what="${1:-操作}"

  if [[ -n "${YZ_LOCK_HELD_BY:-}" ]]; then
    # 已由上層腳本持有。確認那個 PID 還活著，避免殘留的
    # 環境變數讓真正的併發保護失效。
    if kill -0 "${YZ_LOCK_HELD_BY}" 2>/dev/null; then
      YZ_LOCK_DEPTH=$(( ${YZ_LOCK_DEPTH:-1} + 1 ))
      export YZ_LOCK_DEPTH
      return 0
    fi
    unset YZ_LOCK_HELD_BY YZ_LOCK_DEPTH
  fi

  exec 9>"${YZ_LOCK_FILE}"
  if ! flock -n 9; then
    local holder
    holder="$(cat "${YZ_LOCK_FILE}" 2>/dev/null || echo '未知')"
    die "另一個部署操作正在進行中（${holder}）。等它結束，或確認無誤後刪除 ${YZ_LOCK_FILE}"
  fi
  printf '%s pid=%s %s\n' "$(_ts)" "$$" "${what}" >&9

  export YZ_LOCK_HELD_BY="$$"
  export YZ_LOCK_DEPTH=1
}

# ── 確認 ────────────────────────────────────────────────────────
# 破壞性操作一律要求輸入完整詞句而不是 y/N。
# y/N 太容易在半自動的操作中被連按過去。
confirm_phrase() {
  local prompt="$1" required="$2"
  if [[ "${YZ_ASSUME_YES:-0}" == "1" ]]; then
    warn "已指定 --yes，跳過確認：${prompt}"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    die "此操作需要互動確認，但目前不是互動終端。若確定要執行，請加上 --yes。"
  fi
  printf '\n%s%s%s\n' "${C_YELLOW}${C_BOLD}" "${prompt}" "${C_RESET}"
  printf '請輸入 %s%s%s 以繼續（其他任何輸入都會取消）：' "${C_BOLD}" "${required}" "${C_RESET}"
  local answer
  read -r answer
  [[ "${answer}" == "${required}" ]] || die "已取消。"
}

# ── 環境檔 ──────────────────────────────────────────────────────
load_env() {
  local file="${1:-${YZ_ROOT}/.env}"
  [[ -f "${file}" ]] || die "找不到設定檔 ${file}。請先執行：cp .env.example .env && ./deploy/scripts/gen-secrets.sh"

  # 權限檢查。.env 含資料庫密碼與 AI API key，
  # 644 等於同一台機器上的任何使用者都讀得到。
  local perms
  perms="$(stat -c '%a' "${file}" 2>/dev/null || stat -f '%Lp' "${file}")"
  if [[ "${perms}" != "600" && "${perms}" != "400" ]]; then
    warn ".env 的權限是 ${perms}，含有密碼與金鑰。正在收緊為 600。"
    chmod 600 "${file}"
  fi

  set -a
  # shellcheck disable=SC1090
  source "${file}"
  set +a
}

require_env() {
  local missing=()
  for v in "$@"; do
    [[ -n "${!v:-}" ]] || missing+=("${v}")
  done
  if ((${#missing[@]})); then
    err "以下設定為必填但目前是空的："
    printf '    %s\n' "${missing[@]}" >&2
    die "請編輯 .env 後重試。"
  fi
}

# 讀 .env 裡某個變數的**字面值**（不 source 整個檔）。
#
# 需要它的場合是「還不能 source .env」的時候：例如要先看
# PROXY_MODE 才決定要不要檢查 80／443，而 source 會把整份設定
# （含 TZ）灌進當前 shell，讓同一次執行的日誌時間戳在中途跳掉。
env_get_value() {
  local key="$1" file="${2:-${YZ_ROOT}/.env}"
  [[ -f "${file}" ]] || return 0
  local raw
  raw="$(grep -E "^${key}=" "${file}" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  # 去掉包住整個值的引號（compose 的 env-file 解析也是這樣處理）
  raw="${raw%$'\r'}"
  if [[ "${raw}" == \"*\" ]]; then raw="${raw:1:${#raw}-2}"; fi
  if [[ "${raw}" == \'*\' ]]; then raw="${raw:1:${#raw}-2}"; fi
  printf '%s' "${raw}"
}

# 就地改寫 .env 的某一行（沒有那一行就補在檔尾）。
#
# **一定要寫回檔案，不能只 export。** docker compose 的變數展開
# 雖然讓 shell 環境優先於 --env-file，但使用者之後手動下
# `docker compose up -d` 時沒有那個 shell 環境 —— 只有 .env。
# 只 export 的設定會在「安裝時是對的、下次重啟就變了」，
# 而那種故障沒有人會聯想到安裝腳本。
env_set_value() {
  local key="$1" value="$2" file="${3:-${YZ_ROOT}/.env}"
  [[ -f "${file}" ]] || die "找不到 ${file}"

  # **含空白的值一定要加引號。**
  #
  # load_env 是用 `set -a; source .env` 讀設定的，也就是說 .env 會被
  # bash 當成腳本執行。`TLS_DIRECTIVE=/a/fullchain.pem /a/privkey.pem`
  # 這一行在 bash 眼裡是「把 TLS_DIRECTIVE 設成 /a/fullchain.pem，
  # 然後執行 /a/privkey.pem 這個指令」—— command not found，而
  # common.sh 開著 errexit，於是**每一支腳本**（doctor、backup、
  # upgrade、restore）都在載入設定的那一行死掉。
  # TLS_MODE=custom 的機器會是這樣：安裝當下沒事，之後所有維運工具
  # 全部打不開，而錯誤訊息指向一個憑證檔的路徑。
  if [[ "${value}" == *[[:space:]]* && "${value}" != \"*\" ]]; then
    value="\"${value//\"/\\\"}\""
  fi

  if grep -qE "^${key}=" "${file}"; then
    # 用 | 當分隔符並跳脫，避免值裡的 / 或 & 破壞 sed
    local escaped="${value//\\/\\\\}"
    escaped="${escaped//|/\\|}"
    escaped="${escaped//&/\\&}"
    sed -i "s|^${key}=.*|${key}=${escaped}|" "${file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >>"${file}"
  fi
}

# ── 工具檢查 ────────────────────────────────────────────────────
need_cmd() {
  local missing=()
  for c in "$@"; do
    command -v "${c}" >/dev/null 2>&1 || missing+=("${c}")
  done
  if ((${#missing[@]})); then
    err "缺少必要指令：${missing[*]}"
    dim "Ubuntu 安裝方式：sudo apt-get install -y ${missing[*]}"
    return 1
  fi
}

need_root() {
  [[ "${EUID}" -eq 0 ]] || die "此操作需要 root 權限。請用 sudo 執行。"
}

# ── Docker Compose ──────────────────────────────────────────────
compose() {
  ( cd "${YZ_ROOT}" && docker compose --env-file .env "$@" )
}

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

# ── 部署模式偵測與資料庫存取抽象 ────────────────────────────────
#
# 備份、還原、診斷這幾支腳本兩種部署都要能用。若各自寫死
# `compose exec postgres …`，原生安裝就整組壞掉 —— 而那是
# 只有在真的需要還原的那一天才會被發現的壞掉。
#
# 所以資料庫存取一律走下面三個包裝函式，不直接呼叫 psql 或
# docker compose。

detect_mode() {
  if [[ -n "${YZ_MODE:-}" ]]; then
    printf '%s' "${YZ_MODE}"
  elif [[ -f /etc/systemd/system/yunzhi-web.service ]]; then
    printf 'native'
  elif docker ps --filter 'name=yunzhi-postgres' --format '{{.Names}}' 2>/dev/null | grep -q .; then
    printf 'docker'
  elif [[ -f "${YZ_ROOT}/docker-compose.yml" ]] && docker_available; then
    printf 'docker'
  else
    printf 'native'
  fi
}

# 在資料庫所在處執行任意指令（psql / pg_dump / pg_restore / tar…）
# stdin 與 stdout 都會正確接通，讓 pg_dump 可以直接導向檔案。
pg_exec() {
  local mode; mode="$(detect_mode)"
  if [[ "${mode}" == "docker" ]]; then
    compose exec -T postgres "$@"
  else
    PGPASSWORD="${POSTGRES_PASSWORD}" PGHOST="${POSTGRES_HOST:-127.0.0.1}" \
      PGPORT="${POSTGRES_PORT:-5432}" "$@"
  fi
}

# 單句查詢，回傳純值（-tA）
pg_scalar() {
  local db="${2:-${POSTGRES_DB}}"
  pg_exec psql -U "${POSTGRES_USER}" -d "${db}" -tAc "$1" 2>/dev/null | tr -d '\r'
}

# 單句查詢，**跨所有租戶**。
#
# 業務資料表全部開著 RLS（ENABLE ＋ FORCE），而 FORCE 的意思是
# **連表格擁有者也逃不掉**。POSTGRES_USER 正是擁有者，所以維運腳本
# 用 pg_scalar 去數 attempts 或 ai_usage_logs，拿到的一律是 0 ——
# 不報錯、不警告，看起來就像「現在沒有人在考試」。
#
# 這是最危險的一種錯：升級腳本的「有人在考試就不升級」照這條路寫，
# 會永遠放行。所以維運層要數業務資料時一律走這一支。
#
# app.cross_tenant 是 tools/tenancy.mjs 定義的逃生口，設計上就是給
# 「不屬於任何一家補習班」的程式用的（背景工作者、遷移、備份）。
# 維運腳本屬於同一類。tools/rls-check.mjs 只掃 .ts/.mjs/.js/.sql，
# 不掃 shell，所以這裡不會被它擋——但理由要寫下來，不是因為掃不到。
#
# `SET` 自己也會在 stdout 印一行命令標籤，所以要 tail -1。
# 查詢失敗時（表不存在、連不上）留下的是那個 "SET" 字串而不是數字，
# 呼叫端必須用 `=~ ^[0-9]+$` 判斷，不可以直接當數字用。
pg_scalar_all_tenants() {
  local db="${2:-${POSTGRES_DB}}"
  pg_exec psql -U "${POSTGRES_USER}" -d "${db}" \
    -tAc "SET app.cross_tenant='on'; $1" 2>/dev/null | tr -d '\r' | tail -1
}

# 資料庫所在處的 shell（用於 tar 傳輸等）
pg_sh() {
  local mode; mode="$(detect_mode)"
  if [[ "${mode}" == "docker" ]]; then
    compose exec -T postgres sh -c "$1"
  else
    sh -c "$1"
  fi
}

# MinIO 所在處的 shell
s3_sh() {
  local mode; mode="$(detect_mode)"
  if [[ "${mode}" == "docker" ]]; then
    compose exec -T minio sh -c "$1"
  else
    sh -c "$1"
  fi
}

# 以資料庫超級使用者身分執行。
#
# 需要它的唯一場合是**建立擴充功能**：pgvector 不是 trusted
# extension，只有超級使用者能 CREATE EXTENSION。應用帳號刻意
# 不給超級使用者權限（那等於把整台資料庫交出去），所以還原到
# 一個全新的資料庫時，擴充功能必須由這條路徑建立。
#
# docker 模式下 POSTGRES_USER 本來就是超級使用者；
# 原生模式下走 `sudo -u postgres`（備份與還原腳本以 root 執行）。
pg_super_exec() {
  local mode; mode="$(detect_mode)"
  if [[ "${mode}" == "docker" ]]; then
    compose exec -T postgres "$@"
  elif [[ "${EUID}" -eq 0 ]] && id -u postgres >/dev/null 2>&1; then
    # 連線參數必須明確傳遞。少了 PGHOST/PGPORT，sudo 會用 postgres
    # 帳號的預設 socket（5432），在非預設連接埠或多實例的機器上
    # 就會連到**錯誤的資料庫**並靜默地做錯事。
    sudo -u postgres \
      PGHOST="${POSTGRES_HOST:-127.0.0.1}" \
      PGPORT="${POSTGRES_PORT:-5432}" \
      "$@"
  else
    # 不是 root 就沒辦法。回非零讓呼叫端給出可行的建議，
    # 而不是丟一個看不懂的 permission denied。
    return 127
  fi
}

# 在指定資料庫中建立系統需要的擴充功能。
#
# **逐一建立並逐一檢查。** 把兩個 -c 串在一起時，psql 的結束碼
# 只反映最後一句，第一句失敗會被完全吃掉 —— 結果是回報成功、
# 但 vector 其實沒建起來，然後在還原真正的資料時才爆掉。
ensure_extensions() {
  local db="$1" ext rc=0
  for ext in vector pg_trgm; do
    if pg_super_exec psql -d "${db}" -q -c "CREATE EXTENSION IF NOT EXISTS ${ext};" >/dev/null 2>&1; then
      continue
    fi
    # 退而求其次：應用帳號可能本身就是超級使用者（docker 預設如此）
    if pg_exec psql -U "${POSTGRES_USER}" -d "${db}" -q \
         -c "CREATE EXTENSION IF NOT EXISTS ${ext};" >/dev/null 2>&1; then
      continue
    fi
    warn "無法在 ${db} 建立擴充功能 ${ext}"
    rc=1
  done
  return "${rc}"
}

# 把本機檔案搬到資料庫看得到的位置，並回傳它在那一側的路徑。
#
# 存在的理由：`pg_restore --jobs` 不支援從 stdin 讀取
# （"parallel restore from standard input is not supported"），
# 而平行還原正是把 RTO 壓在承諾範圍內的關鍵。所以還原時必須
# 給檔案路徑而不是管線 —— docker 模式下就得先把檔案送進容器。
pg_stage_file() {
  local local_path="$1"
  local mode; mode="$(detect_mode)"
  if [[ "${mode}" == "docker" ]]; then
    local remote="/tmp/yunzhi-stage-$$.dump"
    ( cd "${YZ_ROOT}" && docker compose --env-file .env cp "${local_path}" "postgres:${remote}" ) >/dev/null
    printf '%s' "${remote}"
  else
    printf '%s' "${local_path}"
  fi
}

pg_unstage_file() {
  local remote="$1"
  [[ "$(detect_mode)" == "docker" ]] || return 0
  compose exec -T postgres rm -f "${remote}" >/dev/null 2>&1 || true
}

# ── 應用服務啟停（兩種模式共用介面） ────────────────────────────
#
# 還原、升級、回滾都要先停應用再重啟。若寫死 docker compose，
# 原生安裝會在還原「成功之後」才失敗，留下一個資料已還原、
# 但服務停著的狀態 —— 那是最糟的失敗時機。
YZ_APP_SERVICES=(web worker ai)

app_stop() {
  local mode; mode="$(detect_mode)"
  if [[ "${mode}" == "docker" ]]; then
    compose stop "${YZ_APP_SERVICES[@]}" >/dev/null 2>&1 || true
  else
    local u
    for u in yunzhi-web yunzhi-worker yunzhi-ai; do
      systemctl list-unit-files 2>/dev/null | grep -q "^${u}" || continue
      systemctl stop "${u}" >/dev/null 2>&1 || true
    done
  fi
}

app_start() {
  local mode; mode="$(detect_mode)"
  if [[ "${mode}" == "docker" ]]; then
    compose up -d "${YZ_APP_SERVICES[@]}" >/dev/null 2>&1 || warn "重啟應用失敗，請手動檢查。"
  else
    local u
    for u in yunzhi-ai yunzhi-web yunzhi-worker; do
      systemctl list-unit-files 2>/dev/null | grep -q "^${u}" || continue
      systemctl start "${u}" >/dev/null 2>&1 || warn "啟動 ${u} 失敗。"
    done
  fi
}

# WAL 歸檔目錄，兩種模式位置不同
wal_archive_dir() {
  if [[ "$(detect_mode)" == "docker" ]]; then
    printf '/var/lib/postgresql/wal_archive'
  else
    printf '%s' "${WAL_ARCHIVE_DIR:-/var/lib/yunzhi/wal_archive}"
  fi
}

# ── 隨機密碼 ────────────────────────────────────────────────────
# 用 /dev/urandom 而非 $RANDOM。$RANDOM 的種子只有 32 位元，
# 對密碼來說形同沒有隨機性。
#
# 注意這裡刻意**先讀固定長度再過濾**，而不是
#   tr -dc ... < /dev/urandom | head -c N
# 後者在 head 讀滿之後會對 tr 送 SIGPIPE，而本函式庫開了
# pipefail，SIGPIPE 會讓整支腳本以 141 結束 —— 那是一個
# 只在某些機器上偶發、非常難查的失敗。
gen_password() {
  local len="${1:-32}" out=''
  while (( ${#out} < len )); do
    # 取 4 倍長度的原始位元組，過濾後平均可得約 1.5 倍，
    # 極少需要第二輪。
    out+="$(head -c "$((len * 4))" /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' || true)"
  done
  printf '%s' "${out:0:len}"
}

gen_hex() {
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "${bytes}"
  else
    head -c "${bytes}" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# ── 磁碟與資源 ──────────────────────────────────────────────────
disk_free_gb() {
  local path="${1:-/}"
  df -BG --output=avail "${path}" 2>/dev/null | tail -1 | tr -dc '0-9'
}

mem_total_gb() {
  awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0
}

cpu_count() {
  nproc 2>/dev/null || echo 1
}

# ── 服務等待 ────────────────────────────────────────────────────
# 沒有這個，安裝腳本會在服務還沒起來時就宣告成功，
# 使用者打開瀏覽器看到 502 而不知道是還沒好還是壞了。
wait_for_http() {
  local url="$1" timeout="${2:-120}" what="${3:-服務}"
  local waited=0 interval=3
  info "等待 ${what} 就緒（最多 ${timeout} 秒）…"
  while ((waited < timeout)); do
    if curl -fsS -o /dev/null --max-time 5 "${url}" 2>/dev/null; then
      ok "${what} 已就緒（等待 ${waited} 秒）"
      return 0
    fi
    sleep "${interval}"
    waited=$((waited + interval))
    if ((waited % 15 == 0)); then
      dim "仍在等待…（${waited}/${timeout} 秒）"
    fi
  done
  err "${what} 在 ${timeout} 秒內未就緒：${url}"
  return 1
}

# ── 大小格式化 ──────────────────────────────────────────────────
human_size() {
  local bytes="${1:-0}"
  numfmt --to=iec --suffix=B "${bytes}" 2>/dev/null || echo "${bytes}B"
}
