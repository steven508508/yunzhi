# 維運手冊

日常操作、監控、以及出事時的處理程序。給接手這套系統的人看，
不預設讀者熟悉它。

---

## 每日／每週／每季

| 頻率 | 事項 | 指令 |
|---|---|---|
| 每日（自動） | 備份 | 由 backup 容器或 `yunzhi-backup.timer` 執行 |
| 每週 | 健康檢查 | `./deploy/scripts/doctor.sh` |
| 每週 | 磁碟用量 | `df -h`；超過 80% 就要處理 |
| **每季** | **還原演練** | `./deploy/scripts/verify-restore.sh` |
| 每年 | 完整災難復原演練 | 見 `DISASTER-RECOVERY.md` |
| 每年 | 升學資料年度維護 | 見規格書文件 07 |

**每季的還原演練是不可省略的。** 規格書文件 01 §16 把它列為要求，
理由是單一機構自架最常見的失敗就是「備份一直在跑，但沒有人試過還原」。
`doctor.sh` 會在超過 92 天沒演練時回報為失敗，不是警告。

---

## 診斷

```bash
./deploy/scripts/doctor.sh              # 完整檢查，每項失敗都附下一步
./deploy/scripts/doctor.sh --json       # 給監控系統接
./deploy/scripts/doctor.sh --config-only
```

檢查範圍：設定完整性與權限、服務狀態、資料庫與 Redis 連通性、
連線數餘裕、長交易、磁碟與記憶體、備份新鮮度、**還原演練紀錄**、
WAL 歸檔狀態。

---

## 日誌

```bash
# Docker
docker compose logs -f web
docker compose logs --tail 200 ai
docker compose logs --since 30m postgres

# 原生
journalctl -u yunzhi-web -f
journalctl -u yunzhi-ai --since "30 min ago"
```

健康檢查的請求刻意不記進 access log —— 否則每 15 秒一次的探測會
把日誌塞滿，真正的錯誤反而找不到。

---

## 容量規劃

預設值以「4 核 8GB、300 人同時作答」為基準。

**要支撐更多人同時作答**，依序調整並在每一步後量測：

```bash
# .env
WEB_REPLICAS=4                  # 先加 web 實例
POSTGRES_MAX_CONNECTIONS=300    # 連線數
DATABASE_POOL_MAX=20            # 每個 web 實例的池上限
POSTGRES_SHARED_BUFFERS=1GB     # 約總記憶體的 25%
```

`DATABASE_POOL_MAX × (WEB_REPLICAS + WORKER_REPLICAS)` **必須明顯小於**
`POSTGRES_MAX_CONNECTIONS`，否則交卷尖峰會出現連線被拒。
`doctor.sh` 的連線數檢查就是在盯這件事。

`work_mem` 調高之前先算乘法：300 連線 × 8MB 在最壞情況是 2.4GB。

---

## 金鑰輪替

```bash
./deploy/scripts/gen-secrets.sh --show
./deploy/scripts/gen-secrets.sh --rotate AUTH_SECRET
```

各金鑰的影響必須先弄清楚，順序錯了會讓服務連不上：

**`AUTH_SECRET`** — 所有人立即被登出。**絕對不要在考試進行中做。**

**`POSTGRES_PASSWORD`** — 要先改資料庫端再改 `.env`，順序不能反：

```bash
NEW=$(openssl rand -base64 32 | tr -d '/+=')
docker compose exec postgres psql -U yunzhi -d postgres \
  -c "ALTER ROLE yunzhi PASSWORD '${NEW}';"
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${NEW}|" .env
docker compose up -d --force-recreate web worker migrate
```

只改 `.env` 而沒改資料庫端，會得到「密碼看起來是對的但連不上」——
這是最容易誤診的一種故障。

**`BACKUP_ENCRYPTION_KEY`** — 換掉之後**所有既有備份都無法解密**。
舊金鑰務必另行保存，否則那些備份等於作廢。

---

## 維護模式

升級時自動啟用。手動：

```bash
touch .maintenance && docker compose restart caddy    # 進入
rm -f .maintenance && docker compose restart caddy    # 離開
```

使用者會看到「系統升級中」而不是瀏覽器的預設錯誤頁 ——
後者會引來一堆電話。

---

## 效能排查

```bash
# 最慢的查詢
docker compose exec postgres psql -U yunzhi -d yunzhi -c "
  SELECT round(mean_exec_time::numeric,1) AS avg_ms, calls,
         left(query,80) AS query
  FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"

# 資料表大小
docker compose exec postgres psql -U yunzhi -d yunzhi -c "
  SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size
  FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;"

# 膨脹（死列多代表 autovacuum 跟不上）
docker compose exec postgres psql -U yunzhi -d yunzhi -c "
  SELECT relname, n_live_tup, n_dead_tup,
         round(100.0*n_dead_tup/NULLIF(n_live_tup+n_dead_tup,0),1) AS dead_pct
  FROM pg_stat_user_tables WHERE n_dead_tup > 1000 ORDER BY n_dead_tup DESC;"
```

`response_events` 與 `proctor_events` 寫入量最大，是膨脹的主要來源。
`postgresql.conf` 已把 autovacuum 門檻調低（`scale_factor = 0.05`）。

---

## AI 成本與預算

```bash
docker compose exec postgres psql -U yunzhi -d yunzhi -c "
  SELECT purpose, tier, count(*) AS calls,
         sum(\"inputTokens\") AS in_tok, sum(\"outputTokens\") AS out_tok
  FROM ai_usage_logs WHERE \"createdAt\" > now() - interval '30 days'
  GROUP BY purpose, tier ORDER BY 5 DESC;"
```

`AI_MONTHLY_TOKEN_BUDGET` 設定月度上限。超過時 AI 功能降級為不可用，
但**考試、客觀題評分、已生成的解析全部照常運作**。

`tokens_estimated = true` 表示上游閘道沒回報 usage，數字是估算的 ——
成本歸因僅供參考，不能當帳單用。

---

## 考試日的準備

正式模擬考前一天：

```bash
./deploy/scripts/doctor.sh                       # 必須全綠
./deploy/scripts/backup.sh --tag "pre-exam"      # 帶標籤的備份不會被保留期清掉
df -h                                            # 確認磁碟餘裕
```

考試期間**不要**做這些事：升級、金鑰輪替、還原、重啟服務。
`upgrade.sh` 會主動偵測進行中的考試並拒絕執行。

系統不可用時的降級流程（要印出來放在櫃檯）：

1. 考試中斷 — 學生的作答存在瀏覽器 IndexedDB，恢復後會自動續傳。
   **請學生不要關閉分頁**，這是最重要的一句話。
2. 超過 15 分鐘無法恢復 — 改用紙本，事後掃描上傳。
3. 到班離班通知發不出去 — 櫃檯改用紙本簽到，恢復後補登。

---

## 監控

```bash
docker compose --profile monitoring up -d
```

Grafana 在 `https://你的網域/grafana`。告警規則在
`deploy/monitoring/alerts.yml`，預設涵蓋：服務不可用、資料庫連線數
逼近上限、磁碟超過 85%、備份超過 26 小時未執行、**WAL 歸檔失敗**。

最後一項容易被忽略但很重要：WAL 歸檔失敗是靜默的，而它失敗的後果
是 PostgreSQL 持續累積 WAL 直到磁碟寫滿。
