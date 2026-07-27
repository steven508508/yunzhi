# 災難復原

出事時照這份做。假設讀者在壓力下、可能不是原本的維運人員。

**目標**：RTO 4 小時（從零把服務跑起來）、RPO 15 分鐘（最多掉多少資料）。
這兩個數字不是願望，是由 WAL 歸檔（`archive_timeout = 900`）與平行還原
支撐的；每季的 `verify-restore.sh` 就是在驗證它們還成立。

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

前提是 `WAL_ARCHIVE_ENABLED=true`（預設開啟）。

```bash
# 1. 停止所有服務
docker compose stop web worker ai
docker compose stop postgres

# 2. 取出全量備份與 WAL
BACKUP=/var/backups/yunzhi/yunzhi-<誤刪之前最近的一份>.tar.gz.enc
mkdir -p /tmp/pitr && cd /tmp/pitr
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$BACKUP" -out backup.tar.gz -pass "pass:${BACKUP_ENCRYPTION_KEY}"
tar -xzf backup.tar.gz        # 得到 database.dump 與 wal/

# 3. 還原基礎備份到一個乾淨的資料庫
docker compose start postgres
docker compose exec postgres psql -U yunzhi -d postgres -c "CREATE DATABASE yunzhi_pitr;"
docker compose cp database.dump postgres:/tmp/d.dump
docker compose exec postgres pg_restore -U yunzhi -d yunzhi_pitr --no-owner --jobs=4 /tmp/d.dump

# 4. 重放 WAL 到指定時間
#    把 wal/ 的內容放到歸檔目錄，並設定 recovery target
docker compose cp wal postgres:/var/lib/postgresql/wal_restore
docker compose exec postgres bash -c "cat >> /var/lib/postgresql/data/pgdata/postgresql.conf <<EOF
restore_command = 'cp /var/lib/postgresql/wal_restore/%f %p'
recovery_target_time = '2026-07-27 15:00:00+08'
recovery_target_action = 'promote'
EOF
touch /var/lib/postgresql/data/pgdata/recovery.signal"

docker compose restart postgres
# 觀察日誌直到出現 "archive recovery complete"
docker compose logs -f postgres
```

**重放完成後先驗證再切換**：查一下那個班級的成績是不是回來了、
而且沒有多出不該有的資料。確認無誤才把 `yunzhi_pitr` 改名為正式庫。

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
3. **WAL 歸檔**：即使全量備份壞了，WAL 加上更舊的一份全量備份
   仍可能重建到相當近的時點。
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
