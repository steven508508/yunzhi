#!/usr/bin/env bash
# 雲端智學 — 產生 .env 中所有標示 [自動] 的密碼與金鑰
#
# 預設**只填空白欄位**，已經有值的一律不動 —— 這讓它可以在
# 升級後安全地重跑（.env.example 新增了欄位時），而不會把
# 正在用的資料庫密碼換掉導致連不上。
#
# 用法：
#   ./deploy/scripts/gen-secrets.sh              # 補齊空白欄位
#   ./deploy/scripts/gen-secrets.sh --rotate AUTH_SECRET
#   ./deploy/scripts/gen-secrets.sh --show       # 只顯示哪些還沒填

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ENV_FILE="${YZ_ROOT}/.env"
ROTATE=()
SHOW_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rotate) ROTATE+=("$2"); shift 2 ;;
    --show) SHOW_ONLY=1; shift ;;
    --file) ENV_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ -f "${YZ_ROOT}/.env.example" ]]; then
    info "找不到 .env，從 .env.example 複製一份。"
    cp "${YZ_ROOT}/.env.example" "${ENV_FILE}"
    chmod 600 "${ENV_FILE}"
  else
    die "找不到 ${ENV_FILE} 也找不到 .env.example。"
  fi
fi

chmod 600 "${ENV_FILE}"

# 待產生的欄位與長度。
# AUTH_SECRET 用 hex 而非英數混合，因為某些部署環境會把 .env
# 的值再經過一層 shell 展開，特殊字元容易出事。
declare -A FIELDS=(
  [POSTGRES_PASSWORD]="pass:32"
  [REDIS_PASSWORD]="pass:32"
  [S3_SECRET_KEY]="pass:40"
  [AUTH_SECRET]="hex:32"
  [BACKUP_ENCRYPTION_KEY]="hex:32"
  [GRAFANA_ADMIN_PASSWORD]="pass:24"
)

get_value() {
  # 取出 KEY= 之後的內容，忽略註解行
  grep -E "^${1}=" "${ENV_FILE}" 2>/dev/null | head -1 | cut -d= -f2- || true
}

set_value() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "${ENV_FILE}"; then
    # 用 | 當分隔符並跳脫，避免值裡的 / 或 & 破壞 sed
    local escaped="${value//\\/\\\\}"
    escaped="${escaped//|/\\|}"
    escaped="${escaped//&/\\&}"
    sed -i "s|^${key}=.*|${key}=${escaped}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >>"${ENV_FILE}"
  fi
}

if (( SHOW_ONLY )); then
  section "設定狀態"
  for key in "${!FIELDS[@]}"; do
    v="$(get_value "${key}")"
    if [[ -z "${v}" ]]; then
      warn "${key} 未設定"
    else
      ok "${key} 已設定（${#v} 字元）"
    fi
  done
  exit 0
fi

# ── 輪替 ────────────────────────────────────────────────────────
if ((${#ROTATE[@]})); then
  section "輪替金鑰"
  for key in "${ROTATE[@]}"; do
    [[ -n "${FIELDS[${key}]:-}" ]] || die "${key} 不是可自動產生的欄位。可用：${!FIELDS[*]}"

    case "${key}" in
      AUTH_SECRET)
        warn "輪替 AUTH_SECRET 會讓所有使用者立即被登出。"
        warn "**不要在考試進行中做這件事** —— 學生會在作答途中被踢出。"
        ;;
      POSTGRES_PASSWORD|REDIS_PASSWORD|S3_SECRET_KEY)
        warn "輪替 ${key} 需要同步更新已在執行的服務。"
        warn "正確順序是：先改資料庫端的密碼，再改 .env，最後重啟。"
        warn "只改 .env 會讓服務連不上。詳見 docs/OPERATIONS.md 的金鑰輪替一節。"
        ;;
      BACKUP_ENCRYPTION_KEY)
        err "輪替 BACKUP_ENCRYPTION_KEY 會讓**所有既有備份無法解密**。"
        err "舊金鑰請務必另行保存，否則那些備份等於作廢。"
        ;;
    esac
  done
  confirm_phrase "以上金鑰將被替換為新值。" "ROTATE"
fi

# ── 產生 ────────────────────────────────────────────────────────
section "產生密碼與金鑰"

generated=0
skipped=0

for key in "${!FIELDS[@]}"; do
  spec="${FIELDS[${key}]}"
  kind="${spec%%:*}"
  len="${spec##*:}"

  current="$(get_value "${key}")"
  should_rotate=0
  for r in "${ROTATE[@]:-}"; do [[ "${r}" == "${key}" ]] && should_rotate=1; done

  if [[ -n "${current}" ]] && (( ! should_rotate )); then
    skipped=$((skipped + 1))
    continue
  fi

  case "${kind}" in
    pass) value="$(gen_password "${len}")" ;;
    hex)  value="$(gen_hex "${len}")" ;;
    *)    die "內部錯誤：不認得的類型 ${kind}" ;;
  esac

  set_value "${key}" "${value}"
  ok "${key} 已產生（${#value} 字元）"
  generated=$((generated + 1))
done

(( skipped > 0 )) && dim "${skipped} 個欄位已有值，未變更。"

# ── 初始管理員密碼 ──────────────────────────────────────────────
admin_pw="$(get_value BOOTSTRAP_ADMIN_PASSWORD)"
if [[ -z "${admin_pw}" ]]; then
  admin_pw="$(gen_password 16)"
  set_value BOOTSTRAP_ADMIN_PASSWORD "${admin_pw}"
  echo
  printf '%s\n' "${C_BOLD}════════════════════════════════════════════════════════${C_RESET}"
  printf '%s\n' " 初始管理員密碼（只會顯示這一次）"
  printf '%s\n' "════════════════════════════════════════════════════════"
  printf '   帳號：%s\n' "$(get_value BOOTSTRAP_ADMIN_USERNAME)"
  printf '   密碼：%s%s%s\n' "${C_BOLD}" "${admin_pw}" "${C_RESET}"
  printf '%s\n' "════════════════════════════════════════════════════════"
  printf '%s\n' " 首次登入後系統會**強制**你更換密碼。"
  printf '%s\n' " 更換之後，建議把 .env 中的 BOOTSTRAP_ADMIN_PASSWORD 清空。"
  printf '%s\n\n' "════════════════════════════════════════════════════════"
fi

chmod 600 "${ENV_FILE}"

echo
ok "完成。產生 ${generated} 項。"
dim "設定檔：${ENV_FILE}（權限已設為 600）"
echo
warn "請立刻把 .env 備份到安全的地方（密碼管理器或離線儲存）。"
warn "遺失 BACKUP_ENCRYPTION_KEY 等於所有加密備份作廢，沒有救援途徑。"
