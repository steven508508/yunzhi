-- 雲端智學 — 匯入管線的串接
--
-- 這份遷移補的都是「上一份遷移漏掉會很痛」的東西，而不是新功能：
--   1. 授權約束往前移到 import_jobs
--   2. 檔案指紋，讓重複上傳能被認出來
--   3. 階段進度的欄位，讓失敗可以從失敗的那一階段續跑

-- ═══════════════════════════════════════════════════════════════
-- 1. 授權約束往前移
--
-- questions 已經有 questions_license_matches_source。但那個約束
-- 是在「校對完成、寫入題庫」那一刻才生效——也就是老師花了
-- 20 分鐘校完 50 題之後。同一條規則在 import_jobs 上再擋一次，
-- 錯誤就會出現在上傳當下，代價是零。
-- ═══════════════════════════════════════════════════════════════

-- NOT VALID：只約束「從現在起」的寫入，不重新檢查既有資料。
-- 直接 ADD CONSTRAINT 的話，已有資料的資料庫升級時整份遷移會中止，
-- 而 prisma migrate deploy 會把它標成 failed 卡住整個升級。
-- 之後立刻 VALIDATE：空庫瞬間完成，有資料的庫也只要 SHARE UPDATE
-- EXCLUSIVE 鎖（不擋讀寫），而不是全表 ACCESS EXCLUSIVE。
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_license_matches_source" CHECK (
  ("sourceType" = 'PUBLISHER_SCAN' AND "licenseScope" IN ('TENANT_NO_EXPORT','INTERNAL_USE_ONLY'))
  OR ("sourceType" <> 'PUBLISHER_SCAN' AND ("licenseScope" <> 'PUBLIC' OR "sourceType" = 'OFFICIAL_PAST'))
) NOT VALID;
ALTER TABLE "import_jobs" VALIDATE CONSTRAINT "import_jobs_license_matches_source";

-- 權利聲明是責任歸屬，不能是空的。
-- 應用層已經擋了，這裡是繞過應用層的最後一道。
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_rights_declared" CHECK (
  "rightsDeclaredBy" IS NOT NULL AND "rightsBasis" IS NOT NULL
) NOT VALID;
ALTER TABLE "import_jobs" VALIDATE CONSTRAINT "import_jobs_rights_declared";

ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_rights_basis_valid" CHECK (
  "rightsBasis" IN ('OWNED','LICENSED','OFFICIAL_PUBLIC','UNVERIFIED')
) NOT VALID;
ALTER TABLE "import_jobs" VALIDATE CONSTRAINT "import_jobs_rights_basis_valid";

-- ═══════════════════════════════════════════════════════════════
-- 2. 檔案指紋
--
-- 同一份講義被兩位老師各上傳一次，是七個班三位科目老師的環境裡
-- 一定會發生的事（訪談第 1 題）。認出來的價值不只是省儲存空間，
-- 更是省掉第二次的 AI 費用與第二次的 20 分鐘校對。
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE "import_files" ADD COLUMN "sha256" TEXT;
CREATE INDEX "import_files_sha256_idx" ON "import_files"("sha256");

-- ═══════════════════════════════════════════════════════════════
-- 3. 階段進度
--
-- stageDetail 是 JSONB，塞得下任何東西——但「這個工作現在卡在
-- 哪一階段、跑了多久、花了多少錢」是維運每天要查的，
-- 埋在 JSON 裡查起來很痛。獨立成欄位。
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE "import_jobs" ADD COLUMN "stageStartedAt" TIMESTAMP(3);
ALTER TABLE "import_jobs" ADD COLUMN "lastCompletedStage" TEXT;
ALTER TABLE "import_jobs" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
-- 這一份匯入到目前為止的 AI 花費（新台幣）。
-- 累計而非單階段：老師問的是「這份花了多少」。
ALTER TABLE "import_jobs" ADD COLUMN "aiCostTwd" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- 找出「卡住的工作」：狀態不是終態、而且很久沒動。
-- doctor.sh 與監控用這個索引。
CREATE INDEX "import_jobs_stuck_idx" ON "import_jobs"("stageStartedAt")
  WHERE "status" NOT IN ('READY_FOR_REVIEW','COMMITTED','FAILED');

-- ═══════════════════════════════════════════════════════════════
-- 4. 頁面
--
-- 正規化的產出。原本打算塞在 stageDetail 裡，但 200 頁題本的
-- 頁面清單會讓那個 JSONB 膨脹到每次讀取都要付出代價，
-- 而校對介面每切一題就要取一次對應頁的影像。
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE "import_pages" (
  "id"        TEXT PRIMARY KEY,
  "jobId"     TEXT NOT NULL REFERENCES "import_jobs"("id") ON DELETE CASCADE,
  "fileId"    TEXT NOT NULL REFERENCES "import_files"("id") ON DELETE CASCADE,
  "index"     INTEGER NOT NULL,           -- 該檔案內的頁碼，從 1 起算
  "width"     INTEGER NOT NULL,
  "height"    INTEGER NOT NULL,
  "storageKey" TEXT NOT NULL,             -- 正規化後的頁面影像
  -- 原生 PDF 才有。它比 OCR 準得多，但版面資訊要靠座標推斷。
  "textLayer" TEXT,
  "quality"   DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "qualityNotes" JSONB NOT NULL DEFAULT '[]',
  -- 版面切割的結果（第 2 階段）。每頁一份，避免整份文件一大坨。
  "blocks"    JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("fileId","index")
);
CREATE INDEX "import_pages_jobId_idx" ON "import_pages"("jobId");
-- 品質差的頁面要能被挑出來提示「建議逐題確認」
CREATE INDEX "import_pages_jobId_quality_idx" ON "import_pages"("jobId","quality");
