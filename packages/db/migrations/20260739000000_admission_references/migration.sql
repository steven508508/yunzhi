-- 學生自己查來的升學參考資料
--
-- 設計決定寫在 schema.prisma 的 AdmissionReference 註解裡。SQL 層面
-- 只有一件事值得寫在這裡:CHECK 約束擋的是「沒有來源的數字」。
--
-- 一個沒有來源與查詢日期的數字，在三個月後與一個有來源的長得一模一樣，
-- 而學生會照著它決定要不要填志願。所以那兩欄是 NOT NULL 而不是選填。

CREATE TYPE "SourceKind" AS ENUM (
  'OFFICIAL_DOC', 'SCHOOL_OFFICE', 'CRAM_TEACHER', 'STUDENT_NOTE', 'HEARSAY'
);

CREATE TABLE "admission_references" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "enteredBy"       TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "year"            INTEGER NOT NULL,
  "channel"         "AdmissionChannel" NOT NULL,
  "institutionName" TEXT NOT NULL,
  "programName"     TEXT,
  "starGroup"       INTEGER,
  "kind"            TEXT NOT NULL,
  "value"           JSONB NOT NULL,
  "sourceKind"      "SourceKind" NOT NULL,
  "sourceRef"       TEXT NOT NULL,
  "lookedUpAt"      TIMESTAMP(3) NOT NULL,
  "staleAfterYear"  INTEGER NOT NULL,
  "forSelfOnly"     BOOLEAN NOT NULL DEFAULT true,
  "note"            TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "admission_references_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admission_references_tenantId_year_channel_idx"
  ON "admission_references"("tenantId", "year", "channel");
CREATE INDEX "admission_references_userId_year_idx"
  ON "admission_references"("userId", "year");

ALTER TABLE "admission_references" ADD CONSTRAINT "admission_references_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admission_references" ADD CONSTRAINT "admission_references_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 民國學年度。擋掉把西元年填進來的那一次——2026 會讓每一筆資料
-- 都被判定成「未來的資料」而安靜地不參與任何建議。
ALTER TABLE "admission_references" ADD CONSTRAINT "admission_references_year_roc"
  CHECK ("year" BETWEEN 100 AND 200 AND "staleAfterYear" BETWEEN 100 AND 200);
-- 過期學年度不可以早於資料本身的學年度。
ALTER TABLE "admission_references" ADD CONSTRAINT "admission_references_stale_after_year"
  CHECK ("staleAfterYear" >= "year");
-- 來源不可以是空字串。NOT NULL 擋不掉 ''，而 '' 與沒填的意思一樣。
ALTER TABLE "admission_references" ADD CONSTRAINT "admission_references_source_ref_nonempty"
  CHECK (length(btrim("sourceRef")) > 0);
ALTER TABLE "admission_references" ADD CONSTRAINT "admission_references_star_group_range"
  CHECK ("starGroup" IS NULL OR ("starGroup" BETWEEN 1 AND 8));

-- ── 租戶隔離（由 tools/rls-check.mjs --emit 產生）────────────

ALTER TABLE "admission_references" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admission_references" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admission_references_tenant_isolation" ON "admission_references";
CREATE POLICY "admission_references_tenant_isolation" ON "admission_references"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
