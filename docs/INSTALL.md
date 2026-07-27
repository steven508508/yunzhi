# 安裝指南

適用於 Ubuntu Server 22.04 LTS 以上（建議 24.04 LTS）。

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

### 1. 安裝 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker          # 或重新登入
```

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
# 驗證備份真的能還原（未驗證的備份等於沒有備份）
./deploy/scripts/verify-restore.sh

# 把 .env 備份到密碼管理器或離線儲存
# 遺失 BACKUP_ENCRYPTION_KEY 等於所有加密備份作廢，沒有救援途徑
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

站台設定的四個關鍵點，自己改設定時不要漏掉：

**`client_max_body_size 200M`** — nginx 預設 1M，不改的話匯入題本
會直接壞掉，而且回的是 413，看不出是哪一層擋的。

**`X-Forwarded-For`** — 少了它，稽核記錄裡所有事件的來源 IP 都會是
`127.0.0.1`，誠信事件調查時等於沒有資訊。

**`X-Frame-Options: DENY`** — 防作弊的全螢幕鎖定與焦點偵測可以用
iframe 包起來繞過。少了這一條，考試模式的鎖定形同虛設。

**`/api/tutor/stream` 關閉 `proxy_buffering`** — 否則智慧老師的回應會
變成「轉圈圈 20 秒然後一次跳出全部文字」，對話式教學的體感完全消失。

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

### 嵌入模型是分開的

Anthropic 協定沒有嵌入端點，而題目去重、知識點檢索、文風比對三項
功能都依賴向量。所以嵌入模型獨立設定，預設本地部署：

```bash
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIM=1024
```

記憶體吃緊（8GB 以下）時可改走 API：`EMBEDDING_PROVIDER=openai`。

### AI 不可用時會怎樣

不會影響考試。作答、客觀題評分、檢視已生成的解析都照常運作，
只有 AI 相關功能降級（規格書文件 01 §16 的降級要求）。
`readyz` 刻意不把 AI 納入就緒條件，就是為了讓 AI 掛掉不會演變成
整個考試系統不可用。

---

## 離線安裝

在一台有網路的同架構機器上打包：

```bash
./deploy/scripts/build-offline-bundle.sh    # 產出 yunzhi-offline-<版本>.tar.gz
```

複製到目標機器後：

```bash
tar -xzf yunzhi-offline-*.tar.gz && cd yunzhi
./deploy/scripts/docker-install.sh --offline
```

---

## 安裝後檢查

```bash
./deploy/scripts/doctor.sh
```

它會檢查設定、服務、資料庫連通性、資源用量、備份狀態，
每一項失敗都附上下一步該做什麼。

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
