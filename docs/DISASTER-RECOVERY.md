# 災難復原

出事時照這份做。假設讀者在壓力下、可能不是原本的維運人員。

**目標**：RTO 4 小時（從零把服務跑起來）、RPO 15 分鐘（最多掉多少資料）。

RPO 那個 15 分鐘要看清楚它涵蓋哪一種情況，因為兩種情況差很多：

| 情況 | 實際 RPO | 靠什麼 |
|---|---|---|
| 機器還在，資料被誤刪或改壞（情況二、三） | **15 分鐘** | 每晚的實體基礎備份 ＋ 機器上的 WAL 歸檔（`archive_timeout = 900`） |
| 整台機器毀掉（情況四） | **最多 24 小時** | 只剩異地那一份每晚的備份 |

第二列常被忽略：異地複製是每晚一次，所以機房失火時掉的是「從昨晚
到現在」。要把它也壓到 15 分鐘，需要把 WAL 持續往外送（本系統目前
沒有做這件事，`BACKUP_REMOTE_*` 只送每晚的那一份 tarball）。

這兩個數字成立的前提是**每一份備份裡都有 `base.tar.gz`**（實體基礎
備份）。缺了它，WAL 收得再齊也沒有用——理由見下面情況三的第一段。
每季的 `verify-restore.sh` 就是在檢查這件事還成立。

---

## 先做這三件事

1. **不要急著重裝。** 多數情況資料還在，重裝反而會蓋掉它。
2. **確認備份在哪、能不能解開。**
   ```bash
   ls -la /var/backups/yunzhi/
   grep BACKUP_ENCRYPTION_KEY .env      # 沒有這把金鑰，加密備份無法還原
   ```
3. **判斷屬於哪一種情況**，跳到對應的小節。

---

## 情況一：服務起不來，資料完好

最常見，也最容易處理。

```bash
./deploy/scripts/doctor.sh          # 先看它怎麼說，每項失敗都附下一步
docker compose logs --tail 100 web
```

依序嘗試：

```bash
docker compose restart web                    # 1. 重啟
docker compose up -d --force-recreate web     # 2. 重建容器
docker compose run --rm migrate               # 3. 補跑遷移
```

**磁碟寫滿**是自架環境最常見的原因，而且症狀千奇百怪：

```bash
df -h
docker system prune -a --volumes=false        # 清理未使用的映像
find /var/backups/yunzhi -name '*.tar.gz*' -mtime +30 -delete
docker compose logs postgres | grep -i archive   # WAL 歸檔卡住也會撐爆磁碟
```

---

## 情況二：資料損壞或誤刪

```bash
# 1. 停止寫入，避免情況繼續惡化
docker compose stop web worker

# 2. 看有哪些備份
ls -la /var/backups/yunzhi/

# 3. 先演練，確認那份備份真的能用（不碰正式資料庫）
./deploy/scripts/verify-restore.sh /var/backups/yunzhi/yunzhi-<時間戳>.tar.gz.enc

# 4. 確認沒問題再真的還原
./deploy/scripts/restore.sh /var/backups/yunzhi/yunzhi-<時間戳>.tar.gz.enc
```

`restore.sh` 會在覆蓋之前**自動備份目前的狀態**（`pre-restore` 標籤），
所以「還原了才發現拿錯備份」還有退路。

---

## 情況三：指定時間點還原（PITR）

用在「今天下午三點有人誤刪了一個班級的成績」這種情境 ——
你要的不是昨天的備份，而是三點整的狀態。

### 先讀這一段，它會省下你半天

時間點還原**不是**「把備份還原進去，再把 WAL 補上去」。

備份裡有兩份東西，長得很像但完全不同：

* `database.dump` —— **邏輯**備份。記的是「有哪些資料」。日常還原用它。
* `base.tar.gz` —— **實體**備份（`pg_basebackup` 產生）。記的是資料庫
  那些檔案在某一刻的樣子。

WAL 記的是「資料庫檔案的哪個位元組被改了」，所以它只能重放在
`base.tar.gz` 上。重放到 `pg_restore` 還原出來的資料庫上是做不到的 ——
**不是難，是這件事不存在**。

> 這份文件在 v0.27.0 之前教的正是那條不存在的路，而且失敗是安靜的：
> 資料庫會進入復原模式、跑到本機 WAL 的結尾、然後 promote，日誌上
> 出現 `archive recovery complete`，看起來完全成功，時間點卻是錯的。
> 如果你手上的備份是那之前產生的（`manifest.json` 裡沒有
> `includesBaseBackup`），這一節做不了，只能走情況二。

### 前提

* `WAL_ARCHIVE_ENABLED=true`、`BACKUP_BASE_BACKUP=true`（都是預設值）
* 挑一份**誤刪之前**產生的備份。目標時間早於基礎備份時點的話，
  復原會直接拒絕開始。
* 整段過程**不會動到正式資料庫**。復原跑在另一個資料目錄、另一個埠上，
  確認資料對了才把東西搬回去。所以不必先停服務，學生可以繼續作答。

### 步驟

```bash
# 1. 備妥材料。--to 不會覆蓋正式資料庫，它只解開備份、
#    並且把「基礎備份之後」產生的 WAL 從歸檔目錄補齊。
./deploy/scripts/restore.sh /var/backups/yunzhi/yunzhi-<誤刪之前那一份>.tar.gz.enc \
  --to "2026-07-27 15:00:00+08"
# 它會印出材料放在哪裡，例如 /var/backups/yunzhi/pitr-20260727-161200
PITR=/var/backups/yunzhi/pitr-<上一行印出來的>

# 2. 把材料送進資料庫容器，展開成一個獨立的資料目錄
docker compose cp "$PITR" postgres:/var/lib/postgresql/data/pitr
docker compose exec postgres bash -c '
  cd /var/lib/postgresql/data/pitr
  rm -rf data && mkdir data
  tar -xzf base.tar.gz -C data
  chown -R postgres:postgres /var/lib/postgresql/data/pitr
  chmod 700 data
'

# 3. 寫復原設定。**一定要寫進 postgresql.auto.conf**，
#    不是 postgresql.conf —— 理由見下面那一段。
docker compose exec postgres bash -c "cat > /var/lib/postgresql/data/pitr/data/postgresql.auto.conf <<'EOF'
restore_command = 'cp /var/lib/postgresql/data/pitr/wal/%f %p'
recovery_target_time = '2026-07-27 15:00:00+08'
recovery_target_action = 'promote'
port = 5433
listen_addresses = ''
archive_mode = off
EOF
touch /var/lib/postgresql/data/pitr/data/recovery.signal
chown postgres:postgres /var/lib/postgresql/data/pitr/data/postgresql.auto.conf \
                        /var/lib/postgresql/data/pitr/data/recovery.signal"

# 4. 啟動這個臨時的資料庫（正式的那個完全不受影響）
docker compose exec -u postgres postgres \
  pg_ctl -D /var/lib/postgresql/data/pitr/data -w start \
  -o "-c config_file=/etc/postgresql/postgresql.conf" \
  -l /var/lib/postgresql/data/pitr/recover.log

# 5. 確認它真的停在你要的時間
docker compose exec postgres grep -E 'recovery stopping|archive recovery complete' \
  /var/lib/postgresql/data/pitr/recover.log
```

第 5 步應該看到兩行，像這樣：

```
LOG:  recovery stopping before commit of transaction 747, time 2026-07-27 15:00:02+08
LOG:  archive recovery complete
```

**`recovery stopping` 那一行是整個流程唯一的證據。** 只有
`archive recovery complete` 而沒有它，代表 WAL 沒有涵蓋到你要的時間，
資料庫只是跑到手邊 WAL 的結尾就停了 —— 時間點是錯的，不要往下做。

### 為什麼設定要寫在 `postgresql.auto.conf`

因為 compose 的 postgres 是用
`command: -c config_file=/etc/postgresql/postgresql.conf` 啟動的，而那份
檔案是**唯讀掛進去**的 repo 檔案。往
`/var/lib/postgresql/data/pgdata/postgresql.conf` 附加東西不會有任何效果，
那不是 Postgres 讀的那一份 —— 但 `recovery.signal` 照樣會讓資料庫進入
復原模式並跑到 WAL 結尾，於是你會得到一個「成功」但時間點錯誤的結果。

`postgresql.auto.conf` 是唯一不受 `config_file` 影響的那個檔案：
它一律從資料目錄讀，而且優先於 `postgresql.conf`。

### 把資料搬回去

先看一眼，確認是你要的那個時間點：

```bash
docker compose exec -u postgres postgres \
  psql -h /var/run/postgresql -p 5433 -d yunzhi \
  -c "SELECT count(*) FROM attempts WHERE \"createdAt\" > '2026-07-27 12:00:00+08';"
```

確認之後，**只搬需要的那部分**，不要整庫覆蓋 —— 從三點到現在的
作答、成績、匯入都是真的資料，整庫覆蓋會把它們一起洗掉：

```bash
# 例：只取回某一場考試的作答
docker compose exec -u postgres postgres bash -c "
  pg_dump -h /var/run/postgresql -p 5433 -d yunzhi \
    --data-only --table=attempt_answers --table=attempts \
    > /var/lib/postgresql/data/pitr/rescued.sql"
```

然後在正式資料庫上把那些列補回去（會需要看一下 SQL，這一步沒有
安全的通用做法 —— 如果不確定，先把 `rescued.sql` 留著，找得到人再做）。

真的要整庫換掉才走這一條：用臨時庫做一份 dump，然後照情況二還原。

### 收尾

```bash
docker compose exec -u postgres postgres pg_ctl -D /var/lib/postgresql/data/pitr/data -m fast -w stop
docker compose exec postgres rm -rf /var/lib/postgresql/data/pitr
```

**不收尾的代價是磁碟。** 那份資料目錄是整個資料庫的副本，
和正式資料庫在同一顆磁碟上，忘記刪掉的下一步就是磁碟寫滿。

PITR 的步驟多且容易出錯，**建議在演練時實際跑過一次**，
不要等到真的需要才第一次做。

---

## 情況四：整台機器毀掉（完整重建）

這是 RTO 4 小時的那個場景。

```bash
# 1. 新機器裝好 Ubuntu Server 24.04 與 Docker（約 30 分鐘）
curl -fsSL https://get.docker.com | sudo sh

# 2. 取回程式碼與 .env
#    .env 必須從你的密碼管理器或離線備份取回 ——
#    沒有它，加密備份在數學上無法還原
git clone <儲存庫> yunzhi && cd yunzhi
cp <離線保存的 .env> .env && chmod 600 .env

# 3. 取回備份檔
scp <備份來源>:/var/backups/yunzhi/yunzhi-*.tar.gz.enc /var/backups/yunzhi/

# 4. 安裝（約 15 分鐘）
./deploy/scripts/docker-install.sh --yes

# 5. 還原（視資料量 10 分鐘至 1 小時）
./deploy/scripts/restore.sh --latest --yes

# 6. 驗證
./deploy/scripts/doctor.sh
```

**這整條路徑要每年實際演練一次**，在一台備援機或虛擬機上跑完，
並記錄實際耗時。`verify-restore.sh` 只量測第 5 步，而真正的 RTO
是全部加起來。沒演練過的復原計畫，實際執行時間通常是估計的三倍。

---

## 情況五：升級後出問題

```bash
./deploy/scripts/rollback.sh
```

**回滾會遺失升級之後產生的所有資料**（作答、成績、匯入的題目），
因為資料庫要還原到升級前的備份。所以回滾是「剛升級完發現不對」
的手段，不是「用了三天覺得不好」的手段。

超過一個營業日就應該考慮往前修而不是往後退。

只退程式、保留資料（有相容性風險，僅在確知 schema 相容時使用）：

```bash
./deploy/scripts/rollback.sh --code-only
```

---

## 情況六：備份也壞了

依序嘗試：

1. **其他備份**：`verify-restore.sh --all` 會逐一驗證，找出還能用的。
2. **異地備份**：若設定過 `BACKUP_REMOTE_*`。
3. **更舊的一份基礎備份 ＋ WAL**：找一份 `manifest.json` 裡
   `includesBaseBackup` 是 `true` 的舊備份，照情況三往前滾到壞掉之前。
   只要 WAL 歸檔沒有斷過（`WAL_ARCHIVE_RETENTION_DAYS` 預設 14 天），
   這條路可以救回相當近的時點。
   **單獨的 WAL 檔案救不了任何東西**——沒有基礎備份就沒有重放的對象。
4. **PostgreSQL 資料目錄**：若機器還在但資料庫起不來，
   `pg_resetwal` 是最後手段 —— **它會造成資料不一致**，
   只在沒有其他選擇時使用，且務必先把整個資料目錄複製一份。

如果走到這一步，代表備份策略有系統性問題。事後務必檢討：
是不是很久沒做還原演練？是不是磁碟曾經寫滿過？

---

## 事後

每次事故之後：

1. 記錄時間軸、原因、處理方式、實際 RTO 與資料損失
2. 檢討預防措施（監控有沒有提前示警？演練有沒有涵蓋這個情境？）
3. 更新這份文件 —— 遇到文件沒寫的情況，就把它補進來

事故報告要寫給下一個接手的人看，不是寫給自己。
