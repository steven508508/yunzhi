# 雲端智學 — 備份容器
#
# 跑在容器裡而不是宿主機 crontab：解除安裝時移除容器就乾淨了，
# 不會留下孤兒 cron job —— 那是自架系統移除後最常見的殘留物。
FROM postgres:16-alpine
RUN apk add --no-cache bash openssl coreutils findutils tar gzip curl tzdata
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
