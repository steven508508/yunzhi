# Ubuntu 部署手冊

從「剛開好的一台 Ubuntu Server」到「瀏覽器打得開登入頁」。
每一個指令都可以直接複製貼上。

適用 **Ubuntu Server 22.04 LTS 與 24.04 LTS**（建議 24.04）。
Debian 12 多半也可行，但沒有完整測試過。

> 只想快點裝好：跳到「一鍵安裝」，五個指令。
> 想知道每一步在做什麼、或一鍵腳本中途失敗了：看「手動安裝」。

> **動手改這台機器之前，先跑 `./tools/install-dryrun.sh`。**
> 它只讀不寫，一次列出所有裝不起來的原因（版本、記憶體、磁碟、
> 被佔用的連接埠、被防火牆擋掉的位址、`.env` 沒填完的欄位），
> 每一項都寫了怎麼修。詳見「一鍵安裝」的第 4 步。

---

## 0. 開始之前

### 機器規格

| 項目 | 最低 | 建議 | 不足時會怎樣 |
|---|---|---|---|
| CPU | 2 核 | 4 核以上 | 300 人同時作答時，AI 匯入會與作答搶 CPU |
| 記憶體 | 4GB | 8GB 以上 | PostgreSQL 與 AI 服務互相搶記憶體，OOM killer 砍掉資料庫 |
| 磁碟 | 20GB | 50GB 以上 SSD | 映像約 5GB，題本原檔與備份持續成長 |
| 系統 | Ubuntu 22.04 | Ubuntu 24.04 | — |

「建議 8GB」這個數字是這樣來的：預設會起 9 個容器
（web、worker、ai、postgres、redis、minio、caddy、migrate、backup），
其中設了記憶體上限的四個加起來剛好 8GB —— `ai` 4g、`postgres` 2g、
`web` 1g、`worker` 1g。所以 8GB 的機器是「剛好夠、沒有餘裕」：
`.env` 把 `AI_MEMORY_LIMIT` 調成 `2g` 會比較安全。

**監控（Prometheus + Grafana + Loki）預設是關的**，要用 `--monitoring`
才會啟動，而那三個沒有設記憶體上限，實務上再多吃 1 至 2GB。
8GB 的機器不要開；要監控請準備 16GB。

**4GB 的機器建置時會被 OOM killer 砍掉**（`next build` 這一步），
錯誤訊息是 `build worker exited with code: 137`，字面上完全沒提到記憶體。
先加 swap：

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 你需要先準備的

- 一個網域（例如 `yunzhi.你的學校.edu.tw`）指向這台機器的 IP。
  沒有公開網域也可以裝，走內網憑證模式，見下方「TLS 三種模式」。
- 這台機器的 80 與 443 對外開放（若要用 Let's Encrypt）。
- 一個 AI 服務的 API 金鑰。**第一次安裝可以先不用**，
  之後改設定重跑安裝腳本即可。

---

## 1. 一鍵安裝

SSH 進去之後：

```bash
# 1. 取得程式
sudo apt-get update && sudo apt-get install -y git
git clone <你的儲存庫> yunzhi
cd yunzhi

# 2. 建立設定（會產生所有密碼，並印出一次性的管理員初始密碼）
cp .env.example .env
./deploy/scripts/gen-secrets.sh

# 3. 改設定（至少改這幾項，見下一節）
nano .env

# 4. 乾跑檢查：這台機器裝得起來嗎
./tools/install-dryrun.sh

# 5. 安裝
sudo ./deploy/scripts/ubuntu-install.sh
```

### 第 4 步：先乾跑，再安裝

`./tools/install-dryrun.sh` **只讀不寫，不會改動這台機器**，可以放心
重複跑。它一次列出所有問題（不是撞到第一個就停），每一項都寫了怎麼修。

會檢查：作業系統版本與架構、記憶體與磁碟、要用到的每一個連接埠有沒有
被別人佔著、對外連得到哪些位址、`.env` 有沒有填完整、系統時區、
已經裝好的 Docker 版本夠不夠新。

**為什麼要多這一步。** 第 5 步的安裝腳本會實際改動機器（裝 Docker、
改時區、動防火牆、把你加進群組），而它的檢查跟那些動作是交錯的。
撞到第 6 步才發現網管沒放行 `binaries.prisma.sh` 的話，前面那些
已經做完了。乾跑先問完所有問題，你可以拿著清單一次去找網管。

看到 `可以安裝` 就往下走。看到 `N 項必須先處理` 就照著每一項的說明修，
修完再跑一次。

機房完全沒有對外網路（要走離線包）時，網路那一段可以略過：

```bash
./tools/install-dryrun.sh --no-network
```

> 這支腳本是 bash 寫的，**不需要先裝 Node.js**。
> Docker 部署路徑從頭到尾不需要宿主機上的 Node。

### 第 5 步：安裝

第 5 步會依序做：確認服務擁有者 → 檢查系統需求 → 設時區與語系 →
用 Docker 官方 apt 儲存庫裝 Docker → 把你加進 docker 群組 →
設防火牆 → 建目錄與權限 → 設開機自動啟動 → 建置映像並啟動 → 驗收。

**每一步都會印出在做什麼，失敗時會說下一步該做什麼。**
中途失敗修好之後直接重跑同一個指令即可，它是可重複執行的。

第一次建置要 10 到 20 分鐘（看機器與網路），畫面會停在
`building web` 很久 —— 那是正常的，不要按 Ctrl-C。

**跑完請把最後那一段警告看完再關視窗。** 安裝腳本會在結尾把過程中
所有的警告再列一次；建置的輸出有好幾百行，那些警告是在更早之前印的，
不回頭看就會錯過（例如防火牆規則沒套上去）。

想先只看檢查結果、不安裝任何東西：

```bash
sudo ./deploy/scripts/ubuntu-install.sh --check-only
```

### `.env` 至少要改的六項

```bash
APP_DOMAIN=yunzhi.你的學校.edu.tw     # 少了它，第一次上傳題本時 web 會整個掛掉
APP_URL=https://yunzhi.你的學校.edu.tw # 要含 https://
TLS_MODE=letsencrypt                  # 內網部署用 internal，見下一節
ACME_EMAIL=你的信箱                    # letsencrypt 模式必填，憑證到期通知寄這裡
BOOTSTRAP_ADMIN_EMAIL=管理員信箱
AI_PROVIDER=openai                    # 或 anthropic；先留 mock 也可以
```

`TLS_DIRECTIVE` 那一行**不要手動改**，安裝腳本會依 `TLS_MODE` 自動寫入。

### TLS 三種模式

| `TLS_MODE` | 用在什麼情況 | 學生端要做什麼 |
|---|---|---|
| `letsencrypt` | 有公開網域、80／443 對外通 | 什麼都不用做 |
| `internal` | 純內網、沒有公開網域 | 要安裝一張根憑證（見下方） |
| `custom` | 自己買的憑證 | 什麼都不用做 |

`internal` 模式下 Caddy 用本地 CA 簽憑證，學生電腦不裝根憑證會看到
「你的連線不是私人連線」。匯出根憑證交給 MIS 派送：

```bash
./deploy/scripts/export-ca.sh
```

這張根憑證**只讓瀏覽器信任本站**，不會也不能用來解密其他網站的流量。
和規格書文件 08 明確否決的「TLS 攔截」是完全不同的東西 —— 對家長說明時
這一點值得講清楚。

`custom` 模式把 `fullchain.pem` 與 `privkey.pem` 放進 `deploy/caddy/certs/`。

---

## 2. 安裝完之後，先做這三件事

### 一、重新登入

```bash
exit
ssh 你@這台機器
cd yunzhi
docker ps        # 不用 sudo 就要看得到東西
```

**docker 群組要重新登入才會生效。**
沒有重新登入就下 `docker ps`，會得到
`permission denied while trying to connect to the Docker daemon socket`。
這時候不要加 `sudo` —— 加了之後產生的檔案都會變成 root 的，
往後每一個維運操作都得用 sudo，而備份腳本以一般身分跑不動。

### 二、備份 `.env`

```bash
# 複製到你的密碼管理器，或印出來鎖進抽屜
cat .env
```

**`BACKUP_ENCRYPTION_KEY` 弄丟等於所有加密備份作廢，沒有救援途徑。**

### 三、跑一次還原演練

**先做一份備份，再演練。** 自動備份是每天凌晨 3:15 才跑的，
剛裝好的機器上一份備份都還沒有，直接演練會得到
`在 /var/backups/yunzhi 找不到備份`。

```bash
./deploy/scripts/backup.sh          # 先手動做一份（全新系統約一分鐘）
./deploy/scripts/verify-restore.sh  # 再演練還原
```

未驗證過的備份等於沒有備份。演練會把備份還原到一個**暫時的**資料庫
並比對筆數，不會動到正式資料。

`backup.sh` 如果回 Permission denied，是備份目錄的擁有者不對
（安裝時你不是用 `sudo` 跑的、或中途換過操作帳號）：

```bash
sudo chown -R "$(id -un):$(id -gn)" /var/backups/yunzhi
```

---

## 3. 確認裝好了

```bash
# 一次跑完所有健檢，每一項失敗都附「下一步該做什麼」
./deploy/scripts/doctor.sh

# 三個端點
curl localhost:3000/api/healthz    # {"alive":true,...}      行程活著
curl localhost:3000/api/readyz     # {"ready":true,...}      資料庫與 Redis 都通
curl localhost:3000/api/version    # {"appVersion":"0.29.0"} 現在跑的是哪一版

# 容器狀態（全部要是 running，web / postgres / redis / minio 要是 healthy）
docker compose ps

# 從外面看
curl -I https://你的網域/
```

第一次啟動時 `readyz` 可能回 503，等 40 秒再試 —— 那是在等資料庫遷移跑完。

### 重開機之後會自己回來嗎

```bash
sudo systemctl status yunzhi-docker
```

要看到 `enabled`。真的要確認的話就重開一次：

```bash
sudo reboot
# 等兩分鐘再 ssh 進來
curl localhost:3000/api/readyz
```

---

## 4. 手動安裝（一鍵腳本失敗時，或你想知道它做了什麼）

### 4.1 Docker Engine

**用 Docker 官方的 apt 儲存庫。不要用 snap。**

snap 版的 Docker 跑在嚴格 confinement 底下，只看得到 `$HOME` 與 `/media`。
本系統把 `deploy/postgres/postgresql.conf`、`deploy/caddy/` 與
`/var/backups/yunzhi` 掛進容器，全部在 confinement 之外。
症狀不是「掛載失敗」而是**掛載變成空目錄**：Postgres 起得來，
但吃的是預設設定，WAL 歸檔沒開，RPO 從 15 分鐘悄悄變成 24 小時，
而所有健康檢查都是綠的。

如果已經裝了：

```bash
sudo snap remove docker
```

先移除發行版自帶的舊套件（**注意這會停掉機器上其他人的容器**）：

```bash
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  sudo apt-get remove -y $pkg
done
```

加入官方儲存庫並安裝：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

確認：

```bash
docker --version              # 要 20.10 以上
docker compose version        # **要有這個**。docker-compose（有連字號）是舊版 v1，不能用
sudo docker run --rm hello-world
```

開機自動啟動：

```bash
sudo systemctl enable --now docker containerd
```

### 4.2 docker 群組

```bash
sudo usermod -aG docker "$USER"
```

**然後登出再登入。** 這一步沒做，下一個 docker 指令就是 permission denied。

```bash
exit
ssh 你@這台機器
id -nG | tr ' ' '\n' | grep -x docker     # 要印出 docker
```

`newgrp docker` 只對當前這個子 shell 有效，離開就沒了 ——
會造成「剛剛還好好的，換一個視窗就不行」這種很難理解的狀況。
乾脆重新登入。

> **docker 群組等同 root。** 群組成員可以把宿主機的 `/` 掛進容器改任何檔案。
> 這是 Docker 的設計，不是本系統的問題。只把真正要維運這台機器的人加進來。

### 4.3 時區與語系

**時間是這樣運作的：資料庫一律存 UTC，畫面一律顯示台北時間，
中間的換算靠系統時區。** 所以機器的時區設錯不會有任何錯誤訊息 ——
只會讓每一場考試的開放與截止時間整整差八小時，而老師是在
「學生說進不去」的時候才發現。

```bash
# 時區。機器出廠通常是 UTC，差八小時——
# 「昨天下午的備份」會出現在今天早上的檔名裡，稽核記錄的時間也對不上。
sudo timedatectl set-timezone Asia/Taipei
sudo timedatectl set-ntp true
timedatectl                     # 確認 Time zone 與 System clock synchronized

# 語系。最小安裝常常只有 C/POSIX（charmap 是 ASCII），
# 這時候備份 tar 裡的中文檔名（「數學A_第三次模擬考.pdf」）
# 會在**還原的時候**才變成一串問號。
locale charmap                  # 要印出 UTF-8
```

不是 UTF-8 的話：

```bash
echo 'LANG=C.UTF-8' | sudo tee /etc/default/locale
# 登出再登入
```

要中文系統訊息的話另外裝 `zh_TW.UTF-8`：

```bash
sudo apt-get install -y locales
sudo locale-gen zh_TW.UTF-8
sudo update-locale LANG=zh_TW.UTF-8
```

### 4.4 防火牆

**這一節是 Ubuntu 上最容易出安全事故的地方，請完整看完。**

#### Docker 會繞過 ufw

Docker 發布連接埠時，是在 iptables 的 `nat/PREROUTING` 與 `FORWARD`
動手腳，而 ufw 的規則掛在 `INPUT`。結果是：

```bash
sudo ufw default deny incoming    # 看起來全部擋掉了
sudo ufw status                   # 顯示只開了 22、80、443
docker run -p 5432:5432 postgres  # 這個 5432 對全世界開著
```

`ufw status` 不會顯示這件事。`ss -ltn` 顯示 `0.0.0.0:5432`，
但看起來跟其他被 ufw 擋住的服務一模一樣。

本系統預設只有 Caddy 對外（80／443），web 綁在 `127.0.0.1`，
資料庫、Redis、MinIO 完全不發布連接埠 —— 所以**預設設定是安全的**。
風險在於「有人為了除錯，在 `docker-compose.yml` 加了一行 `ports:`」，
那一行會留在正式環境裡好幾年，而且沒有任何工具會提醒。

#### 設定

```bash
# 順序很重要：先放行 SSH，再啟用。反過來會把自己鎖在門外，
# 而且是遠端鎖在門外——沒有 KVM 的雲主機到這裡就結束了。
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status verbose
```

SSH 不是預設的 22 埠的話，改成你實際的埠號。

#### 讓 ufw 對容器也算數

`ubuntu-install.sh` 會自動做這一步。手動做的話，把下面這一段
加到 `/etc/ufw/after.rules` 的**最後面**（把 `eth0` 換成你的對外介面，
用 `ip route show default` 查）：

```
### BEGIN 雲端智學 DOCKER-USER
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER ! -i eth0 -j RETURN
-A DOCKER-USER -p tcp -m multiport --dports 80,443 -j RETURN
-A DOCKER-USER -m comment --comment "yunzhi-docker-user-drop" -j DROP
COMMIT
### END 雲端智學 DOCKER-USER
```

第二行的 `! -i eth0 -j RETURN` **不能省**：少了它，容器主動對外的
流量（AI API 呼叫、異地備份、apt）也會經過這條鏈而被 DROP，
症狀是 AI 全部逾時，而機器本身的網路看起來完全正常。

套用：

```bash
sudo ufw reload
sudo iptables -S DOCKER-USER        # 要看得到上面那幾條
sudo systemctl restart docker       # ufw reload 會沖掉 Docker 在 FORWARD 的規則
```

**最後那一行 `systemctl restart docker` 不能省。**
`ufw enable` 或 `ufw reload` 會重建 iptables 的內建鏈，Docker 掛在
`FORWARD` 上的跳轉可能一起被沖掉 —— 症狀是「容器之間通、對外不通」。

要移除這段規則：刪掉 `/etc/ufw/after.rules` 裡那個區塊，然後
`sudo ufw reload && sudo systemctl restart docker`。

### 4.5 目錄與權限

```bash
# 備份目錄。預設 /var/backups/yunzhi，一般使用者建不出來。
# 不先建好的話 Docker 會建成 root 的，於是宿主機上手動跑
# backup.sh / restore.sh / verify-restore.sh 全部寫不進去——
# 而那三支正是「出事那天」才第一次被執行的腳本。
# -g 要用 id -gn 而不是 "$USER"：帳號的主要群組不一定與帳號同名
# （網域帳號、或 MIS 把人放進 staff 群組時就不是），寫錯的話
# install 會以「invalid group」中止。
sudo install -d -m 0750 -o "$(id -un)" -g "$(id -gn)" /var/backups/yunzhi

# compose 會 bind mount 這幾個目錄。它們在 .gitignore 裡，
# 全新 clone 上不存在，不先建好就會變成 root 的。
mkdir -p deploy/caddy/certs deploy/caddy/maintenance data/models

# AI 容器以 uid 10001 執行，字形快取要寫得進去
chmod 0777 data/models

# .env 有資料庫密碼、AI 金鑰與備份加密金鑰
chmod 600 .env
ls -l .env       # 要是 -rw-------
```

### 4.6 安裝

```bash
./deploy/scripts/docker-install.sh
```

---

## 5. 離線安裝（機房沒有對外網路）

建置需要連到兩個地方，**兩個都是硬需求**：

- **Docker Hub** —— 基底映像（pgvector、redis、minio、caddy）
- **binaries.prisma.sh** —— Prisma 的查詢引擎。它是執行期的硬相依，
  建置時下載並烤進映像。抓不到就沒有可用的映像，不是「少了某個功能」。

企業防火牆很常放行前者卻擋掉後者，而那會讓建置在第 8 分鐘才失敗。

### 在一台有網路、**同架構**的機器上打包

```bash
git clone <你的儲存庫> yunzhi && cd yunzhi
./deploy/scripts/build-offline-bundle.sh
# 產出 yunzhi-offline-<版本>-<架構>.tar.gz（約 3 至 5 GB）與 .sha256
```

架構必須一致。x86_64 上打的包在 aarch64 機器上 `docker load` 得進去，
但容器一啟動就 `exec format error` —— 那個錯誤看起來像映像壞了。
載入時腳本會擋下來。

目標機器上還沒有 Docker 的話，順便把 deb 檔帶過去：

```bash
sudo apt-get install -y --download-only \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
mkdir docker-debs && cp /var/cache/apt/archives/*.deb docker-debs/
```

### 在目標機器上

```bash
# 先驗證檔案沒有在搬運途中損毀
sha256sum -c yunzhi-offline-*.tar.gz.sha256

tar -xzf yunzhi-offline-*.tar.gz
cd yunzhi

# 沒有 Docker 的話先裝
sudo dpkg -i ../docker-debs/*.deb

cp .env.example .env
./deploy/scripts/gen-secrets.sh
nano .env

sudo ./deploy/scripts/ubuntu-install.sh --offline
```

`--offline` 會跳過建置，改成從 `offline/images.tar.gz` 載入映像，
並逐一確認每個映像都真的載進來了（`docker load` 對「檔案裡少了一個
映像」是不會抱怨的，而少掉的那一個要等到 compose up 才發現）。

已經有 Docker 的機器可以只跑後半段：

```bash
./deploy/scripts/docker-install.sh --offline
```

---

## 6. 日常維運

### 開學前：建班級、匯名冊、發密碼

學生端在 v0.20.0 上線，完整動線是
**組卷 → 派卷 → 學生作答 → 自動計分 → 老師看全班 → 學生看檢討**。
在那之前要先有班級與學生帳號。

匯入名冊在班級頁（`班級 → 匯入名冊`），CSV 或貼上皆可。

**兩百人的名冊大約要等一分鐘，畫面會停著不動 —— 那是正常的。**
慢的是密碼雜湊：每個學生一組 bcrypt，一次約 300 毫秒，兩百人就是
一分鐘左右。不要重新整理、不要按第二次（會匯出兩份重複的帳號）。
匯入路由的上限設在 5 分鐘，兩百人有很大的餘裕。

> 如果你在 v0.20.0 之前試過匯入而失敗，錯誤是
> `Transaction already closed` —— 那是舊版的問題（超過約 16 人的名冊
> 必定整份失敗），這一版已經修掉，直接重匯即可。

### 學生忘記密碼

在**班級頁**（`班級 → 選一個班`），不需要動資料庫、也不必重匯名冊：

| 情況 | 做法 | 結果 |
|---|---|---|
| 一個學生站在辦公室說登不進去 | 名冊那一列的「重設密碼」 | 當場產生一組臨時密碼，**只顯示這一次**，抄給他 |
| 整班第一次登入前要重發 | 「重設全班密碼」 | 全班的舊密碼立刻失效 |

「重設全班密碼」會要求你**完整打出班級名稱**才能按下去。那不是刁難：
它擋的是按到隔壁那一班 —— 而那個後果是三十個人明天早上都登不進去，
其中沒有一個人知道為什麼。

學生自己改密碼在 `設定 → 變更密碼`。

### 數學式與化學式

題目裡的數學式（`$x^2$`）與化學式（`\ce{H2SO4}`）由 KaTeX 排版。
**字型與 CSS 全部打包在映像裡，不連任何 CDN** —— 機房封閉網段也排得
出來，而且資料不出校。

裝好之後值得順手確認一次：開一份含數學式的題目，公式要是**排版過的**
（分數有橫線、上下標有大小差別），不是一串 `\frac{1}{2}` 原始碼。
看到原始碼的話多半是題目本身沒有用 `$…$` 包起來，不是字型問題。

### 看日誌

```bash
cd yunzhi                                   # 所有 docker compose 指令都要在這裡下

docker compose logs -f web                  # 主應用，即時
docker compose logs --tail 200 web          # 最近 200 行
docker compose logs --since 30m worker      # 最近 30 分鐘的背景工作
docker compose logs ai | grep -i error      # AI 服務的錯誤

# 開機啟動那一層（不是應用日誌，是「有沒有起來」）
sudo journalctl -u yunzhi-docker -n 50
```

日誌會自動輪替（每個容器上限 100MB × 5 份），不會把磁碟寫滿。

### 看狀態

```bash
./deploy/scripts/doctor.sh          # 每一項失敗都附「下一步該做什麼」
./deploy/scripts/doctor.sh --json   # 給監控系統用

docker compose ps                   # 誰起來了、健康狀態
docker stats --no-stream            # 誰在吃記憶體與 CPU
df -h /var/lib/docker               # 磁碟
```

### 進資料庫看一下

```bash
./deploy/scripts/db-shell.sh --readonly -c 'SELECT count(*) FROM questions'
```

沒有指定 `--tenant` 時多數查詢會回 0 列 —— 那是 RLS（列級安全）在
擋，**不是資料不見了**。要看某個租戶的資料：

```bash
./deploy/scripts/db-shell.sh -c 'SELECT id, name FROM tenants'
./deploy/scripts/db-shell.sh --tenant <上面查到的 id>
```

### 備份

備份是自動的（每天凌晨 3:15，跑在 `backup` 容器裡）。手動跑一次：

```bash
./deploy/scripts/backup.sh
ls -lh /var/backups/yunzhi/
```

備份包含資料庫、物件儲存（題本原檔與附圖）與 WAL 歸檔。
**只備份資料庫是不夠的** —— 資料庫裡存的只是物件鍵，
還原出來會是一整套指向不存在檔案的死連結。

驗證備份真的能還原（不會動到正式資料）：

```bash
./deploy/scripts/verify-restore.sh
```

**每季至少做一次。** `doctor.sh` 會在超過 92 天沒演練時報失敗。

還原：

```bash
./deploy/scripts/restore.sh /var/backups/yunzhi/yunzhi-20260728-031500.tar.gz
```

還原時如果那份備份不含物件儲存，腳本會在**覆蓋資料庫之前**停下來要你
打一次 `RESTORE WITHOUT OBJECTS`。那不是形式——用一份沒有物件的備份
還原，出來的系統每一道「如右圖」的題目都是空白的。

### 異地備份與金鑰保管

**這一節是「這台機器毀了會怎樣」的答案，預設狀態的答案是「全沒了」。**

裝好之後的預設是：

| 東西 | 在哪裡 |
|---|---|
| 資料庫 | 這台機器的磁碟 |
| 每日備份 | **同一顆磁碟**（`/var/backups/yunzhi`） |
| 解密備份用的 `BACKUP_ENCRYPTION_KEY` | **同一台機器**的 `.env` |

三樣東西在同一個籃子裡。磁碟壞掉、機器被偷、機房淹水、勒索軟體加密整台——
任何一種都會讓資料庫與全部備份一起消失，而且備份是加密的，
**就算你有一份複本、沒有那把金鑰，它在數學上也還原不回來**。

`doctor.sh` 會提醒這件事（`backup.offsite`），設定好之後那一項轉綠。

**第一步：把金鑰放到機器以外的地方。** 今天就做，五分鐘：

```bash
grep '^BACKUP_ENCRYPTION_KEY=' .env
```

把那一整行貼進密碼管理器，或印出來鎖進抽屜。**不要只存在這台機器上，
也不要只存在同一間機房的另一台機器上。**

**第二步：把備份複製到別的地方。** 系統支援任何 S3 相容端點
（另一台機器上的 MinIO、NAS 的 S3 服務、雲端物件儲存都可以）。
在 `.env` 填四個欄位：

```bash
BACKUP_REMOTE_ENDPOINT=https://s3.你的儲存空間
BACKUP_REMOTE_BUCKET=yunzhi-backup
BACKUP_REMOTE_ACCESS_KEY=<存取金鑰>
BACKUP_REMOTE_SECRET_KEY=<秘密金鑰>
```

```bash
docker compose up -d backup     # 套用設定
docker compose logs --tail 30 backup
```

下一次備份完成後日誌會出現「已複製到異地」。沒有出現就是設定不對——
那一行的下一句會寫「異地複製失敗——這份備份只存在本機磁碟上」。

**沒有 S3 端點可用時的替代做法**，一樣有效，只是要自己排程：

```bash
# 例：每天 05:00 把最新的備份 rsync 到另一台機器
# crontab -e
0 5 * * * rsync -a --delete-after \
  $(ls -t /var/backups/yunzhi/yunzhi-*.tar.gz* | head -4) \
  備份帳號@另一台機器:/srv/yunzhi-backup/
```

**第三步：驗證異地那一份真的能用。** 一份沒有被還原過的異地備份
與沒有備份的差別只是心理上的。把它抓回來跑一次：

```bash
./deploy/scripts/verify-restore.sh /path/to/從異地抓回來的備份.tar.gz.enc
```

### 升級

```bash
git fetch --tags
git tag -l 'v*' --sort=-v:refname | head -5     # 有哪些版本可以升
git checkout v<要升到的版本>                     # 例如最上面那一個
./deploy/scripts/upgrade.sh
```

**不要照抄某一份文件裡寫死的版本號。** 文件會過期，而 checkout 到一個
比現在還舊的標籤是**會成功的**——沒有任何錯誤訊息，然後你裝出一個少了
幾條動線的系統。要升到哪一版由 `git tag` 的輸出決定，不是由文件決定。

它會：檢查有沒有人正在考試 → 記錄回滾點 → 完整備份 → 建置新版
（這一步失敗不影響現有服務）→ 進維護模式 → 遷移 → 重啟 → 驗證，
失敗自動回滾。

第一步是真的會擋的：有任何一份作答的狀態是「進行中」，腳本就中止並
告訴你有幾份。要在考試中硬升級得自己加 `--force`。

### 回滾

```bash
./deploy/scripts/rollback.sh
```

**回滾會把資料庫還原到升級前**，升級後產生的作答、成績、匯入的題目
都會消失。所以回滾是「剛升級完發現不對」的手段，不是「用了三天覺得
不好」的手段。只想退程式版本、保留資料：

```bash
./deploy/scripts/rollback.sh --code-only
```

回滾前先確認你要回哪一版：

```bash
curl localhost:3000/api/version
```

**回滾需要舊版的映像還在這台機器上。** 磁碟滿的時候最自然的動作是
`docker image prune`，而它會把舊版映像刪掉——離線 tarball 部署的目錄
裡沒有 `.git`，所以連「重新建置舊版」這條退路也是斷的。
`rollback.sh` 會在動資料庫**之前**先檢查這件事並告訴你怎麼辦，
但最省事的做法是每次升級成功之後先把舊版存起來：

```bash
OLD=$(curl -s localhost:3000/api/version | grep -oP '"appVersion":"\K[^"]+')
mkdir -p /var/backups/yunzhi/images
# 只有兩個自家映像。worker 與 migrate 用的是同一個 yunzhi/web 映像，
# 只是啟動指令不同 —— **沒有 yunzhi/worker 這個標籤**，寫進去的話
# docker save 會整個失敗。
docker save "yunzhi/web:${OLD}" "yunzhi/ai:${OLD}" \
  -o "/var/backups/yunzhi/images/yunzhi-${OLD}.tar"
gzip -f "/var/backups/yunzhi/images/yunzhi-${OLD}.tar"
ls -lh "/var/backups/yunzhi/images/yunzhi-${OLD}.tar.gz"
```

**最後那一行 `ls -lh` 不是裝飾。** 這個指令原本寫成
`docker save … | gzip > 檔案`，而 `docker save` 對不存在的映像是整個
失敗、stdout 一個位元組都不吐——但 `gzip` 照樣會產出一個幾十位元組的
檔案。看到檔案在，就以為退路備好了，直到升級出事那天才發現它是空的。
檔案大小應該是好幾百 MB；只有幾十位元組就是上面那句失敗了。

要用的時候 `gunzip -c yunzhi-<版本>.tar.gz | docker load`。
留最近兩版就夠了，再舊的資料庫 schema 也對不上。

### 改設定之後套用

```bash
nano .env
./deploy/scripts/docker-install.sh      # 重跑即可，它是可重複執行的
```

---

## 7. 出事的時候，先看什麼

**照順序。** 每一步都會縮小範圍。

```bash
cd yunzhi

# 1. 誰沒起來
docker compose ps

# 2. 一次跑完所有健檢
./deploy/scripts/doctor.sh

# 3. 應用日誌的最後 100 行
docker compose logs --tail 100 web
```

### 對照表

| 症狀 | 先看 | 多半是什麼 |
|---|---|---|
| 瀏覽器 502 | `docker compose ps` | web 沒起來或還在啟動（等 40 秒） |
| 瀏覽器憑證警告 | `.env` 的 `TLS_MODE` 與 `TLS_DIRECTIVE` | 兩者不一致，跑 `./deploy/scripts/render-caddy.sh` 修正後重啟 caddy |
| web 一直重啟 | `docker compose logs web` | 設定錯誤，日誌會寫出缺哪一項 |
| `permission denied ... docker.sock` | `id -nG \| grep docker` | 沒重新登入 |
| 匯入卡住不動 | `docker compose logs worker` | worker 掛了，或 AI 服務連不上 |
| AI 全部逾時 | `docker compose exec ai curl -I https://你的AI端點` | 容器出不去（防火牆規則少了 `! -i` 那一行） |
| 磁碟滿了 | `df -h`、`du -sh /var/backups/yunzhi` | 備份保留期太長，或 WAL 歸檔沒被清 |
| 資料庫連不上但密碼看起來對 | `docs/OPERATIONS.md` 金鑰輪替 | 改過 `.env` 但沒改資料庫端的密碼 |
| 重開機後網站是關的 | `sudo systemctl status yunzhi-docker` | 開機單元沒 enable，或有人下過 `docker compose stop` |
| 學生說交了卷卻沒分數 | 成績頁看那一列 | 逾時沒交，要代為結算 —— 見下面 |
| 學生看不到成績 | 成績頁的「放行成績」 | `releasePolicy=MANUAL` 要老師手動放行 |

### 考試當天的兩個急救動作

**這兩件事都在成績頁**（`任務 → 選一份任務 → 看成績`），
不需要進資料庫、不需要 SSH，監考老師自己就能做。

#### 一、代為結算「逾時未交」的那一份

**症狀**：時間到了，但學生沒有按下交卷 —— 筆電沒電、瀏覽器當掉、
網路斷了而且沒有再回來。那一份會一直停在「進行中」：
**學生自己看到的是「已完成」卻沒有分數，而老師的全班列表裡少一個人。**

**做法**：在成績頁找到那一位，按「代為結算」，確認視窗的按鈕是
`結算並計分`。

按下去之後他已經寫的答案會照一般流程計分，立刻出現在全班列表裡。
**沒寫到的題目都是 0 分** —— 時間到了本來就是這個結果，但先跟學生
講清楚，不然他會以為系統把答案弄丟了。

#### 二、作廢一份作答

**症狀**：作弊、代考、或斷電毀掉一份卷子。在此之前老師手上只有兩個
選擇：留著一個不該算的分數，或者刪掉整份任務（連同其他三十個人的
作答）。

**做法**：在成績頁找到那一位，按「作廢」，**必須填寫理由**，
確認按鈕是 `作廢這一份`。

作廢之後這一份**不計分、不進班級統計**（平均、答對率、級分換算都不
再算他）。按錯了可以「撤銷作廢」，同樣要填理由。

理由是必填的，因為三個月後家長來問的時候，唯一還在的東西就是那一句。
記錄上寫著「王老師在 9 月 3 日作廢了一份」而沒有人說得出為什麼，
等於沒有稽核。

### 深入一點

```bash
# 資料庫是不是活著
./deploy/scripts/db-shell.sh -c 'SELECT 1'

# AI 服務的自我檢測（會實際打一次上游，確認金鑰與模型名稱都對）
docker compose exec ai python -c "
import urllib.request,json
req=urllib.request.Request('http://127.0.0.1:8000/selftest',method='POST')
print(json.dumps(json.load(urllib.request.urlopen(req,timeout=120)),ensure_ascii=False,indent=2))"

# 容器內部的網路（web 看得到 postgres 嗎）
docker compose exec web node -e "fetch('http://ai:8000/healthz').then(r=>console.log(r.status))"

# 從最底層看：容器有沒有被 OOM killer 砍掉
dmesg -T | grep -i 'killed process'
docker inspect yunzhi-postgres --format '{{.State.OOMKilled}}'
```

### 真的救不回來

`docs/DISASTER-RECOVERY.md`，裡面有從備份完全重建的流程。

---

## 8. 移除

```bash
# 停止並移除容器與網路，資料全部保留
./deploy/scripts/docker-uninstall.sh

# 先看會刪什麼，不真的刪
./deploy/scripts/docker-uninstall.sh --dry-run

# 連資料一起刪（會先要求確認有備份）
./deploy/scripts/docker-uninstall.sh --purge --backup-first
```

備份**永遠不會**被這支腳本刪除。

系統層的東西要自己處理（腳本刻意不碰，因為機器上可能還有別的服務）：

```bash
sudo systemctl disable --now yunzhi-docker
sudo rm /etc/systemd/system/yunzhi-docker.service
sudo systemctl daemon-reload

# 防火牆規則（刪掉 ### BEGIN/END 雲端智學 DOCKER-USER 之間那一段）
sudo nano /etc/ufw/after.rules
sudo ufw reload && sudo systemctl restart docker
```

---

## 相關文件

| 文件 | 內容 |
|---|---|
| `docs/INSTALL.md` | 安裝的完整選項，含原生安裝與外部 nginx |
| `docs/OPERATIONS.md` | 日常維運、容量規劃、金鑰輪替 |
| `docs/DISASTER-RECOVERY.md` | 災難還原 |
| `docs/UNINSTALL.md` | 完整移除 |
