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

檢查範圍：設定完整性與權限、服務狀態（含 `backup` 容器）、
資料庫與 Redis 連通性、連線數餘裕、長交易、磁碟與記憶體、
**上一次備份成功與否**、備份新鮮度、異地備份、**還原演練紀錄**、
WAL 歸檔狀態、本月 AI 用量與預算。

**沒有任何東西會自動跑它。** 沒有 cron、沒有 systemd timer、
沒有容器會定期執行 `doctor.sh`，首頁也不顯示它的結果。
所以上面「每週一次」那一列是真的要有人記得——把它排進行事曆，
或自己加一條：

```bash
# crontab -e：每天早上七點跑一次，有失敗才寄信
0 7 * * * cd /opt/yunzhi && ./deploy/scripts/doctor.sh >/tmp/yz-doctor.log 2>&1 \
  || mail -s "雲端智學健檢有失敗" 你的信箱 </tmp/yz-doctor.log
```

備份天天失敗這件事，在有人跑 `doctor.sh` 之前是完全靜默的
（容器 healthcheck 會轉紅，但沒有人在看 `docker compose ps`）。

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

**`POSTGRES_MAX_CONNECTIONS` 調小之後，手動跑一次 `backup.sh`。**
它與 `max_worker_processes`、`max_locks_per_transaction`、
`max_prepared_transactions` 這三個一樣，Postgres 復原 WAL 時不接受比
「寫下那些 WAL 的那台」更小的值。調小的當下一切正常——調小連線數不會
讓正在跑的資料庫出問題——**代價是在你最需要時間點還原的那一天，還原
起不來**，而錯誤訊息裡沒有「有人改過設定」這幾個字。跑一次備份，新的
基礎備份就會用新的值當基準。處理方式見
`docs/DISASTER-RECOVERY.md` 的「如果它說 insufficient parameter settings」。

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

寫入量最大、也就是膨脹主要來源的是這五張：`attempt_answers`（每一次
存檔一列）、`proctor_events`、`notifications`、`tutor_messages`、
`ai_usage_logs`。`postgresql.conf` 已把 autovacuum 門檻調低
（`scale_factor = 0.05`）。

（這裡以前寫的是 `response_events`——**沒有這張表**。照著查的人會得到
「relation does not exist」，然後以為是自己打錯字。）

---

## AI 成本與預算

### 看用了多少

最省事的一條是 `doctor.sh`——它會印本月的 token 總量、佔上限的百分比，
以及「單價沒設所以算不出金額」這件事：

```bash
./deploy/scripts/doctor.sh          # 看「AI 用量」那一段
```

要分得更細（哪個功能最貴、哪個模型最貴）就下 SQL。
**注意 `SET app.cross_tenant`：`ai_usage_logs` 開著 RLS（ENABLE ＋ FORCE），
少了這一句每一個 sum 都會回 0，而 0 看起來就像「這個月沒有用 AI」。**

```bash
./deploy/scripts/db-shell.sh --readonly -c "
  SET app.cross_tenant='on';
  SELECT purpose, tier, model, count(*) AS calls,
         sum(\"inputTokens\")  AS in_tok,
         sum(\"outputTokens\") AS out_tok
  FROM ai_usage_logs WHERE \"createdAt\" >= date_trunc('month', now())
  GROUP BY 1,2,3 ORDER BY 5 DESC;"
```

畫面上唯一顯示成本的地方是單一份題本的匯入進度頁，**沒有任何彙總畫面**。
所以「這個月花了多少」目前只有上面這兩條路。

### 換算成錢

`estimatedCost` 這一欄靠 `.env` 的 `AI_PRICING` 換算，而它**預設是空的**。
空的時候每一次呼叫都估成 0 元，於是：`ai_usage_logs.estimatedCost` 全是 null、
`import_jobs.aiCostTwd` 累積成 0、匯入進度頁那一行成本提示（條件是 `> 0`）
**永遠不會出現**。token 數本身照樣有記，只是換算不出金額。

要有金額就照你的閘道實際單價填 `AI_PRICING`（格式見 `.env.example`），
然後重啟 worker。它是估算值，不是帳單——`tokens_estimated = true`
表示上游閘道連 usage 都沒回報，那一列的 token 數本身也是估的。

### 上限超過會怎樣

`AI_MONTHLY_TOKEN_BUDGET` **預設是 0，也就是沒有上限。** 設成正整數之後，
實際行為是這樣，三點都要知道：

**一、它擋四件事，不是只擋題本匯入。** 超過上限時，這四條路都會停：

| 停掉的 | 使用者看到什麼 |
|---|---|
| 題本匯入 | 匯入工作直接失敗（狀態 FAILED） |
| 智慧老師 | 「智慧老師暫停，但成績、解析與考試都不受影響」 |
| AI 閱卷（含「全班一起評」） | 「AI 閱卷暫停，人工給分、成績與考試都不受影響」 |
| 升學 AI 建議 | 「AI 老師暫停，但你查到的資料與下面的整理都不受影響」 |

**考試、自動計分、人工給分、已經生成好的解析全部照常**——這是刻意的
降級設計，預算用完不該讓考試停擺。

> 這一段以前寫的是「它**只**擋新的題本匯入」。那句話讓人以為智慧老師
> 與 AI 閱卷不受管控是設計如此，於是不會有人去追。實際上程式在
> v0.23.0–v0.25.0 就替這三條各加了守門，但 `docker-compose.yml` 沒有把
> `AI_MONTHLY_TOKEN_BUDGET` 傳給 web 容器，而三處守門的寫法都是
> 「讀不到就等於不限制」——所以那三條真的一路花下去，而且沒有任何
> 錯誤訊息。**v0.27.0 補上了那三個變數。**
> 如果你的 `.env` 是更早以前建立的，這件事不必改 `.env`（變數本來就在
> 那裡），但**要重新建立 web 容器**才會生效：
> `docker compose up -d --force-recreate web`。

一次「全班一起評」是三十份 × 三次呼叫，每次含題幹、規準與整篇作文
——那是這個系統裡單次最貴的動作。上限沒生效時，它是最先把錢花光的。

**二、它是「開始之前檢查一次」，不是「花到上限就停」。**
四條路都一樣：檢查點在**動作的起點**，開始之後不再檢查。匯入尤其明顯
——一份題本會跑 SEGMENTING → EXTRACTING → SOLVING → ANNOTATING 四個
AI 階段、幾百次模型呼叫，中間都不回頭問。所以一份 200 頁的大題本可以
一口氣把用量衝到上限的 150%；「全班一起評」按下去也是同一回事。

上限的實際語意是「**已經超支就不給開新的**」，不是「本月最多花這麼多」。
真的要控成本，把上限設得比你能接受的天花板低一截。

**三、改上限要重啟，而且是兩個服務。** 值是從環境變數讀的，
沒有畫面可以改；匯入跑在 worker，另外三條跑在 web：

```bash
nano .env                                          # 改 AI_MONTHLY_TOKEN_BUDGET
docker compose up -d --force-recreate worker web
```

漏掉 `web` 的話，改的只有匯入那一條——而那正是這個上限最不容易花掉的
一條。

半夜老師要匯一份明天要用的題本、而預算剛好滿了——這時候你要 SSH 進去
做上面這兩件事。想避開就別把上限壓得太貼近實際用量。

---

## 考試日的準備

正式模擬考前一天：

```bash
./deploy/scripts/doctor.sh                       # 必須全綠
./deploy/scripts/backup.sh --tag "pre-exam"      # 帶標籤的備份不會被保留期清掉
df -h                                            # 確認磁碟餘裕
```

考試期間**不要**做這些事：升級、金鑰輪替、還原、重啟服務。

`upgrade.sh` 的第一步會數 `attempts` 裡狀態是 `IN_PROGRESS` 的作答，
有任何一份就中止並印出份數。要在考試中硬升級必須自己加 `--force`。
（這個檢查曾經是死的：它查的是一張不存在的表名，而且沒有帶跨租戶的
資料庫脈絡——兩件事各自都會讓它永遠回 0。兩個都修掉了。）

**金鑰輪替沒有這種保護。** `gen-secrets.sh --rotate AUTH_SECRET`
會讓所有人立即登出，包含正在作答的學生，而且沒有任何確認會提到考試。

系統不可用時的降級流程（要印出來放在櫃檯）：

1. 考試中斷 — **答案是即時送到伺服器的，已經送出去的那幾題不會掉；
   瀏覽器本機沒有任何暫存**，所以最後正在寫、還沒送出的那一題會不見。
   請學生**不要關閉分頁**，恢復後重新整理就能接續同一份考卷
   （題目與選項的順序是伺服器記下來的，不會因為重整而改變）。
   恢復之後請學生回到那份考卷，從最後有作答的那一題檢查起。
2. 超過 15 分鐘無法恢復 — 改用紙本，事後掃描上傳。
3. 到班離班通知發不出去 — 櫃檯改用紙本簽到，恢復後補登。

> 這一段以前寫的是「學生的作答存在瀏覽器 IndexedDB，恢復後會自動續傳」。
> **那個 IndexedDB 不存在**（全前端沒有 IndexedDB、localStorage 或
> sessionStorage）。印出來放櫃檯的紙上寫一個不成立的保證，比什麼都不寫更糟：
> 櫃檯會照著它安撫學生，而學生真的會掉最後那幾題。

---

## 監控

先講結論，因為這一段以前寫反了：

> **`--monitoring` 裝起來的東西不會通知你任何事。**
> 它現在能給的是「事後翻日誌的地方」（Grafana ＋ Loki），
> 不是「出事時會叫你的東西」。**會叫你的是 `doctor.sh`。**

```bash
docker compose --profile monitoring up -d
```

Grafana 在 `https://你的網域/grafana`，可以查 Loki 收集的容器日誌
——排查「上禮拜三下午到底發生什麼事」時很好用。

### 為什麼告警是空的

`deploy/monitoring/alerts.yml` 這一節以前寫著「預設涵蓋：服務不可用、
資料庫連線數逼近上限、磁碟超過 85%、備份超過 26 小時未執行、WAL 歸檔
失敗」。那五條規則的檔案確實在，但**一則都送不出去**：

* 其中四條引用的指標沒有任何東西產生（要 `postgres_exporter`、
  `node_exporter`，還有應用自己的 `/api/metrics`——三樣 compose 裡都沒有）
* 唯一求得出值的那條，因為抓取目標不存在而**永遠成立**
* 而且 compose 裡沒有 Alertmanager，`ALERT_WEBHOOK_URL` 標著【尚未實作】

規則已經全部改成註解，理由寫在檔案裡。**這不是退步，是把假的指示燈
關掉**——一個裝了但什麼都不會通知的監控，會讓人不再自己去看。

### 那現在靠什麼

`./deploy/scripts/doctor.sh`。它會實際連資料庫、數最新備份的年齡、
讀備份守護行程留下的失敗原因、看還原演練紀錄與 AI 用量，有紅燈時
回傳非零。要它「自動」的話，排進 cron 並在出事時寄信：

```bash
sudo tee /etc/cron.d/yunzhi-doctor >/dev/null <<'EOF'
30 7 * * * root /opt/yunzhi/deploy/scripts/doctor.sh > /tmp/yz-doctor.log 2>&1 || \
  mail -s "雲端智學健康檢查有紅燈" 你的信箱@example.com < /tmp/yz-doctor.log
EOF
```

（路徑照你實際安裝的位置改。要收得到信，機器上得有可用的 `mail`。）

**每天早上花十秒看一次 `doctor.sh` 的輸出，比一整套沒接通的監控有用。**
