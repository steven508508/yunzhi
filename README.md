# 雲端智學

學測線上學習與評量系統。單一補習班自架，Ubuntu Server + Docker 部署。

版本 **v0.27.4**（2026-07-31）

---

## 這套系統現在做得到什麼

一條完整的動線，從一份紙本題本到學生的成績單：

```
上傳題本（PDF／掃描／手機拍）
   → AI 讀整頁、抽出題目與答案
   → 老師在校對介面逐題確認（數學式與化學式排得出來）
   → 寫進題庫
   → 挑題組卷
   → 派給班級或指定學生
   → 學生線上作答（隨機題序、伺服器計時、斷線不掉答案）
   → 交卷自動計分
   → 老師看全班成績與各題答對率
   → 學生看自己的分數、逐題檢討與解析
```

| 部分 | 狀態 |
|---|---|
| Docker 部署（安裝／升級／回滾／解除安裝／離線包） | 完成 |
| 備份、還原、時間點還原、還原演練腳本 | 完成（**演練本身還沒跑過**） |
| 診斷工具與監控 | 完成（**告警收件人還沒設**） |
| 資料庫層的租戶隔離（Postgres RLS，48 張表） | 完成 |
| 學年度、班級、名冊匯入、家長同意、密碼重設 | 完成 |
| 知識點圖譜（含環路偵測） | 完成 |
| 題本匯入（PDF／掃描／翻拍，13 個科目） | 完成 |
| 組卷、派卷、線上作答、自動計分、成績與檢討 | 完成 |
| 題目編輯、改標準答案、全班送分、發布與下架 | 完成 |
| 題目裡的圖（含紙本考卷） | 完成 |
| 智慧老師（引導式教學，含防洩答閘門） | 完成 |
| 能力分析（知識點掌握度、班級弱點、題型表現） | 完成 |
| 考試行為偵測（切換分頁、離開全螢幕） | 完成 |
| 家長端 | 完成 |
| 升學輔導：制度規則引擎、繁星校內賽局 | 完成 |
| 升學資料的查詢動線（官方網址 → 自行輸入 → AI 建議） | 完成 |
| 升學輔導：級分預測（含校準）、個申落點 | 完成 |
| 非選題的 AI 閱卷（AI 提出、老師決定） | 完成 |
| 通知（站內收件匣） | 完成 |
| 學習歷程輔助（含 AI 使用揭露）、面試準備 | 完成 |

---

## 第一次登入之後的順序

系統首頁會依「擋住後面所有事的排最前面」列出待辦，照著做就對了。
順序是：建立學年度 → 建老師帳號 → 開班與匯入名冊 → 指派授課老師
與導師 → 登錄家長同意 → 建知識點 → 匯入第一份題本 → 組卷 → 派卷。

**科目不必自己建。** 學測的 13 科（國英數 A／B、自然、社會，加上
物理、化學、生物、地科、歷史、地理、公民）在安裝時就建好了。
要改成貴機構的講法、加開學測以外的科目或停用不開的科目，
在 `/settings/subjects`。

**建知識點那一步不做，匯入的自動標註等於沒有作用。** 建議先只做
數學 A，每科約 4 到 8 小時的老師工時。

---

## 上線第一天會遇到的三件事

**名冊匯入建議分班做。** 每個新帳號要算一次密碼雜湊（約 0.35 秒），
200 人大約要等一分鐘、畫面會停著。一班 30 人約 10 秒。
超過 40 人時試算畫面會先告訴你要等多久。

**忘記密碼在名冊頁重設。** 沒有寄信功能（學生多半沒登記 email，
機房也連不出去）。畫面會顯示一組新密碼，**那串字只出現一次**，
請當場抄給學生。學生登入後可在 `/settings/password` 自己改。

**派卷之前確認授課老師名單。** 老師只派得了自己教的科目 × 自己教
的班。在班級頁（`/classes/[班級]`）的「授課老師與導師」那一區指派，
開學前抽查一下——**沒有被指派的老師登得進來，但每一頁對他都是空的**，
而空畫面與「還沒有資料」長得一樣，他多半不會來說自己沒有權限。

---

## 安裝

**照著 `docs/UBUNTU.md` 做。** 一頁版的摘要在 `docs/中午部署.md`。

```bash
cp .env.example .env
chmod 600 .env                    # 裡面會有資料庫密碼與備份金鑰
./deploy/scripts/gen-secrets.sh   # 產生密鑰
$EDITOR .env                      # 至少改 APP_DOMAIN、APP_URL、AI_*

./tools/install-dryrun.sh         # 先問「這台機器裝不裝得起來」
sudo ./deploy/scripts/ubuntu-install.sh
```

**`install-dryrun.sh` 不要跳過。** 它會在你花二十分鐘建映像之前，
先告訴你埠有沒有被佔、`.env` 有沒有填完、以及這台機器連不連得到
Docker Hub 與 `binaries.prisma.sh`。**很多企業防火牆放行前者卻擋掉
後者**，而那會讓建置在第 8 分鐘才失敗。

機房完全封閉時走離線包：在有網路的同架構機器上跑
`./deploy/scripts/build-offline-bundle.sh`，把產出搬過去之後
`sudo ./deploy/scripts/ubuntu-install.sh --offline`。

已經裝好 Docker、只要重建應用時用 `./deploy/scripts/docker-install.sh`。

**機器上已經有 nginx？** 在 `.env` 設定 `PROXY_MODE=external`，
系統就不會去碰 80／443，只把應用綁在 `127.0.0.1:3000`：

```bash
sed -i 's|^PROXY_MODE=.*|PROXY_MODE=external|' .env
./deploy/scripts/docker-install.sh
sudo ./deploy/scripts/setup-nginx.sh      # 產生站台設定、驗證後才 reload
```

---

## 指令一覽

```bash
./tools/install-dryrun.sh              # 安裝前：這台機器裝不裝得起來
./deploy/scripts/preflight.sh          # 安裝前環境檢查（腳本內部也會呼叫）
sudo ./deploy/scripts/ubuntu-install.sh # Ubuntu 從零安裝（含 Docker 本身）
./deploy/scripts/gen-secrets.sh        # 產生密碼與金鑰（可重複執行）
./deploy/scripts/docker-install.sh     # Docker 安裝
sudo ./deploy/scripts/install.sh       # 原生安裝
./deploy/scripts/doctor.sh             # 系統診斷
./deploy/scripts/backup.sh             # 備份
./deploy/scripts/restore.sh --latest   # 還原
./deploy/scripts/verify-restore.sh     # 還原演練（每季）
./deploy/scripts/upgrade.sh            # 升級（自動備份、失敗自動回滾）
./deploy/scripts/rollback.sh           # 回滾
sudo ./deploy/scripts/setup-nginx.sh   # 設定既有的 nginx 反向代理
./deploy/scripts/export-ca.sh          # 匯出內網根憑證（僅內建 Caddy 模式）
./deploy/scripts/docker-uninstall.sh --dry-run   # 先看會刪什麼
```

所有腳本都支援 `-h`。破壞性操作一律先列出清單、再要求輸入完整詞句確認。

---

## 文件

| 文件 | 內容 |
|---|---|
| [docs/UBUNTU.md](docs/UBUNTU.md) | **Ubuntu + Docker 從零安裝，先看這份** |
| [docs/中午部署.md](docs/中午部署.md) | 一頁版摘要：改哪六個變數、第一天做什麼 |
| [docs/INSTALL.md](docs/INSTALL.md) | 安裝、TLS、AI 設定、離線安裝 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 日常維運、容量規劃、金鑰輪替、考試日準備 |
| [docs/DISASTER-RECOVERY.md](docs/DISASTER-RECOVERY.md) | 六種災難情境的處理程序 |
| [docs/UNINSTALL.md](docs/UNINSTALL.md) | 三個移除層級與完整殘留清單 |

---

## 架構

```
nginx 或內建 Caddy (TLS)
  ├── Next.js 15 主應用（多實例）
  ├── Node worker（匯入、評分、通知佇列）
  └── Python FastAPI AI 服務（故障隔離）
        └── Anthropic / OpenAI / 自訂閘道
PostgreSQL 16 + pgvector（WAL 歸檔，RPO 15 分鐘）
Redis 7（快取、佇列）
MinIO（題本原檔、圖片、掃描答卷）
```

---

## 兩個不可妥協的維運紀律

**未經還原驗證的備份等於沒有備份。** 每季執行 `verify-restore.sh`，
`doctor.sh` 會在超過 92 天時回報為失敗。

**`.env` 必須另外保存。** 遺失 `BACKUP_ENCRYPTION_KEY` 等於所有加密
備份在數學上無法還原，沒有任何救援途徑。

---

## 開發

```bash
npm install
npm run db:generate        # 產生 Prisma Client（離線環境有退路）
npm run check              # typecheck + schema + RLS + 部署設定
npm test                   # 單元測試（230 項）
npm run test:e2e           # 端到端，需要本機 Postgres 與 Redis
npm run test:ai            # AI 管線的 Python 測試
```

`npm run check` 裡的 `rls-check` 會在 schema 新增模型而
`tools/tenancy.mjs` 沒有分類時失敗。**那是刻意的**：「新增一張表」
與「決定這張表屬於誰」必須是同一個動作，否則遲早會有一張表在沒有
人注意的情況下對所有租戶敞開。

設計決策的來龍去脈寫在各檔案的檔頭註解裡。`apps/web/lib/attempt.ts`、
`tools/tenancy.mjs`、`apps/web/lib/paper.ts` 這三個檔頭值得先讀。
