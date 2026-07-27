# 解除安裝

設計原則有三條，都是為了避免自架系統移除時最常見的兩種災難 ——
「以為刪乾淨了但留了一堆殘留」與「以為只是停用結果資料被刪了」。

1. **先列出將要刪除的每一項，再要求輸入完整詞句確認。** 不是 y/N，
   因為 y/N 太容易在半自動的操作中被連按過去。
2. **備份永遠不刪。** 解除安裝之後才發現需要舊資料是很常見的事，
   而備份是唯一的救援途徑。
3. **移除後會實際驗證有沒有殘留**，而不是印一句「完成」就結束。

先看會發生什麼事，不做任何更動：

```bash
./deploy/scripts/docker-uninstall.sh --dry-run     # Docker
sudo ./deploy/scripts/uninstall.sh --dry-run       # 原生
```

---

## 三個層級

| 指令 | 移除 | 保留 |
|---|---|---|
| （預設） | 容器／服務、網路 | **所有資料**、設定、映像、備份 |
| `--purge` | 上述 ＋ 資料庫、資料目錄 | 設定（除非加 `--remove-env`）、備份 |
| `--full` | 上述 ＋ 映像／系統套件、服務帳號 | 備份 |

`--purge` 之前，腳本會**強制檢查有沒有備份**。沒有備份就拒絕執行，
除非加上 `--backup-first` 讓它先備份一份。

---

## Docker

```bash
# 停用但保留全部資料（之後重裝會直接接上）
./deploy/scripts/docker-uninstall.sh

# 連資料一起刪，並先備份
./deploy/scripts/docker-uninstall.sh --purge --backup-first

# 機器完全回到安裝前的狀態
./deploy/scripts/docker-uninstall.sh --full --backup-first
```

會移除：`yunzhi-*` 容器、`yunzhi` 網路、（`--purge`）`yunzhi-*` volume、
（`--full`）`yunzhi/*` 映像與建置快取。

**不會**碰到：Docker Engine 本身、其他專案的容器與 volume、
系統套件、防火牆規則、以及 `BACKUP_DIR` 底下的任何檔案。

---

## 原生安裝

```bash
sudo ./deploy/scripts/uninstall.sh --dry-run
sudo ./deploy/scripts/uninstall.sh
sudo ./deploy/scripts/uninstall.sh --purge --backup-first
sudo ./deploy/scripts/uninstall.sh --full --backup-first
```

原生解除安裝的核心是 `/etc/yunzhi/install-manifest.txt` —— `install.sh`
把每一項新增的東西記在裡面，`uninstall.sh` 讀同一份。這讓它能區分
「本次安裝帶來的 PostgreSQL」與「機器上本來就有的 PostgreSQL」，
只回收前者。**清單遺失時，腳本會拒絕碰任何系統套件**，寧可留下也
不誤刪別人的資料庫。

它也會還原被修改過的第三方設定：

- `/etc/postgresql/16/main/conf.d/yunzhi.conf` 移除並重啟 PostgreSQL
  （這一步很重要 —— 留著的話 `archive_command` 會指向已刪除的目錄，
  PostgreSQL 會在下次重啟時卡住）
- `/etc/redis/redis.conf.d/yunzhi.conf` 移除
- `/etc/caddy/Caddyfile` 還原為安裝前的備份

---

## 移除後的驗證

腳本會自動檢查並回報殘留。手動確認：

```bash
# Docker
docker ps -a --filter name=yunzhi
docker volume ls --filter name=yunzhi
docker images --filter reference='yunzhi/*'

# 原生
systemctl list-units --all 'yunzhi*'
ls -la /opt/yunzhi /etc/yunzhi /var/lib/yunzhi 2>/dev/null
pgrep -au yunzhi
id yunzhi
```

殘留的**行程**比殘留的檔案麻煩，因為它們會繼續佔用連接埠。
腳本會特別檢查這一項。

---

## 完整移除清單（供稽核）

原生安裝在系統上留下的所有痕跡：

```
使用者     yunzhi（系統帳號，nologin）
目錄       /opt/yunzhi /etc/yunzhi /var/lib/yunzhi /var/log/yunzhi /var/backups/yunzhi
systemd    /etc/systemd/system/yunzhi-{web,worker,ai,minio,backup}.service
           /etc/systemd/system/yunzhi-backup.timer
設定       /etc/default/yunzhi
           /etc/logrotate.d/yunzhi
           /etc/postgresql/16/main/conf.d/yunzhi.conf
           /etc/redis/redis.conf.d/yunzhi.conf
           /etc/caddy/Caddyfile（修改，有備份）
資料庫     角色 yunzhi、資料庫 yunzhi
套件庫     /etc/apt/sources.list.d/{nodesource,caddy-stable}.list
           /usr/share/keyrings/caddy-stable-archive-keyring.gpg
二進位     /usr/local/bin/minio（套件庫沒有 minio 時才會裝）
系統套件   見 install-manifest.txt 的 package 條目
```

Docker 安裝只會留下 `yunzhi-*` 的容器、volume、網路與 `yunzhi/*` 映像，
加上專案目錄本身。這是選 Docker 的實際好處之一。

---

## 保留資料重新安裝

預設的解除安裝不刪資料，所以重裝會直接接上：

```bash
./deploy/scripts/docker-uninstall.sh      # 或 sudo ./deploy/scripts/uninstall.sh
# …做完你要做的事…
./deploy/scripts/docker-install.sh        # 或 sudo ./deploy/scripts/install.sh
```

若已經 `--purge`，從備份重建：

```bash
./deploy/scripts/docker-install.sh
./deploy/scripts/restore.sh /var/backups/yunzhi/yunzhi-<時間戳>.tar.gz.enc
```

還原需要當初的 `BACKUP_ENCRYPTION_KEY`。這就是為什麼安裝時要求你
把 `.env` 另外保存 —— 沒有那把金鑰，備份檔在數學上無法還原。
