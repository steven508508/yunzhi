-- 全國答對率與出處標籤
--
-- 社會與英文的講義在每道考古題旁印「112學測」與「答對率 43%」。
-- 那個答對率是大考中心的實測難度——一道題入庫當天就有校準過的
-- 難度，不必等本班學生作答幾百次。
--
-- 與 correctRate 分成兩欄而不是共用一欄：correctRate 會被本班的
-- 作答重算，全國答對率是外部給定的常數。共用一欄的話，第一次
-- 統計重算就會把它蓋掉，而且沒有人會發現。

ALTER TABLE "questions"
  ADD COLUMN "nationalCorrectRate" DOUBLE PRECISION,
  ADD COLUMN "nationalSampleNote"  TEXT,
  ADD COLUMN "sourceExam"          TEXT;

ALTER TABLE "import_candidates"
  ADD COLUMN "nationalCorrectRate" DOUBLE PRECISION,
  ADD COLUMN "sourceExam"          TEXT;

-- 比率的定義域。答對率是 0–1，不是百分數——若有人寫成 43 而不是
-- 0.43，能力分析會算出「比全國高 4200%」這種數字而不報錯。
ALTER TABLE "questions"
  ADD CONSTRAINT "questions_national_rate_range"
  CHECK ("nationalCorrectRate" IS NULL
         OR ("nationalCorrectRate" >= 0 AND "nationalCorrectRate" <= 1));

ALTER TABLE "import_candidates"
  ADD CONSTRAINT "import_candidates_national_rate_range"
  CHECK ("nationalCorrectRate" IS NULL
         OR ("nationalCorrectRate" >= 0 AND "nationalCorrectRate" <= 1));

-- 依年份挑題是老師實際會做的事（「來一份 112 到 115 的考古題」）。
CREATE INDEX "questions_source_exam_idx" ON "questions" ("tenantId", "sourceExam");
