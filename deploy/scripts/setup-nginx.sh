#!/usr/bin/env bash
# 雲端智學 — 設定既有的 nginx 作為反向代理
#
# 適用於「伺服器上已經有 nginx，只要把雲端智學代理出去」的情境。
# 這是最常見的部署方式 —— 多數機構的伺服器不會只跑一個服務。
#
# 它做四件事：
#   1. 確認 .env 的 PROXY_MODE=external（應用只綁 127.0.0.1，不搶 80/443）
#   2. 產生站台設定並代入實際網域
#   3. 建立維護頁
#   4. `nginx -t` 驗證後才 reload —— 設定錯了不會弄壞既有的其他站台
#
# 用法：
#   sudo ./deploy/scripts/setup-nginx.sh
#   sudo ./deploy/scripts/setup-nginx.sh --print   # 只印出設定，不安裝

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

PRINT_ONLY=0
SITE_NAME="yunzhi"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print) PRINT_ONLY=1; shift ;;
    --name) SITE_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
done

load_env
require_env APP_DOMAIN

UPSTREAM_PORT="${WEB_BIND_PORT:-3000}"
TEMPLATE="${YZ_DEPLOY_DIR}/nginx/yunzhi.conf"
[[ -f "${TEMPLATE}" ]] || die "找不到範本 ${TEMPLATE}"

# nginx 的 HTTP/2 語法在 1.25.1 改過，兩種寫法互不相容：
#   < 1.25.1   listen 443 ssl http2;
#   >= 1.25.1  listen 443 ssl;  另加 http2 on;
# 範本用舊寫法（在新版仍有效，只會有棄用警告），這裡偵測版本後
# 在新版上改寫成建議寫法，讓兩邊都乾淨。
nginx_version() {
  nginx -v 2>&1 | grep -oP 'nginx/\K[0-9.]+' || echo "0.0.0"
}

version_ge() {
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]
}

render() {
  local out
  out="$(sed -e "s|yunzhi\.example\.edu\.tw|${APP_DOMAIN}|g" \
             -e "s|127\.0\.0\.1:3000|127.0.0.1:${UPSTREAM_PORT}|g" \
             "${TEMPLATE}")"

  if command -v nginx >/dev/null 2>&1 && version_ge "$(nginx_version)" "1.25.1"; then
    out="$(printf '%s' "${out}" \
      | sed -e 's|^\( *\)listen 443 ssl http2;|\1listen 443 ssl;\n\1http2 on;|' \
            -e 's|^\( *\)listen \[::\]:443 ssl http2;|\1listen [::]:443 ssl;|')"
  fi

  # IPv6 被停用的機器上，`listen [::]` 會讓 nginx 直接起不來
  # （Address family not supported by protocol）。不少學校的伺服器
  # 為了簡化防火牆規則會關掉 IPv6，所以偵測後自動註解掉。
  if ! has_ipv6; then
    out="$(printf '%s' "${out}" | sed -e 's|^\( *\)\(listen \[::\].*\)|\1# \2  # 本機未啟用 IPv6，已自動註解|')"
  fi

  printf '%s\n' "${out}"
}

has_ipv6() {
  [[ -f /proc/net/if_inet6 ]] && [[ -s /proc/net/if_inet6 ]] \
    && [[ "$(sysctl -n net.ipv6.conf.all.disable_ipv6 2>/dev/null || echo 0)" != "1" ]]
}

if (( PRINT_ONLY )); then
  render
  exit 0
fi

need_root
need_cmd nginx || die "找不到 nginx。"
info "nginx $(nginx_version)"
has_ipv6 && info "IPv6 已啟用" || info "IPv6 未啟用，設定中的 listen [::] 會自動註解"

section "檢查設定"

if [[ "${PROXY_MODE:-caddy}" != "external" ]]; then
  err "目前 .env 的 PROXY_MODE=${PROXY_MODE:-caddy}。"
  err "使用外部 nginx 時必須設為 external，否則應用會自己去搶 80／443 並與 nginx 衝突。"
  dim "修正："
  dim "  sed -i 's|^PROXY_MODE=.*|PROXY_MODE=external|' .env"
  dim "  ./deploy/scripts/docker-install.sh    # 重跑以套用"
  die "請先修正 PROXY_MODE。"
fi
ok "PROXY_MODE=external"

if [[ "${APP_DOMAIN}" == "yunzhi.example.edu.tw" ]]; then
  warn "APP_DOMAIN 仍是範例值，產生出來的設定不會是你要的。"
fi
ok "網域 ${APP_DOMAIN}｜上游 127.0.0.1:${UPSTREAM_PORT}"

# 上游要先活著。否則設定裝好了但一直 502，很難判斷是哪一層的問題。
if curl -fsS --max-time 5 "http://127.0.0.1:${UPSTREAM_PORT}/api/healthz" >/dev/null 2>&1; then
  ok "上游應用有回應"
else
  warn "127.0.0.1:${UPSTREAM_PORT} 沒有回應。"
  dim "設定仍會安裝，但在應用啟動前 nginx 會回 502。"
  dim "確認應用已啟動：./deploy/scripts/doctor.sh"
fi

section "TLS 憑證"

CERT_DIR="/etc/letsencrypt/live/${APP_DOMAIN}"
if [[ -f "${CERT_DIR}/fullchain.pem" ]]; then
  ok "找到 Let's Encrypt 憑證"
else
  warn "找不到 ${CERT_DIR}/fullchain.pem"
  dim "取得憑證（先確認網域已指向本機且 80 埠可達）："
  dim "  sudo apt-get install -y certbot python3-certbot-nginx"
  dim "  sudo certbot --nginx -d ${APP_DOMAIN}"
  dim ""
  dim "內網部署（無公開網域）請改用自簽憑證，並修改設定中的 ssl_certificate 路徑："
  dim "  sudo openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \\"
  dim "    -keyout /etc/ssl/private/${SITE_NAME}.key \\"
  dim "    -out /etc/ssl/certs/${SITE_NAME}.crt -subj '/CN=${APP_DOMAIN}'"
  dim ""
  dim "沒有憑證時 nginx -t 會失敗，所以請先處理憑證再回來執行本腳本。"
fi

section "維護頁"

mkdir -p /var/www/yunzhi
cat > /var/www/yunzhi/maintenance.html <<'HTML'
<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>系統維護中 — 雲端智學</title></head>
<body style="font-family:system-ui,-apple-system,'Noto Sans TC',sans-serif;
             background:#f7f8fa;color:#1a1d21;display:flex;align-items:center;
             justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px;padding:24px">
  <h1 style="font-size:22px;margin-bottom:8px">系統維護中</h1>
  <p style="color:#5b6470;line-height:1.75">
    系統正在維護或更新，通常需要幾分鐘。<br>
    <strong>你先前的作答已經儲存</strong>，恢復後可以接續。
  </p>
  <p style="color:#8b949e;font-size:13px;margin-top:24px">
    若超過 30 分鐘仍無法使用，請聯絡櫃檯。
  </p>
</div></body></html>
HTML
ok "維護頁：/var/www/yunzhi/maintenance.html"

section "安裝站台設定"

AVAILABLE="/etc/nginx/sites-available/${SITE_NAME}"
ENABLED="/etc/nginx/sites-enabled/${SITE_NAME}"

# 既有設定先備份。這台機器上可能還有別的站台在跑，
# 弄壞它們的代價比弄壞我們自己的高。
if [[ -f "${AVAILABLE}" ]]; then
  backup="${AVAILABLE}.bak-$(date +%Y%m%d-%H%M%S)"
  cp "${AVAILABLE}" "${backup}"
  info "既有設定已備份為 $(basename "${backup}")"
fi

render > "${AVAILABLE}"
chmod 644 "${AVAILABLE}"
ok "已寫入 ${AVAILABLE}"

[[ -L "${ENABLED}" ]] || ln -s "${AVAILABLE}" "${ENABLED}"
ok "已啟用"

section "驗證"

# 這一步是整支腳本最重要的保護：設定有錯就不 reload，
# 既有的其他站台完全不受影響。
if nginx -t 2>&1 | sed 's/^/  /'; then
  ok "nginx 設定語法正確"
else
  err "nginx 設定驗證失敗。"
  rm -f "${ENABLED}"
  warn "已移除連結，既有站台不受影響。"
  dim "常見原因：憑證路徑不存在（先跑 certbot），"
  dim "或 limit_req_zone／map 與 nginx.conf 中既有的定義重複。"
  dim "後者把 ${AVAILABLE} 中對應的幾行刪掉即可。"
  die "請修正後重試。"
fi

systemctl reload nginx
ok "nginx 已重新載入"

section "完成"
echo
dim "網址        https://${APP_DOMAIN}"
dim "站台設定    ${AVAILABLE}"
dim "存取日誌    /var/log/nginx/yunzhi-access.log"
dim "錯誤日誌    /var/log/nginx/yunzhi-error.log"
echo
warn "確認以下三項，它們是最容易漏掉而且症狀不明顯的："
dim "1. 上傳大檔案（>1MB 的題本 PDF）能成功 —— client_max_body_size 已設 200M"
dim "2. 稽核記錄中的來源 IP 是學生的真實 IP，不是 127.0.0.1"
dim "3. 智慧老師的回應是逐字出現而非一次跳出 —— SSE 緩衝已關閉"
echo
