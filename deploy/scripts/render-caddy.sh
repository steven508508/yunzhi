#!/usr/bin/env bash
# 雲端智學 — 由 TLS_MODE 產生 Caddy 的 tls 指示詞（TLS_DIRECTIVE）
#
# **為什麼需要這一支腳本**
#
# Caddyfile 不支援條件式，所以整個 `tls …` 指示詞是用環境變數
# `{$TLS_DIRECTIVE}` 展開的。也就是說 .env 裡有兩個變數描述同一件事：
#
#   TLS_MODE=letsencrypt      ← 人看的、文件教你改的
#   TLS_DIRECTIVE=internal    ← Caddy 真正讀的
#
# 這兩個沒有任何機制保證一致。而 docs/INSTALL.md 教使用者把
# TLS_MODE 改成 letsencrypt —— 改完之後 TLS_DIRECTIVE 還是
# .env.example 出廠的 internal，於是 Caddy 用**本地 CA** 簽了一張
# 憑證發出去。結果是：
#
#   · 服務起得來、healthz／readyz 全綠、doctor.sh 全過
#   · 每一台學生電腦打開網站都看到「你的連線不是私人連線」
#   · 沒有任何一行日誌說哪裡錯了
#
# 開學第一天全校連不進來，而維護老師手上的所有檢查工具都說正常。
# 所以這件事必須由程式做，不能靠人記得改兩個地方。
#
# 用法：
#   ./deploy/scripts/render-caddy.sh            # 依 TLS_MODE 寫回 .env
#   ./deploy/scripts/render-caddy.sh --print    # 只印出會寫入的值，不改檔
#   ./deploy/scripts/render-caddy.sh --check    # 只檢查是否一致（不一致回 1）

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

MODE_ACTION="write"
ENV_FILE="${YZ_ROOT}/.env"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print) MODE_ACTION="print"; shift ;;
    --check) MODE_ACTION="check"; shift ;;
    --file) ENV_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

[[ -f "${ENV_FILE}" ]] || die "找不到 ${ENV_FILE}。請先執行 ./deploy/scripts/gen-secrets.sh"

TLS_MODE_VAL="$(env_get_value TLS_MODE "${ENV_FILE}")"
TLS_MODE_VAL="${TLS_MODE_VAL:-internal}"
ACME_EMAIL_VAL="$(env_get_value ACME_EMAIL "${ENV_FILE}")"
APP_DOMAIN_VAL="$(env_get_value APP_DOMAIN "${ENV_FILE}")"
PROXY_MODE_VAL="$(env_get_value PROXY_MODE "${ENV_FILE}")"
PROXY_MODE_VAL="${PROXY_MODE_VAL:-caddy}"

# ── 對照表 ──────────────────────────────────────────────────────
#
# public／acme 是同一件事的三種叫法（.env.example 的註解、
# docker-compose.yml 的註解、preflight.sh 各用了不同的字），
# 全部接受並正規化，否則使用者照著其中一份文件填就會落空。
DIRECTIVE=""
case "${TLS_MODE_VAL}" in
  internal)
    DIRECTIVE="internal"
    ;;
  letsencrypt|public|acme)
    # `tls <email>` 會設定 ACME 帳號信箱並走公開簽發。
    # 沒有信箱時留空——Caddy 的裸 `tls` 是合法的 no-op，
    # 自動 HTTPS 仍然生效，只是憑證到期不會有人收到通知。
    DIRECTIVE="${ACME_EMAIL_VAL}"
    ;;
  custom)
    DIRECTIVE="/etc/caddy/certs/fullchain.pem /etc/caddy/certs/privkey.pem"
    ;;
  *)
    die "不認得的 TLS_MODE='${TLS_MODE_VAL}'。可用值：internal｜letsencrypt｜custom"
    ;;
esac

CURRENT="$(env_get_value TLS_DIRECTIVE "${ENV_FILE}")"

# ── 一併檢查該模式的前提條件 ────────────────────────────────────
#
# 這些條件不成立時，就算 TLS_DIRECTIVE 是對的，Caddy 一樣拿不到
# 憑證——而且失敗方式同樣安靜（Caddy 會在背景重試到天荒地老）。
problems=()
if [[ "${PROXY_MODE_VAL}" == "caddy" ]]; then
  case "${TLS_MODE_VAL}" in
    letsencrypt|public|acme)
      [[ -z "${ACME_EMAIL_VAL}" ]] && problems+=("TLS_MODE=${TLS_MODE_VAL} 但 ACME_EMAIL 是空的。憑證到期前 30 天的通知沒有地方寄，續期失敗時不會有人知道。")
      if [[ "${APP_DOMAIN_VAL}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        problems+=("APP_DOMAIN=${APP_DOMAIN_VAL} 是 IP 位址。Let's Encrypt 不簽 IP，內網部署請改 TLS_MODE=internal。")
      fi
      ;;
    custom)
      for f in fullchain.pem privkey.pem; do
        [[ -f "${YZ_ROOT}/deploy/caddy/certs/${f}" ]] \
          || problems+=("TLS_MODE=custom 但 deploy/caddy/certs/${f} 不存在。Caddy 會啟動失敗並反覆重啟。")
      done
      ;;
  esac
fi

case "${MODE_ACTION}" in
  print)
    printf 'TLS_MODE=%s\n' "${TLS_MODE_VAL}"
    printf 'TLS_DIRECTIVE=%s\n' "${DIRECTIVE}"
    ((${#problems[@]})) && printf '# 注意：%s\n' "${problems[@]}"
    exit 0
    ;;
  check)
    rc=0
    if [[ "${CURRENT}" != "${DIRECTIVE}" ]]; then
      err "TLS_DIRECTIVE 與 TLS_MODE 不一致："
      dim "TLS_MODE=${TLS_MODE_VAL} 應該對應 TLS_DIRECTIVE='${DIRECTIVE}'，但目前是 '${CURRENT}'"
      dim "修正：./deploy/scripts/render-caddy.sh"
      rc=1
    fi
    for p in "${problems[@]:-}"; do [[ -n "${p}" ]] && { warn "${p}"; rc=1; }; done
    exit "${rc}"
    ;;
esac

# ── 寫回 ────────────────────────────────────────────────────────
if [[ "${CURRENT}" == "${DIRECTIVE}" ]]; then
  ok "TLS 設定一致（TLS_MODE=${TLS_MODE_VAL}）"
else
  env_set_value TLS_DIRECTIVE "${DIRECTIVE}" "${ENV_FILE}"
  ok "已依 TLS_MODE=${TLS_MODE_VAL} 更新 TLS_DIRECTIVE='${DIRECTIVE}'"
fi

for p in "${problems[@]:-}"; do [[ -n "${p}" ]] && warn "${p}"; done

if [[ "${PROXY_MODE_VAL}" != "caddy" ]]; then
  dim "PROXY_MODE=${PROXY_MODE_VAL}，內建 Caddy 不會啟動，這組設定不生效。"
fi
