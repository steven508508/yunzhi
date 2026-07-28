-- 標準交換格式（QIF）的完整文件
--
-- 模型理解一份原稿之後的標準化結果。候選題是從它產出來的，
-- 而它本身留著：校對介面要顯示題組共用素材、圖的替代文字、
-- 觀念頁（那些不屬於任何單一候選題），抽取邏輯改版後要能重跑
-- 而不必再付一次模型的錢，老師問「原稿到底寫什麼」時它是唯一
-- 的答案。

ALTER TABLE "import_jobs"
  ADD COLUMN "documentJson"   JSONB,
  ADD COLUMN "documentSchema" TEXT;

-- 依格式版本找出「哪些工作是舊版抽的」。改版後要重跑時查得到。
CREATE INDEX "import_jobs_document_schema_idx"
  ON "import_jobs" ("tenantId", "documentSchema");
