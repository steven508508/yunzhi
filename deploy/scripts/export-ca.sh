#!/usr/bin/env bash
# 匯出 Caddy 的本地根憑證，供 MIS 派送到學生電腦。
#
# 這張憑證只讓瀏覽器信任本站，**不會也不能用來解密其他網站的流量**。
# 與規格書文件 08 明確否決的 TLS 攔截是完全不同的東西 ——
# 向家長說明時這一點值得講清楚。

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

load_env
OUT="${1:-${YZ_ROOT}/yunzhi-root-ca.crt}"

if [[ "$(detect_mode)" == "docker" ]]; then
  compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "${OUT}" 2>/dev/null \
    || die "取不到根憑證。確認 caddy 服務正在執行，且 TLS_MODE=internal。"
else
  src=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
  [[ -f "${src}" ]] || die "找不到 ${src}。確認 TLS_MODE=internal 且 Caddy 已啟動過。"
  cp "${src}" "${OUT}"
fi

chmod 644 "${OUT}"
ok "根憑證已匯出：${OUT}"
echo
dim "派送方式："
dim "  Windows（網域環境）群組原則 → 電腦設定 → Windows 設定 → 安全性設定"
dim "                              → 公開金鑰原則 → 受信任的根憑證授權單位"
dim "  Windows（單機）  certutil -addstore -f ROOT yunzhi-root-ca.crt"
dim "  macOS            sudo security add-trusted-cert -d -r trustRoot \\"
dim "                     -k /Library/Keychains/System.keychain yunzhi-root-ca.crt"
dim "  Linux            sudo cp yunzhi-root-ca.crt /usr/local/share/ca-certificates/ \\"
dim "                     && sudo update-ca-certificates"
echo
warn "憑證有效期約 10 年，但 Caddy 重建 PKI 時會更換 —— 更換後要重新派送。"
