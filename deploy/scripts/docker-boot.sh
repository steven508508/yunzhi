#!/usr/bin/env bash
# 雲端智學 — 開機時把整套堆疊帶起來（由 yunzhi-docker.service 呼叫）
#
# **為什麼不直接在 unit 裡寫 `docker compose up -d`**
#
# 因為 Caddy 與監控都藏在 compose profile 後面。不帶 profile 的
# `up -d` 只會帶起 web／worker／ai／資料庫那幾個，Caddy 不在裡面——
# 於是開機之後應用是活的、但對外的 443 沒有人接，學生看到的是
# 連線被拒絕，而 `docker compose ps` 看起來一切正常。
#
# 要帶哪些 profile 取決於 .env（PROXY_MODE、MONITORING_ENABLED），
# 而 .env 是使用者隨時會改的。寫死在 unit 檔裡的話，改完設定的下一次
# 重開機才會發現不對——那通常是幾個月後的停電夜。
#
# 用法（一般不必手動跑）：
#   ./deploy/scripts/docker-boot.sh
#   ./deploy/scripts/docker-boot.sh --stop

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ACTION="up"
case "${1:-}" in
  --stop) ACTION="stop" ;;
  -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
  "") ;;
  *) die "不認得的參數：$1" ;;
esac

PROXY_MODE="$(env_get_value PROXY_MODE)"
MONITORING="$(env_get_value MONITORING_ENABLED)"

PROFILES=()
[[ "${PROXY_MODE:-caddy}" == "caddy" ]] && PROFILES+=(--profile caddy)
[[ "${MONITORING:-false}" == "true" ]]  && PROFILES+=(--profile monitoring)

if [[ "${ACTION}" == "stop" ]]; then
  # 60 秒優雅關閉：正在作答的學生需要時間讓前端把本地暫存同步上來。
  info "停止服務（最多 60 秒優雅關閉）…"
  compose "${PROFILES[@]}" stop -t 60
  exit 0
fi

_names=()
for _p in "${PROFILES[@]}"; do [[ "${_p}" == "--profile" ]] || _names+=("${_p}"); done
info "啟動堆疊${_names:+（profile：${_names[*]}）}…"

# **--no-build。** 開機時映像已經在本機，而 network-online.target
# 之後網路未必真的穩定；一次 pull 或 build 逾時會讓整套系統晚十分鐘
# 才起來，而且 systemd 會判定啟動失敗。
compose "${PROFILES[@]}" up -d --no-build

ok "堆疊已啟動"
