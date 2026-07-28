# 雲端智學 — 備份容器
#
# 跑在容器裡而不是宿主機 crontab：解除安裝時移除容器就乾淨了，
# 不會留下孤兒 cron job —— 那是自架系統移除後最常見的殘留物。
FROM postgres:16-alpine
# mc 是 MinIO 的用戶端。**備份一定要包含物件儲存**——資料庫裡
# 存的只是物件鍵，題本原檔、頁面影像、題目附圖都在 MinIO 裡。
RUN apk add --no-cache bash openssl coreutils findutils tar gzip curl tzdata \
 && ARCH="$(uname -m)" \
 && case "$ARCH" in \
      x86_64)  MC_ARCH=amd64 ;; \
      aarch64) MC_ARCH=arm64 ;; \
      *) echo "不支援的架構 $ARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://dl.min.io/client/mc/release/linux-${MC_ARCH}/mc" -o /usr/local/bin/mc \
 && chmod +x /usr/local/bin/mc
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
