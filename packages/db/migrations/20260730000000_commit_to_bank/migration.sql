-- 雲端智學 — 候選題入庫
--
-- 補上兩件事：講義的詳解要跟著候選題走，以及入庫需要的追溯欄位。

-- ═══════════════════════════════════════════════════════════════
-- 1. 候選題帶著原稿的詳解與答案
--
-- 教用版講義的價值就在詳解（訪談第 2 題的痛點是「解析不足」），
-- 但它與試題的著作權地位完全不同——試題依著作權法第 9 條
-- 不受保護，詳解受保護。所以分開存，入庫時也分開判斷。
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE "import_candidates" ADD COLUMN "explanationRaw" TEXT;
-- 原稿印出來的答案（教用版的「答：(B)」或填空裡的字）。
-- 與 answerText 分開：answerText 是校對後要入庫的值，
-- 這個是原稿長什麼樣，兩者不一致時要看得出來。
ALTER TABLE "import_candidates" ADD COLUMN "sourceAnswerRaw" TEXT;
-- 講義的題目標頭（「範例 3」「類題 1」）。入庫後成為 sourceRef 的一部分，
-- 老師要回頭對照原稿時找得到。
ALTER TABLE "import_candidates" ADD COLUMN "label" TEXT;

-- ═══════════════════════════════════════════════════════════════
-- 2. 入庫的追溯
-- ═══════════════════════════════════════════════════════════════

-- questions.sourceImportJobId 原本沒有索引。「這批匯入的題目
-- 後來怎麼了」是撤銷匯入與稽核時的第一個查詢。
CREATE INDEX "questions_sourceImportJobId_idx" ON "questions"("sourceImportJobId");

-- 入庫結果的摘要，寫在工作上讓老師看得到。
ALTER TABLE "import_jobs" ADD COLUMN "committedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "import_jobs" ADD COLUMN "commitDetail" JSONB;

-- ═══════════════════════════════════════════════════════════════
-- 3. 題組
--
-- 講義的「範例＋類題」不是題組，但學測的混合題是。
-- groupKey 相同的候選題入庫時共用一個 question_groups 列。
-- ═══════════════════════════════════════════════════════════════

-- 同一次匯入的同一個 groupKey 只能對應一個題組。
-- 沒有這個約束的話，重跑入庫會建出重複的題組。
ALTER TABLE "question_groups" ADD COLUMN "sourceImportJobId" TEXT;
ALTER TABLE "question_groups" ADD COLUMN "sourceGroupKey" TEXT;
CREATE UNIQUE INDEX "question_groups_import_key"
  ON "question_groups"("sourceImportJobId","sourceGroupKey")
  WHERE "sourceImportJobId" IS NOT NULL;
