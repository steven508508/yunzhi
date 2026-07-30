-- 學習歷程檔案輔助與第二階段準備
--
-- 設計決定寫在 schema.prisma 對應區塊。SQL 層面最重要的是那幾條
-- CHECK：這一塊處理的是學生的個人陳述，錯誤的方向是「擋住一份該交的
-- 檔案」或「放行一份會被退件的」，兩者都要等到不可逆的截止日才發現。

CREATE TYPE "PortfolioCategory" AS ENUM (
  'COURSE_RECORD', 'COURSE_OUTCOME', 'DIVERSE_PERFORMANCE', 'SELF_STATEMENT', 'OTHER'
);
CREATE TYPE "EssayKind" AS ENUM ('DIVERSE_SUMMARY', 'REFLECTION', 'MOTIVATION', 'PLAN');
CREATE TYPE "PortfolioAiFeature" AS ENUM (
  'WRITING_FEEDBACK', 'MATERIAL_HINT', 'SELECTION_DISCUSS',
  'RULE_CHECK', 'INTERVIEW_FEEDBACK', 'DISCLOSURE_STATEMENT'
);

-- ── 制度上限 ────────────────────────────────────────────────

CREATE TABLE "portfolio_limit_sets" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "year"            INTEGER NOT NULL,
  "outcomePerYear"  INTEGER NOT NULL DEFAULT 6,
  "diversePerYear"  INTEGER NOT NULL DEFAULT 10,
  "outcomeSelected" INTEGER NOT NULL DEFAULT 3,
  "diverseSelected" INTEGER NOT NULL DEFAULT 10,
  "summaryChars"    INTEGER NOT NULL DEFAULT 800,
  "summaryImages"   INTEGER NOT NULL DEFAULT 3,
  "docBytes"        INTEGER NOT NULL DEFAULT 4194304,
  "mediaBytes"      INTEGER NOT NULL DEFAULT 10485760,
  "sourceRef"       TEXT NOT NULL,
  "setBy"           TEXT NOT NULL,
  "setAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "portfolio_limit_sets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "portfolio_limit_sets_tenantId_year_key"
  ON "portfolio_limit_sets"("tenantId", "year");
ALTER TABLE "portfolio_limit_sets" ADD CONSTRAINT "portfolio_limit_sets_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "portfolio_limit_sets" ADD CONSTRAINT "portfolio_limit_sets_year_roc"
  CHECK ("year" BETWEEN 100 AND 200);
-- 上限是 0 的話學生一件都交不了，而畫面上會說「已達上限」。
ALTER TABLE "portfolio_limit_sets" ADD CONSTRAINT "portfolio_limit_sets_positive"
  CHECK (
    "outcomePerYear" > 0 AND "diversePerYear" > 0
    AND "outcomeSelected" > 0 AND "diverseSelected" > 0
    AND "summaryChars" > 0 AND "summaryImages" >= 0
    AND "docBytes" > 0 AND "mediaBytes" > 0
  );
-- 勾選階段的上限不可能超過上傳階段的——他選不到沒上傳的東西。
-- 反了的話系統會允許一個做不到的組合，而錯誤要到送出當天才出現。
ALTER TABLE "portfolio_limit_sets" ADD CONSTRAINT "portfolio_limit_sets_selected_within"
  CHECK ("outcomeSelected" <= "outcomePerYear" * 3 AND "diverseSelected" <= "diversePerYear" * 3);
-- 來源必填而且不可以是空字串。這些數字錯了會擋住學生，要查得出來。
ALTER TABLE "portfolio_limit_sets" ADD CONSTRAINT "portfolio_limit_sets_source_nonempty"
  CHECK (length(btrim("sourceRef")) > 0);

-- ── 素材 ────────────────────────────────────────────────────

CREATE TABLE "portfolio_items" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "category"    "PortfolioCategory" NOT NULL,
  "itemCode"    TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "semester"    TEXT,
  "storageKey"  TEXT,
  "fileName"    TEXT,
  "fileBytes"   INTEGER,
  "fileKind"    TEXT,
  "courseRef"   TEXT,
  "abilityTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "selectedFor" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "note"        TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "portfolio_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "portfolio_items_userId_category_idx" ON "portfolio_items"("userId", "category");
CREATE INDEX "portfolio_items_tenantId_userId_idx" ON "portfolio_items"("tenantId", "userId");
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_bytes_nonneg"
  CHECK ("fileBytes" IS NULL OR "fileBytes" >= 0);
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_kind_known"
  CHECK ("fileKind" IS NULL OR "fileKind" IN ('DOC', 'MEDIA'));
-- 官方代碼是單一大寫字母 A–T。
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_code_shape"
  CHECK ("itemCode" ~ '^[A-T]$');

-- ── 自述 ────────────────────────────────────────────────────

CREATE TABLE "portfolio_essays" (
  "id"         TEXT NOT NULL,
  "tenantId"   TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "kind"       "EssayKind" NOT NULL,
  "programRef" TEXT,
  "body"       TEXT NOT NULL,
  "charCount"  INTEGER NOT NULL DEFAULT 0,
  "imageCount" INTEGER NOT NULL DEFAULT 0,
  "version"    INTEGER NOT NULL DEFAULT 1,
  "isCurrent"  BOOLEAN NOT NULL DEFAULT true,
  "sharedWith" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "portfolio_essays_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "portfolio_essays_userId_kind_isCurrent_idx"
  ON "portfolio_essays"("userId", "kind", "isCurrent");
ALTER TABLE "portfolio_essays" ADD CONSTRAINT "portfolio_essays_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "portfolio_essays" ADD CONSTRAINT "portfolio_essays_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "portfolio_essays" ADD CONSTRAINT "portfolio_essays_counts_nonneg"
  CHECK ("charCount" >= 0 AND "imageCount" >= 0 AND "version" > 0);

-- ── AI 使用層級與揭露 ───────────────────────────────────────

CREATE TABLE "ai_usage_policies" (
  "id"       TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "classId"  TEXT NOT NULL,
  "level"    INTEGER NOT NULL,
  "note"     TEXT,
  "setBy"    TEXT NOT NULL,
  "setAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_usage_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_usage_policies_classId_key" ON "ai_usage_policies"("classId");
ALTER TABLE "ai_usage_policies" ADD CONSTRAINT "ai_usage_policies_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_usage_policies" ADD CONSTRAINT "ai_usage_policies_classId_fkey"
  FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 教育部函文的四種層級。超出範圍的數字會讓權限判斷落到一個沒有定義
-- 的分支，而預設分支寫成「允許」或「禁止」都是錯的。
ALTER TABLE "ai_usage_policies" ADD CONSTRAINT "ai_usage_policies_level_range"
  CHECK ("level" BETWEEN 1 AND 4);

CREATE TABLE "ai_disclosure_logs" (
  "id"         TEXT NOT NULL,
  "tenantId"   TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "feature"    "PortfolioAiFeature" NOT NULL,
  "essayId"    TEXT,
  "natureNote" TEXT NOT NULL,
  "aiLevel"    INTEGER,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_disclosure_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_disclosure_logs_userId_occurredAt_idx"
  ON "ai_disclosure_logs"("userId", "occurredAt");
ALTER TABLE "ai_disclosure_logs" ADD CONSTRAINT "ai_disclosure_logs_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_disclosure_logs" ADD CONSTRAINT "ai_disclosure_logs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 互動性質摘要是揭露聲明的事實基礎。空的話聲明就沒有東西可以依據，
-- 而它會變成一段憑空生成的宣稱。
ALTER TABLE "ai_disclosure_logs" ADD CONSTRAINT "ai_disclosure_logs_nature_nonempty"
  CHECK (length(btrim("natureNote")) > 0);
ALTER TABLE "ai_disclosure_logs" ADD CONSTRAINT "ai_disclosure_logs_level_range"
  CHECK ("aiLevel" IS NULL OR "aiLevel" BETWEEN 1 AND 4);

CREATE TABLE "ai_disclosure_statements" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "essayId"   TEXT,
  "generated" TEXT NOT NULL,
  "edited"    TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_disclosure_statements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_disclosure_statements_userId_createdAt_idx"
  ON "ai_disclosure_statements"("userId", "createdAt");
ALTER TABLE "ai_disclosure_statements" ADD CONSTRAINT "ai_disclosure_statements_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_disclosure_statements" ADD CONSTRAINT "ai_disclosure_statements_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_disclosure_statements" ADD CONSTRAINT "ai_disclosure_statements_generated_nonempty"
  CHECK (length(btrim("generated")) > 0);

-- ── 面試 ────────────────────────────────────────────────────

CREATE TABLE "interview_questions" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "fieldTag"    TEXT NOT NULL,
  "question"    TEXT NOT NULL,
  "focusPoints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "createdBy"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interview_questions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "interview_questions_tenantId_fieldTag_active_idx"
  ON "interview_questions"("tenantId", "fieldTag", "active");
ALTER TABLE "interview_questions" ADD CONSTRAINT "interview_questions_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "interview_practices" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "questionId"  TEXT NOT NULL,
  "answerText"  TEXT NOT NULL,
  "feedback"    JSONB,
  "consistency" JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interview_practices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "interview_practices_userId_createdAt_idx"
  ON "interview_practices"("userId", "createdAt");
ALTER TABLE "interview_practices" ADD CONSTRAINT "interview_practices_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interview_practices" ADD CONSTRAINT "interview_practices_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interview_practices" ADD CONSTRAINT "interview_practices_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "interview_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 租戶隔離（由 tools/rls-check.mjs --emit 產生）────────────

ALTER TABLE "ai_disclosure_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_disclosure_logs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_disclosure_logs_tenant_isolation" ON "ai_disclosure_logs";
CREATE POLICY "ai_disclosure_logs_tenant_isolation" ON "ai_disclosure_logs"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "ai_disclosure_statements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_disclosure_statements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_disclosure_statements_tenant_isolation" ON "ai_disclosure_statements";
CREATE POLICY "ai_disclosure_statements_tenant_isolation" ON "ai_disclosure_statements"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "ai_usage_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage_policies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_usage_policies_tenant_isolation" ON "ai_usage_policies";
CREATE POLICY "ai_usage_policies_tenant_isolation" ON "ai_usage_policies"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "interview_practices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interview_practices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "interview_practices_tenant_isolation" ON "interview_practices";
CREATE POLICY "interview_practices_tenant_isolation" ON "interview_practices"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "interview_questions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interview_questions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "interview_questions_tenant_isolation" ON "interview_questions";
CREATE POLICY "interview_questions_tenant_isolation" ON "interview_questions"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "portfolio_essays" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portfolio_essays" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "portfolio_essays_tenant_isolation" ON "portfolio_essays";
CREATE POLICY "portfolio_essays_tenant_isolation" ON "portfolio_essays"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "portfolio_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portfolio_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "portfolio_items_tenant_isolation" ON "portfolio_items";
CREATE POLICY "portfolio_items_tenant_isolation" ON "portfolio_items"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "portfolio_limit_sets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portfolio_limit_sets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "portfolio_limit_sets_tenant_isolation" ON "portfolio_limit_sets";
CREATE POLICY "portfolio_limit_sets_tenant_isolation" ON "portfolio_limit_sets"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
