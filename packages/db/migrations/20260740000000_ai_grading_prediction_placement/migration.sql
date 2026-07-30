-- 非選題的 AI 閱卷、級分預測、個申落點
--
-- 設計決定寫在 schema.prisma 對應區塊。SQL 層面最重要的是那幾條
-- CHECK：它們擋的都是「會安靜地算錯然後印在成績單上」的那一類。

CREATE TYPE "ProposalState" AS ENUM ('PENDING', 'ACCEPTED', 'ADJUSTED', 'REJECTED', 'BLOCKED');

-- ── AI 閱卷建議 ─────────────────────────────────────────────

CREATE TABLE "answer_grade_proposals" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "attemptId"      TEXT NOT NULL,
  "questionId"     TEXT NOT NULL,
  "state"          "ProposalState" NOT NULL DEFAULT 'PENDING',
  "suggestedScore" DOUBLE PRECISION NOT NULL,
  "dimensions"     JSONB NOT NULL DEFAULT '[]',
  "rationale"      TEXT NOT NULL,
  "confidence"     DOUBLE PRECISION,
  "blockedReason"  TEXT,
  "modelUsed"      TEXT,
  "promptVersion"  TEXT,
  "rubricId"       TEXT,
  "finalScore"     DOUBLE PRECISION,
  "decidedBy"      TEXT,
  "decidedAt"      TIMESTAMP(3),
  "decisionNote"   TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "answer_grade_proposals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "answer_grade_proposals_attemptId_questionId_key"
  ON "answer_grade_proposals"("attemptId", "questionId");
CREATE INDEX "answer_grade_proposals_tenantId_state_createdAt_idx"
  ON "answer_grade_proposals"("tenantId", "state", "createdAt");

ALTER TABLE "answer_grade_proposals" ADD CONSTRAINT "answer_grade_proposals_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "answer_grade_proposals" ADD CONSTRAINT "answer_grade_proposals_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "answer_grade_proposals" ADD CONSTRAINT "answer_grade_proposals_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 分數不可能是負的。
ALTER TABLE "answer_grade_proposals" ADD CONSTRAINT "answer_grade_proposals_scores_nonneg"
  CHECK ("suggestedScore" >= 0 AND ("finalScore" IS NULL OR "finalScore" >= 0));
ALTER TABLE "answer_grade_proposals" ADD CONSTRAINT "answer_grade_proposals_confidence_range"
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));
-- 被擋下的建議一定要說得出為什麼。沒有理由的 BLOCKED 等於沒有記錄。
ALTER TABLE "answer_grade_proposals" ADD CONSTRAINT "answer_grade_proposals_blocked_has_reason"
  CHECK ("state" <> 'BLOCKED' OR "blockedReason" IS NOT NULL);
-- **已決定的建議一定要有人與時間。** 少了這一條，一筆「已採用」但
-- 查不出是誰採用的紀錄，在家長申訴時等於沒有紀錄。
ALTER TABLE "answer_grade_proposals" ADD CONSTRAINT "answer_grade_proposals_decided_has_actor"
  CHECK (
    "state" IN ('PENDING', 'BLOCKED')
    OR ("decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL AND "finalScore" IS NOT NULL)
  );
-- 改了分數或不採用時要說為什麼。那是改進提示詞的唯一素材，
-- 而且是判斷「這個功能該不該繼續用」的依據。
ALTER TABLE "answer_grade_proposals" ADD CONSTRAINT "answer_grade_proposals_change_has_note"
  CHECK ("state" NOT IN ('ADJUSTED', 'REJECTED') OR length(btrim(coalesce("decisionNote", ''))) > 0);

-- ── 級分記錄 ────────────────────────────────────────────────

CREATE TABLE "subject_grade_records" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "subjectCode" TEXT NOT NULL,
  "examName"    TEXT NOT NULL,
  "examDate"    TIMESTAMP(3) NOT NULL,
  "grade"       INTEGER NOT NULL,
  "percentile"  DOUBLE PRECISION,
  "source"      TEXT NOT NULL,
  "enteredBy"   TEXT NOT NULL,
  "note"        TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "subject_grade_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subject_grade_records_userId_subjectCode_examName_key"
  ON "subject_grade_records"("userId", "subjectCode", "examName");
CREATE INDEX "subject_grade_records_tenantId_userId_examDate_idx"
  ON "subject_grade_records"("tenantId", "userId", "examDate");
ALTER TABLE "subject_grade_records" ADD CONSTRAINT "subject_grade_records_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subject_grade_records" ADD CONSTRAINT "subject_grade_records_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 級分是 0 到 15。填成百分制的那一次（例如 78）會讓整條趨勢與所有
-- 下游的落點計算失去意義，而畫面上只是一個看起來偏高的數字。
ALTER TABLE "subject_grade_records" ADD CONSTRAINT "subject_grade_records_grade_range"
  CHECK ("grade" BETWEEN 0 AND 15);
ALTER TABLE "subject_grade_records" ADD CONSTRAINT "subject_grade_records_percentile_range"
  CHECK ("percentile" IS NULL OR ("percentile" >= 0 AND "percentile" <= 100));
ALTER TABLE "subject_grade_records" ADD CONSTRAINT "subject_grade_records_source_known"
  CHECK ("source" IN ('EXTERNAL_MOCK', 'INTERNAL_MOCK', 'OFFICIAL_GSAT'));

-- ── 級分預測 ────────────────────────────────────────────────

CREATE TABLE "grade_predictions" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "subjectCode"  TEXT NOT NULL,
  "targetYear"   INTEGER NOT NULL,
  "intervalLow"  INTEGER NOT NULL,
  "intervalHigh" INTEGER NOT NULL,
  "confidence"   DOUBLE PRECISION NOT NULL,
  "distribution" JSONB NOT NULL,
  "basis"        JSONB NOT NULL,
  "thin"         BOOLEAN NOT NULL DEFAULT false,
  "actualGrade"  INTEGER,
  "predictedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "grade_predictions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "grade_predictions_tenantId_targetYear_subjectCode_idx"
  ON "grade_predictions"("tenantId", "targetYear", "subjectCode");
CREATE INDEX "grade_predictions_userId_predictedAt_idx"
  ON "grade_predictions"("userId", "predictedAt");
ALTER TABLE "grade_predictions" ADD CONSTRAINT "grade_predictions_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "grade_predictions" ADD CONSTRAINT "grade_predictions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "grade_predictions" ADD CONSTRAINT "grade_predictions_grade_range"
  CHECK (
    "intervalLow" BETWEEN 0 AND 15 AND "intervalHigh" BETWEEN 0 AND 15
    AND ("actualGrade" IS NULL OR "actualGrade" BETWEEN 0 AND 15)
  );
-- 上界不可以低於下界。反了的話畫面上會出現「預估 13 至 11 級分」。
ALTER TABLE "grade_predictions" ADD CONSTRAINT "grade_predictions_interval_ordered"
  CHECK ("intervalHigh" >= "intervalLow");
-- **信心水準必須在 0 與 1 之間而且不可以是 1。**
-- 1 代表「保證」，而這個系統不做保證——規格書第 2.3 節。
ALTER TABLE "grade_predictions" ADD CONSTRAINT "grade_predictions_confidence_range"
  CHECK ("confidence" > 0 AND "confidence" < 1);
ALTER TABLE "grade_predictions" ADD CONSTRAINT "grade_predictions_year_roc"
  CHECK ("targetYear" BETWEEN 100 AND 200);

-- ── 落點模擬 ────────────────────────────────────────────────

CREATE TABLE "simulation_runs" (
  "id"       TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId"   TEXT NOT NULL,
  "channel"  "AdmissionChannel" NOT NULL,
  "year"     INTEGER NOT NULL,
  "input"    JSONB NOT NULL,
  "result"   JSONB NOT NULL,
  "dataAsOf" TIMESTAMP(3) NOT NULL,
  "draws"    INTEGER NOT NULL DEFAULT 10000,
  "runAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "simulation_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "simulation_runs_tenantId_userId_runAt_idx"
  ON "simulation_runs"("tenantId", "userId", "runAt");
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_draws_positive"
  CHECK ("draws" > 0);
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_year_roc"
  CHECK ("year" BETWEEN 100 AND 200);

-- ── 租戶隔離（由 tools/rls-check.mjs --emit 產生）────────────

ALTER TABLE "answer_grade_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "answer_grade_proposals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "answer_grade_proposals_tenant_isolation" ON "answer_grade_proposals";
CREATE POLICY "answer_grade_proposals_tenant_isolation" ON "answer_grade_proposals"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "grade_predictions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "grade_predictions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "grade_predictions_tenant_isolation" ON "grade_predictions";
CREATE POLICY "grade_predictions_tenant_isolation" ON "grade_predictions"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "simulation_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "simulation_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "simulation_runs_tenant_isolation" ON "simulation_runs";
CREATE POLICY "simulation_runs_tenant_isolation" ON "simulation_runs"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "subject_grade_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subject_grade_records" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "subject_grade_records_tenant_isolation" ON "subject_grade_records";
CREATE POLICY "subject_grade_records_tenant_isolation" ON "subject_grade_records"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
