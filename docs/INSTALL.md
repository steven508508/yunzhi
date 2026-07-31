# 安裝指南

適用於 Ubuntu Server 22.04 LTS 以上（建議 24.04 LTS）。

> **從一台全新的 Ubuntu 開始，請看 [`docs/UBUNTU.md`](UBUNTU.md)。**
> 那份是逐指令的操作手冊：Docker 怎麼裝、docker 群組為什麼要重新登入、
> ufw 為什麼擋不住容器、時區與語系要設什麼、出事先看哪裡。
> 這一份講的是安裝的**選項**（原生安裝、外部 nginx、TLS、AI、離線）。

兩條路徑：**Docker（建議）** 與 **原生安裝**。兩者的功能完全一致，
差別只在相依套件由誰管理。除非貴機構有不能跑 Docker 的政策，
否則選 Docker —— 它的升級與解除安裝乾淨得多。

---

## 硬體需求

| 項目 | 最低 | 建議 | 說明 |
|---|---|---|---|
| CPU | 2 核 | 4 核以上 | 300 人同時作答時，AI 匯入會與作答搶 CPU |
| 記憶體 | 4GB | 8GB 以上 | 低於 4GB，PostgreSQL 與 AI 服務會互相搶記憶體並被 OOM killer 砍掉 |
| 磁碟 | 20GB | 50GB 以上 SSD | 題庫、題本原檔、備份會持續成長 |
| 網路 | — | 對外可達 | 離線環境見下方「離線安裝」 |

`preflight.sh` 會實際量測這幾項並在不足時明確指出。

---

## Docker 安裝

### 全新的 Ubuntu：一支腳本做完

```bash
git clone <你的儲存庫> yunzhi && cd yunzhi
cp .env.example .env
./deploy/scripts/gen-secrets.sh
nano .env                                  # 見下方「至少要改的幾項」
sudo ./deploy/scripts/ubuntu-install.sh
```

`ubuntu-install.sh` 會處理 Docker 安裝（官方 apt 儲存庫）、docker 群組、
系統需求檢查、時區與語系、ufw 防火牆（**含 Docker 繞過 ufw 這件事**）、
目錄權限、開機自動啟動，然後才進安裝流程並驗收。
逐步說明與手動做法見 [`docs/UBUNTU.md`](UBUNTU.md)。

已經有 Docker 的機器直接跳到第 3 步。

### 1. 安裝 Docker

用 **Docker 官方的 apt 儲存庫**，不要用 snap ——
snap 的 confinement 會讓本系統的 bind mount 靜默變成空目錄
（Postgres 起得來但吃預設設定，WAL 歸檔沒開，而健康檢查全綠）。
完整指令見 [`docs/UBUNTU.md` 第 4.1 節](UBUNTU.md)。

```bash
sudo usermod -aG docker "$USER"
exit && ssh 回來             # 群組要**重新登入**才生效
```

`newgrp docker` 只對當前那個子 shell 有效，換一個視窗就沒了 ——
會造成「剛剛還好好的」這種很難理解的狀況。乾脆重新登入。

### 2. 取得程式並設定

```bash
git clone <你的儲存庫> yunzhi && cd yunzhi
cp .env.example .env
./deploy/scripts/gen-secrets.sh
```

`gen-secrets.sh` 會產生所有密碼與金鑰，並印出一次性的初始管理員密碼。
**把它記下來**，畫面關掉就看不到了（雖然它也會寫進 `.env`）。

接著編輯 `.env`，至少要改這幾項：

```bash
APP_DOMAIN=yunzhi.你的網域
APP_URL=https://yunzhi.你的網域
TLS_MODE=letsencrypt        # 內網部署用 internal
ACME_EMAIL=你的信箱          # letsencrypt 才需要
BOOTSTRAP_ADMIN_EMAIL=管理員信箱
```

`TLS_DIRECTIVE` 那一行**不要手動改**。Caddyfile 不支援條件式，
所以 `tls` 指示詞是用那個變數展開的，而它由 `render-caddy.sh` 依
`TLS_MODE` 自動寫入（安裝腳本會先跑一次）。兩邊不一致的後果特別難查：
Caddy 會用本地 CA 簽一張憑證發給全校，服務起得來、`doctor.sh` 全過，
但每一台學生電腦都看到「你的連線不是私人連線」。手動改過 `.env` 之後：

```bash
./deploy/scripts/render-caddy.sh        # 依 TLS_MODE 更新 TLS_DIRECTIVE
./deploy/scripts/render-caddy.sh --check # 只檢查一致性
```

AI 的部分見下方「AI 設定」。第一次安裝可以保持 `AI_PROVIDER=mock`，
之後隨時改設定重跑安裝腳本即可套用。

### 3. 安裝

```bash
./deploy/scripts/docker-install.sh
```

腳本會依序做環境檢查、建置映像、啟動基礎服務、資料庫遷移、
啟動應用、健康驗證，每一步都有明確的成功或失敗訊息。
第一次建置需要下載基底映像，視網路約 5 至 15 分鐘。

### 4. 上線前必做

```bash
# 一、先手動做一份備份（全新系統約一分鐘）
#     **順序不能顛倒。** 自動備份要等到凌晨 03:15 才第一次執行，
#     剛裝好的機器上直接跑演練，只會得到
#     「在 /var/backups/yunzhi 找不到備份」。
./deploy/scripts/backup.sh

# 二、驗證那份備份真的能還原（未驗證的備份等於沒有備份）
#     它會還原到一個暫時的資料庫再刪掉，不會動到正式資料。
./deploy/scripts/verify-restore.sh

# 三、把 .env 備份到密碼管理器或離線儲存
#     遺失 BACKUP_ENCRYPTION_KEY 等於所有加密備份作廢，沒有救援途徑
```

`backup.sh` 若回 Permission denied，是備份目錄的擁有者不對（安裝時
不是用 `sudo` 跑的、或中途換過操作帳號）：

```bash
sudo chown -R "$(id -un):$(id -gn)" /var/backups/yunzhi
```

---

## 原生安裝

```bash
sudo ./deploy/scripts/install.sh
```

它會安裝系統套件、建立專用使用者 `yunzhi`、部署程式、設定
PostgreSQL 與 Redis、註冊 systemd 服務、設定 Caddy。

**每一項新增的東西都記錄在 `/etc/yunzhi/install-manifest.txt`**，
`uninstall.sh` 讀同一份清單，因此只會移除本次安裝帶來的東西 ——
機器上原本就有的 PostgreSQL 不會被動到。

安裝位置：

| 路徑 | 內容 |
|---|---|
| `/opt/yunzhi` | 程式 |
| `/etc/yunzhi/env` | 設定（權限 600） |
| `/var/lib/yunzhi` | 資料、物件儲存、WAL 歸檔 |
| `/var/log/yunzhi` | 日誌 |
| `/var/backups/yunzhi` | 備份 |

服務控制：

```bash
systemctl status yunzhi-web yunzhi-worker yunzhi-ai
journalctl -u yunzhi-web -f
```

---

## 使用既有的 nginx（PROXY_MODE=external）

伺服器上已經有 nginx 或其他反向代理時，讓它負責 TLS 與對外流量，
本系統只綁在 loopback 上等它轉發。**這是多數機構的實際情況** ——
伺服器很少只跑一個服務。

```bash
# .env
PROXY_MODE=external
WEB_BIND=127.0.0.1        # 一定要 127.0.0.1，不要 0.0.0.0
WEB_BIND_PORT=3000
```

設定之後重跑安裝，內建的 Caddy 就完全不會啟動：

```bash
./deploy/scripts/docker-install.sh
sudo ./deploy/scripts/setup-nginx.sh
```

`setup-nginx.sh` 會偵測 nginx 版本（1.25.1 前後的 HTTP/2 語法不同）
與 IPv6 是否啟用，產生對應的設定，**並在 `nginx -t` 通過之後才 reload** ——
設定有錯會自動移除連結，機器上其他站台完全不受影響。

先看產生出來的內容而不安裝：

```bash
./deploy/scripts/setup-nginx.sh --print
```

站台設定的六個關鍵點，自己改設定時不要漏掉：

**`client_max_body_size 200M`** — nginx 預設 1M，不改的話匯入題本
會直接壞掉，而且回的是 413，看不出是哪一層擋的。

**`X-Forwarded-For`** — 少了它，稽核記錄裡所有事件的來源 IP 都會是
`127.0.0.1`，誠信事件調查時等於沒有資訊。

**`X-Forwarded-Proto`** — 少了它，系統會以為自己在 http 上，
登入後的轉址會掉回 http，使用者看到的是登入成功又被踢回登入頁。

**`X-Frame-Options: DENY`** — 防作弊的全螢幕鎖定與焦點偵測可以用
iframe 包起來繞過。少了這一條，考試模式的鎖定形同虛設。

**`/api/tutor/stream` 關閉 `proxy_buffering`** — 否則智慧老師的回應會
變成「轉圈圈 20 秒然後一次跳出全部文字」，對話式教學的體感完全消失。

**`proxy_read_timeout 300s` 以上** — 預設 60 秒。考試是長連線，
題本解析的 API 也可能很慢。

### 手動整合：不讓系統碰你的 nginx 設定

機器上已經有其他站台、或用宝塔／aaPanel 之類的面板管理時，多數人
不會希望安裝腳本去動 `/etc/nginx`。**這是完全支援的做法**：

安裝流程本身不碰 nginx。`docker-install.sh` 只會在結尾印出建議文字，
`preflight.sh` 會執行 `nginx -v` 與 `nginx -t`，但那是唯讀檢查（順帶
幫你確認既有設定沒壞）。**只要不執行 `setup-nginx.sh`，就沒有任何
東西會寫進你的 nginx 設定。**

範本在 `deploy/nginx/yunzhi.conf`，自己抄過去改。往既有設定裡加的
時候，下面四個陷阱各自都會造成「看起來設好了但沒有作用」：

**先查 http 層級的指令有沒有撞名。** 範本裡的 `limit_req_zone`（兩個
zone）與 `map $http_upgrade`（`$connection_upgrade`）是 http 區塊層級
的。既有設定若已定義過同名的，nginx 會直接 emerg 起不來——**連帶把
機器上其他站台一起弄掉**。套用前先確認：

```bash
grep -rn "limit_req_zone\|map \$http_upgrade" /etc/nginx/nginx.conf /etc/nginx/conf.d/
```

面板產生的設定多半已經定義好 `$connection_upgrade`，那就把範本裡
那段 map 刪掉。

**`location ^~ /` 會讓所有正則 location 失效。** 面板產生的反向代理
設定常常長這樣。`^~` 的語義是「前綴命中就停止，不再比對正則」，
所以你照範本加的 `location ~ ^/api/tutor/stream` **永遠不會被命中**，
而且不會有任何錯誤訊息——症狀是智慧老師依然一次跳出全文。

新增的 location 要寫成前綴式並且更長，才會贏：

```nginx
location ^~ /api/tutor/stream { ... }
```

同理，那類設定裡的「禁止存取敏感檔案」正則區塊其實也從未生效
（不影響安全，請求都轉給應用了，但別誤以為它擋著）。

**`add_header` 不會繼承。** 只要某個 location 裡出現任何一個
`add_header`，server 層的**全部消失**。SSE 那段需要
`add_header X-Accel-Buffering "no"`，所以那個 location 裡必須把
`X-Frame-Options` 等安全標頭原樣重複一次——否則你只是關掉緩衝，
順手把防作弊的 iframe 防護一起關了。

**面板會覆寫你的修改。** 宝塔在 UI 裡動一次反向代理設定，
`#PROXY-CONF-START/END` 之間就會重新產生。自訂的 location 要放在
那個區塊**外面**，或放進面板留給自訂設定的 include 目錄
（宝塔是 `/www/server/panel/vhost/nginx/extension/<網域>/`）。

### 速率限制：學校要按帳號，不要按 IP

範本附了 `limit_req_zone $binary_remote_addr` 的登入限流。**校園環境
請不要直接套用**：整班學生走同一條對外線路出去，在 nginx 眼中是同一
個來源 IP，按 IP 限流會在全班同時交卷時擋到真的學生——而那正是最
不能出事的時刻。

要防暴力嘗試的話應該在應用層按帳號限，不是在反向代理按 IP。

### 外部代理 ＋ 多實例

發布固定主機埠時 `WEB_REPLICAS` 必須為 1，否則會埠衝突。需要多實例時
兩種作法：把 `WEB_REPLICAS` 保持 1 但加大單一實例的資源（300 人規模
通常足夠），或改用內建 Caddy 當內部負載平衡器（綁 `127.0.0.1:8080`，
不處理 TLS），由 nginx 轉發到 Caddy。

### 憑證

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yunzhi.你的網域
```

內網無公開網域時改用自簽憑證，並修改站台設定中的 `ssl_certificate` 路徑。

---

## TLS 設定（僅內建 Caddy 模式）

### 公開網域（`TLS_MODE=letsencrypt`）

需要網域指向這台機器，且 80／443 對外可達。Caddy 會自動申請與續期。

### 內網部署（`TLS_MODE=internal`）

Caddy 用本地 CA 簽發憑證。學生電腦需要安裝這張根憑證，否則瀏覽器
會出現警告：

```bash
./deploy/scripts/export-ca.sh      # 匯出根憑證交給 MIS 派送
```

這張根憑證**只讓瀏覽器信任本站**，不會也不能用來解密其他網站的
流量 —— 與規格書文件 08 明確否決的 TLS 攔截是完全不同的東西。
對家長說明時這一點值得講清楚。

### 自備憑證（`TLS_MODE=custom`）

把 `fullchain.pem` 與 `privkey.pem` 放進 `deploy/caddy/certs/`，
並依 `deploy/caddy/Caddyfile` 註解調整設定。

---

## AI 設定

系統支援 Anthropic 與 OpenAI 兩種協定，**兩者都可以指定自訂 Base URL**，
所以可以接官方端點、企業閘道、代理、或自架推論服務。切換不需要改
任何程式碼。

```bash
# Anthropic 官方
AI_PROVIDER=anthropic
AI_BASE_URL=                       # 留空用官方端點
AI_API_KEY=sk-ant-...
AI_MODEL_HIGH=claude-opus-4-20250514
AI_MODEL_MID=claude-sonnet-4-20250514
AI_MODEL_LIGHT=claude-haiku-4-20250514

# OpenAI 官方
AI_PROVIDER=openai
AI_BASE_URL=
AI_API_KEY=sk-...
AI_MODEL_HIGH=gpt-4o

# 自訂閘道（LiteLLM、one-api、Cloudflare AI Gateway…）
AI_PROVIDER=openai                 # 多數閘道走 OpenAI 協定
AI_BASE_URL=https://gateway.example.com/v1
AI_API_KEY=閘道的金鑰
AI_MODEL_HIGH=閘道認得的模型名稱

# 自架推論（vLLM、Ollama）
AI_PROVIDER=openai
AI_BASE_URL=http://vllm:8000/v1
AI_API_KEY=dummy                   # 多數自架服務不驗證
```

**接自訂閘道時最常見的錯誤是 Base URL 少了路徑前綴。** OpenAI 協定的
端點是 `{BASE_URL}/chat/completions`，所以 `AI_BASE_URL` 通常要以
`/v1` 結尾。設錯會得到 404，而錯誤訊息會明確告訴你這件事。

改完設定後驗證：

```bash
docker compose restart ai
docker compose exec ai python -c "
import urllib.request,json
req=urllib.request.Request('http://127.0.0.1:8000/selftest',method='POST')
print(json.dumps(json.load(urllib.request.urlopen(req,timeout=120)),ensure_ascii=False,indent=2))"
```

`/selftest` 會對三個模型層級各實際打一次，確認 key、Base URL、
模型名稱三者都對。設定看起來對不等於設定真的對。

### 嵌入模型：這一組現在還沒有接上

Anthropic 協定沒有嵌入端點，所以 `.env` 裡的 `EMBEDDING_*` 是為了將來
獨立設定嵌入模型而預留的。**目前這一組完全沒有作用**：題目去重與
相似題檢索走的是 PostgreSQL 的 `pg_trgm`（字串相似度）退路，
沒有任何嵌入模型在跑。

所以有一件事要特別講，因為它被誤會過：

> **把 `EMBEDDING_PROVIDER` 改成 `openai` 不會省下任何記憶體。**
> 本機沒有嵌入模型佔著那 2GB。8GB 的機器上改這一項、重跑安裝、
> 然後發現記憶體完全沒變，是白花的一個下午。

記憶體真的吃緊（8GB 或以下）時，有效的是這三件事：

```bash
AI_MEMORY_LIMIT=2g          # 預設 4g，解析大型 PDF 時最吃記憶體的就是它
POSTGRES_MEMORY_LIMIT=1g    # 預設 2g
```

以及**不要在考試時段匯入題本**——那是這台機器一天之中記憶體與 CPU
同時最緊的時刻，而考試中斷的代價遠高於題本晚一小時入庫。

### AI 不可用時會怎樣

不會影響考試。作答、客觀題評分、檢視已生成的解析都照常運作，
只有 AI 相關功能降級（規格書文件 01 §16 的降級要求）。
`readyz` 刻意不把 AI 納入就緒條件，就是為了讓 AI 掛掉不會演變成
整個考試系統不可用。

---

## 離線安裝

建置需要連到兩個地方，**兩個都是硬需求**：

- **Docker Hub** —— 基底映像（pgvector、redis、minio、caddy）
- **binaries.prisma.sh** —— Prisma 的查詢引擎。它是執行期的硬相依，
  建置時下載並烤進映像。抓不到就沒有可用的映像，不是「少了某個功能」。

企業防火牆很常放行前者卻擋掉後者。`preflight.sh` 會分開測這兩個目標，
因為只測 Docker Hub 的話，建置會在第 8 分鐘才以一個看不出原因的錯誤失敗。

在一台有網路、**架構相同**的機器上打包：

```bash
./deploy/scripts/build-offline-bundle.sh
# 產出 yunzhi-offline-<版本>-<架構>.tar.gz（約 3 至 5 GB）與 .sha256
```

架構必須一致。x86_64 上打的包在 aarch64 機器上 `docker load` 得進去，
但容器一啟動就 `exec format error` —— 載入時腳本會擋下來。

複製到目標機器後：

```bash
sha256sum -c yunzhi-offline-*.tar.gz.sha256    # 先確認搬運途中沒有損毀
tar -xzf yunzhi-offline-*.tar.gz && cd yunzhi
cp .env.example .env && ./deploy/scripts/gen-secrets.sh

sudo ./deploy/scripts/ubuntu-install.sh --offline   # 全新的 Ubuntu（會一併裝 Docker）
./deploy/scripts/docker-install.sh --offline        # 已經有 Docker
```

`--offline` 會跳過建置，改成從 `offline/images.tar.gz` 載入映像，
並逐一確認每個映像都真的載進來了。

**目標機器仍然需要 Docker Engine 本身。** 封閉網段請把 deb 檔一起帶過去，
做法見 [`docs/UBUNTU.md` 第 5 節](UBUNTU.md)。

---

## 安裝後檢查

```bash
./deploy/scripts/doctor.sh
```

它會檢查設定、服務、資料庫連通性、資源用量、備份狀態，
每一項失敗都附上下一步該做什麼。

**doctor 全綠不等於使用者打得開。** 它是從機器內部檢查的，
反向代理那一段不在它的視野裡。用外部代理時再補這兩步：

```bash
docker compose ps web        # PORTS 欄要有 127.0.0.1:3000->3000/tcp
curl -sSI https://你的網域/ | head -1     # 要 200 或 3xx，不是 502
```

第一步驗的是「應用有沒有真的對宿主機開口」，第二步驗的是
「你的 nginx 有沒有正確接上」。這兩件事各自失敗的症狀都是 502，
但修法完全不同——分開驗才知道要去哪一層找。

---

## 常見問題

**連接埠 80／443 被佔用** — 機器上已有 nginx 或 apache。**不要停用它們** ——
在 `.env` 設定 `PROXY_MODE=external` 改用既有的代理，見上方
「使用既有的 nginx」。

**`docker: permission denied`** — 目前使用者不在 docker 群組。
`sudo usermod -aG docker "$USER"` 後重新登入。

**主應用一直重啟** — 多半是設定錯誤。`docker compose logs web`
會印出設定驗證的結果，缺哪一項寫得很清楚。

**資料庫連不上但密碼看起來是對的** — 若曾經手動改過 `.env` 的
`POSTGRES_PASSWORD`，資料庫端的密碼並不會跟著變。見
`docs/OPERATIONS.md` 的「金鑰輪替」。

**每一個容器都健康，但反向代理一路 502** — 先確認主機埠真的發布了：

```bash
docker compose ps web        # PORTS 欄要有 127.0.0.1:3000->3000/tcp
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/readyz
```

`docker compose ps` 只顯示 `3000/tcp`（沒有 `->`）就是埠沒發布出去。
這種狀態下容器仍然是 `healthy`，因為 healthcheck 是從容器**內部**打
`readyz` 的；`doctor.sh` 也只會報一行「主應用未就緒」，看不出是網路
層的問題。

Docker 對只掛在 `internal: true` 網路上的容器**不會建立埠發布所需的
NAT 規則，而且不報錯**：`docker inspect` 看得到 PortBindings 設定完整，
`iptables -t nat -S DOCKER` 裡沒有對應規則，宿主機上沒有任何東西在聽。
v0.27.3 修掉了這個（web 補上 `edge` 網路），`tools/deploy-check.mjs`
有一項在盯著。自己改過 compose 的網路設定時要留意同一件事。

**手動 `docker compose` 時映像拉不到，或標籤變成 `dev`** — compose 的
映像標籤取自 `${APP_VERSION:-dev}`，而那個變數是 `docker-install.sh`
從 `VERSION` 讀出來傳進去的。手動下指令時它不存在，於是取了預設值：

```bash
APP_VERSION=$(cat VERSION) docker compose up -d web
```

前提是那個版本的映像已經建出來了。剛 `git pull` 完但還沒重建時，
`VERSION` 已經是新版而映像還是舊版標籤，compose 會跑去 registry 拉一個
不存在的映像。要嘛先重建，要嘛暫時指定手上有的那個版本號。

**重新 clone 或搬動目錄之後，資料好像不見了** — compose 的專案名稱
預設取自**目錄名**，volume 會叫 `<目錄名>_postgres-data`。clone 到
別的目錄名，compose 會建一組全新的空 volume，舊資料還在但沒有被掛上。
重新取得程式碼時目錄名要保持一致：

```bash
cd ~ && mv yunzhi yunzhi-old && git clone <repo> yunzhi
cd yunzhi && cp ../yunzhi-old/.env . && chmod 600 .env
```

**`.env` 一定要沿用舊的，而且不要重跑 `gen-secrets.sh`。** 它會產生
一組新的 `POSTGRES_PASSWORD`，而資料庫 volume 裡的舊密碼不會跟著變，
症狀是容器起得來但應用一直認證失敗。`BACKUP_ENCRYPTION_KEY` 更嚴重：
換掉之後既有的加密備份**全部無法解密，沒有救援途徑**。
