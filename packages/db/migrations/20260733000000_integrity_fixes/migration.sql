-- 稽核後補上的完整性約束與索引
--
-- 這一份修的都是「不會報錯、只會默默出錯」的那一類。

-- ═══════════════════════════════════════════════════════════════
-- 一、解析的授權範圍
--
-- questions 有 questions_license_matches_source 擋著「出版社掃描件
-- 不可以標成 PUBLIC」，explanations 沒有對應的約束——於是一份標成
-- 「歷屆試題／PUBLIC」的講義夾帶出版社教用版詳解時，會寫出一列
-- origin='VERBATIM_IMPORT'、licenseScope='PUBLIC' 的解析。
--
-- 試題依著作權法第 9 條不受保護，**詳解受保護**。原文收錄的詳解
-- 不可能是 PUBLIC，除非它是我們自己生成的。
-- ═══════════════════════════════════════════════════════════════

-- OFFICIAL_CEEC 是大考中心公布的參考答案與評分原則，那是公開的。
-- 其餘的原文收錄（VERBATIM_IMPORT）一律不可以是 PUBLIC。
ALTER TABLE "explanations"
  ADD CONSTRAINT "explanations_verbatim_not_public" CHECK (
    "licenseScope" <> 'PUBLIC'
    OR "origin" IN ('AI_REWRITTEN','AI_GENERATED','TEACHER_WRITTEN','OFFICIAL_CEEC')
  );

-- ═══════════════════════════════════════════════════════════════
-- 二、可重跑的權利聲明約束
--
-- 20260729 的 import_jobs_rights_declared 是直接 ADD CONSTRAINT。
-- 空庫沒問題，但**已有資料的庫升級時整份遷移會中止**，
-- prisma migrate deploy 把它標成 failed 卡住整個升級。
--
-- 它同時與 rightsDeclaredBy 的 ON DELETE SET NULL 互相矛盾：
-- 刪掉任何一個曾經聲明過權利的老師帳號，都會撞上這個 CHECK 而
-- 失敗，錯誤訊息完全看不出原因（而刪租戶會連帶刪使用者，
-- 所以連刪租戶都會失敗）。
--
-- 改法：帳號被刪時把聲明者換成一個字面值而不是 NULL。誰聲明的
-- 這件事本身要留著——那是權利基礎的證據。
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE "import_jobs" DROP CONSTRAINT IF EXISTS "import_jobs_rights_declared";

ALTER TABLE "import_jobs"
  ADD COLUMN IF NOT EXISTS "rightsDeclaredName" TEXT;

-- 先把既有資料補齊，再加約束。順序反了就會中止。
UPDATE "import_jobs"
   SET "rightsDeclaredName" = '（歷史資料，未記錄聲明人）'
 WHERE "rightsDeclaredBy" IS NULL
   AND "rightsDeclaredName" IS NULL;

-- 權利聲明仍然是必填（責任歸屬），但「誰聲明的」現在有兩個來源：
-- 帳號連結，或帳號被刪之後留下的姓名快照。
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_rights_declared" CHECK (
    "rightsBasis" IS NOT NULL
    AND ("rightsDeclaredBy" IS NOT NULL OR "rightsDeclaredName" IS NOT NULL)
  ) NOT VALID;

-- NOT VALID 代表「從現在起強制，既有資料不重新檢查」。
-- 立刻 VALIDATE：空庫瞬間完成，有資料的庫也只需要 SHARE UPDATE
-- EXCLUSIVE 鎖（不擋讀寫），而不是 ADD CONSTRAINT 的全表 ACCESS
-- EXCLUSIVE 鎖。
ALTER TABLE "import_jobs" VALIDATE CONSTRAINT "import_jobs_rights_declared";

-- ═══════════════════════════════════════════════════════════════
-- 三、題組唯一索引與 schema 對齊
--
-- schema.prisma 宣告的是完整的 @@unique([sourceImportJobId, sourceGroupKey])，
-- migration 建的卻是 partial（WHERE "sourceImportJobId" IS NOT NULL）。
-- Prisma 的 upsert 會發 ON CONFLICT ("sourceImportJobId","sourceGroupKey")，
-- 而 partial 索引不符合那個規格 —— 兩個分頁同時入庫時，
-- commit.ts 註解宣稱靠唯一索引擋下的併發保護根本沒有生效。
-- ═══════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS "question_groups_import_key";

-- 兩欄都是 nullable，而 Postgres 的唯一索引不約束含 NULL 的列，
-- 所以完整索引對「兩者皆 NULL」的一般題組沒有任何影響。
CREATE UNIQUE INDEX "question_groups_import_key"
  ON "question_groups" ("sourceImportJobId", "sourceGroupKey");

-- ═══════════════════════════════════════════════════════════════
-- 四、外鍵的前綴索引
--
-- 沒有這些，刪一題或停用一個老師帳號要把整張表掃過。
-- 題庫到六萬題以後，一次刪除會鎖住整個題庫幾秒鐘。
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS "import_candidates_questionId_idx"
  ON "import_candidates" ("questionId");
CREATE INDEX IF NOT EXISTS "import_candidates_duplicateOfId_idx"
  ON "import_candidates" ("duplicateOfId");
CREATE INDEX IF NOT EXISTS "duplicate_members_questionId_idx"
  ON "duplicate_members" ("questionId");
CREATE INDEX IF NOT EXISTS "rubrics_questionId_idx"
  ON "rubrics" ("questionId");
CREATE INDEX IF NOT EXISTS "questions_createdBy_idx"
  ON "questions" ("createdBy");

-- 題庫首頁的預設查詢是「本租戶 ＋ 狀態 ＋ 依建立時間排序」，
-- 而既有的索引以 subjectId 為第二欄，沒選科目時用不上。
CREATE INDEX IF NOT EXISTS "questions_tenant_status_created_idx"
  ON "questions" ("tenantId", "status", "createdAt" DESC);
