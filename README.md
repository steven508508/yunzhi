# 雲端智學

學測線上學習與評量系統。單一補習班自架，Ubuntu Server 部署。

完整規格見另一套規格文件（00 至 11 與附錄 A）。本儲存庫是實作。

---

## 現況

**本輪交付的是部署與維運基礎建設**，做到可以交付給客戶的程度；
應用層目前是最小可運行骨架（登入基礎、健康檢查、AI 服務介面），
教學功能依規格書路線圖分階段長出來。

| 部分 | 狀態 |
|---|---|
| Docker 部署（安裝／升級／回滾／解除安裝） | ✅ 完成 |
| 原生部署（systemd、專用使用者、完整移除清單） | ✅ 完成 |
| 備份、還原、時間點還原、還原演練 | ✅ 完成並實測 |
| 診斷工具與監控告警 | ✅ 完成 |
| AI provider 抽象（Anthropic／OpenAI／自訂 Base URL） | ✅ 完成並實測 |
| 資料庫基礎層（租戶、身分、稽核、AI 用量、通知） | ✅ 完成 |
| 題庫、組卷、作答、評分、能力分析 | ⬜ 依路線圖 |
| 錯題訂正、作業、智慧老師 | ⬜ 依路線圖 |
| 升學輔導模組 | ⬜ 第二階段 |
| 補習班營運模組 | ⬜ 規格未撰寫 |

---

## 快速開始

```bash
cp .env.example .env
./deploy/scripts/gen-secrets.sh
$EDITOR .env                              # 至少改 APP_DOMAIN、APP_URL
./deploy/scripts/docker-install.sh
./deploy/scripts/verify-restore.sh        # 上線前必做
```

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
./deploy/scripts/preflight.sh          # 安裝前環境檢查
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
