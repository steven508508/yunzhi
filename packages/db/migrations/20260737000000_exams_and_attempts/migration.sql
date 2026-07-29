-- 考卷、任務、作答、成績
--
-- schema 原本 42 張表全部停在題庫，於是老師建好題目之後就沒有下一步。
-- 這一份補上「從題庫到成績」那條線的骨架。
--
-- 三個 CHECK 對應三種會安靜出錯的狀況，理由寫在 schema.prisma 的
-- 區塊註解裡：作答快照與題庫分離、時間以伺服器為準、答案與計分分開存。

CREATE TYPE "PaperStatus"    AS ENUM ('DRAFT', 'READY', 'ARCHIVED');
CREATE TYPE "AssignmentMode" AS ENUM ('EXAM', 'PRACTICE');
CREATE TYPE "ReleasePolicy"  AS ENUM ('IMMEDIATE', 'ON_SUBMIT', 'ON_DUE', 'MANUAL', 'NEVER');
CREATE TYPE "AttemptStatus"  AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'GRADED', 'VOIDED');

CREATE TABLE "exam_papers" (
  "id"           TEXT PRIMARY KEY,
  "tenantId"     TEXT NOT NULL REFERENCES "tenants"("id")  ON DELETE CASCADE,
  "subjectId"    TEXT NOT NULL REFERENCES "subjects"("id") ON DELETE CASCADE,
  "title"        TEXT NOT NULL,
  "status"       "PaperStatus" NOT NULL DEFAULT 'DRAFT',
  "totalScore"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "instructions" TEXT,
  "createdBy"    TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL
);
CREATE INDEX "exam_papers_tenant_subject_status_idx"
  ON "exam_papers" ("tenantId", "subjectId", "status");

CREATE TABLE "exam_paper_items" (
  "id"         TEXT PRIMARY KEY,
  "paperId"    TEXT NOT NULL REFERENCES "exam_papers"("id") ON DELETE CASCADE,
  "questionId" TEXT NOT NULL REFERENCES "questions"("id")   ON DELETE RESTRICT,
  "order"      INTEGER NOT NULL,
  "score"      DOUBLE PRECISION NOT NULL,
  -- 同一題不能在同一份卷子上出現兩次。學生會看到兩題一樣的，
  -- 而總分算出來會比題數乘配分多。
  CONSTRAINT "exam_paper_items_unique_question" UNIQUE ("paperId", "questionId"),
  CONSTRAINT "exam_paper_items_unique_order"    UNIQUE ("paperId", "order"),
  -- 配分不得為負。送分要用加分處理，不是給一題負分。
  CONSTRAINT "exam_paper_items_score_nonneg" CHECK ("score" >= 0)
);
CREATE INDEX "exam_paper_items_question_idx" ON "exam_paper_items" ("questionId");

CREATE TABLE "assignments" (
  "id"               TEXT PRIMARY KEY,
  "tenantId"         TEXT NOT NULL REFERENCES "tenants"("id")     ON DELETE CASCADE,
  "paperId"          TEXT NOT NULL REFERENCES "exam_papers"("id") ON DELETE RESTRICT,
  "title"            TEXT NOT NULL,
  "mode"             "AssignmentMode" NOT NULL DEFAULT 'EXAM',
  "openAt"           TIMESTAMP(3),
  "dueAt"            TIMESTAMP(3),
  "timeLimitMin"     INTEGER,
  "allowLate"        BOOLEAN NOT NULL DEFAULT false,
  "maxAttempts"      INTEGER NOT NULL DEFAULT 1,
  "shuffleQuestions" BOOLEAN NOT NULL DEFAULT false,
  "shuffleOptions"   BOOLEAN NOT NULL DEFAULT false,
  "releasePolicy"    "ReleasePolicy" NOT NULL DEFAULT 'ON_DUE',
  "releasedAt"       TIMESTAMP(3),
  "createdBy"        TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  -- 截止早於開放的任務沒有人交得出來，而畫面上看起來完全正常。
  CONSTRAINT "assignments_window_ordered"
    CHECK ("openAt" IS NULL OR "dueAt" IS NULL OR "openAt" < "dueAt"),
  CONSTRAINT "assignments_time_limit_positive"
    CHECK ("timeLimitMin" IS NULL OR "timeLimitMin" > 0),
  CONSTRAINT "assignments_attempts_positive" CHECK ("maxAttempts" >= 1)
);
CREATE INDEX "assignments_tenant_window_idx"
  ON "assignments" ("tenantId", "openAt", "dueAt");

CREATE TABLE "assignment_targets" (
  "id"           TEXT PRIMARY KEY,
  "assignmentId" TEXT NOT NULL REFERENCES "assignments"("id") ON DELETE CASCADE,
  "classId"      TEXT REFERENCES "classes"("id") ON DELETE CASCADE,
  "userId"       TEXT REFERENCES "users"("id")   ON DELETE CASCADE,
  -- 一筆對象要嘛是班、要嘛是人，不能兩個都空（那筆記錄沒有意義，
  -- 而且會讓「這份任務派給誰」的查詢多回傳一列空的）。
  CONSTRAINT "assignment_targets_one_side"
    CHECK (("classId" IS NOT NULL) OR ("userId" IS NOT NULL)),
  CONSTRAINT "assignment_targets_unique" UNIQUE ("assignmentId", "classId", "userId")
);
CREATE INDEX "assignment_targets_class_idx" ON "assignment_targets" ("classId");
CREATE INDEX "assignment_targets_user_idx"  ON "assignment_targets" ("userId");

CREATE TABLE "attempts" (
  "id"            TEXT PRIMARY KEY,
  "assignmentId"  TEXT NOT NULL REFERENCES "assignments"("id") ON DELETE CASCADE,
  "userId"        TEXT NOT NULL REFERENCES "users"("id")       ON DELETE CASCADE,
  "attemptNo"     INTEGER NOT NULL DEFAULT 1,
  "status"        "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "startedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"     TIMESTAMP(3),
  "submittedAt"   TIMESTAMP(3),
  "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
  "late"          BOOLEAN NOT NULL DEFAULT false,
  "layout"        JSONB,
  "autoScore"     DOUBLE PRECISION,
  "totalScore"    DOUBLE PRECISION,
  "gradedAt"      TIMESTAMP(3),
  CONSTRAINT "attempts_unique_try" UNIQUE ("assignmentId", "userId", "attemptNo"),
  -- 交了卷就一定有交卷時間，沒交就一定沒有。少了這一條，
  -- 「已交卷但 submittedAt 是 null」會讓成績統計把它算成未交。
  CONSTRAINT "attempts_submitted_has_time" CHECK (
    ("status" IN ('SUBMITTED','GRADED') AND "submittedAt" IS NOT NULL)
    OR ("status" IN ('IN_PROGRESS','VOIDED'))
  ),
  -- 交卷時間不可能早於開始時間。時鐘倒轉或程式寫錯時擋在這裡。
  CONSTRAINT "attempts_time_ordered"
    CHECK ("submittedAt" IS NULL OR "submittedAt" >= "startedAt")
);
CREATE INDEX "attempts_user_status_idx"       ON "attempts" ("userId", "status");
CREATE INDEX "attempts_assignment_status_idx" ON "attempts" ("assignmentId", "status");

CREATE TABLE "attempt_answers" (
  "id"          TEXT PRIMARY KEY,
  "attemptId"   TEXT NOT NULL REFERENCES "attempts"("id")  ON DELETE CASCADE,
  "questionId"  TEXT NOT NULL REFERENCES "questions"("id") ON DELETE RESTRICT,
  "answerKeys"  INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "answerText"  TEXT,
  "answerSlots" JSONB,
  "flagged"     BOOLEAN NOT NULL DEFAULT false,
  "isCorrect"   BOOLEAN,
  "earnedScore" DOUBLE PRECISION,
  "scoreNote"   TEXT,
  "answeredAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "attempt_answers_unique" UNIQUE ("attemptId", "questionId")
);
CREATE INDEX "attempt_answers_question_idx" ON "attempt_answers" ("questionId");

COMMENT ON COLUMN "attempts"."expiresAt" IS
  '伺服器算出來的到期時間，開始作答時就寫死。交卷時比對的是它，不是前端送來的時間。';
COMMENT ON COLUMN "attempts"."layout" IS
  '題目與選項順序的快照。老師在考試中改了題目也不影響已開始作答的人。';
COMMENT ON COLUMN "attempt_answers"."answerKeys" IS
  '學生選了什麼。重新計分時不動這裡——那是申訴時唯一能拿出來的東西。';

-- ── 租戶隔離（由 tools/rls-check.mjs --emit 產生）──────────────

ALTER TABLE "assignment_targets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assignment_targets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "assignment_targets_tenant_isolation" ON "assignment_targets";
CREATE POLICY "assignment_targets_tenant_isolation" ON "assignment_targets"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "assignments" "rls_assignments" WHERE "rls_assignments"."id" = "assignmentId" AND "rls_assignments"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "assignments" "rls_assignments" WHERE "rls_assignments"."id" = "assignmentId" AND "rls_assignments"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assignments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "assignments_tenant_isolation" ON "assignments";
CREATE POLICY "assignments_tenant_isolation" ON "assignments"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "attempt_answers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attempt_answers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "attempt_answers_tenant_isolation" ON "attempt_answers";
CREATE POLICY "attempt_answers_tenant_isolation" ON "attempt_answers"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "attempts" "rls_attempts" WHERE "rls_attempts"."id" = "attemptId" AND EXISTS (SELECT 1 FROM "assignments" "rls_assignments" WHERE "rls_assignments"."id" = "rls_attempts"."assignmentId" AND "rls_assignments"."tenantId" = current_setting('app.tenant_id', true)))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "attempts" "rls_attempts" WHERE "rls_attempts"."id" = "attemptId" AND EXISTS (SELECT 1 FROM "assignments" "rls_assignments" WHERE "rls_assignments"."id" = "rls_attempts"."assignmentId" AND "rls_assignments"."tenantId" = current_setting('app.tenant_id', true))));

ALTER TABLE "attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attempts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "attempts_tenant_isolation" ON "attempts";
CREATE POLICY "attempts_tenant_isolation" ON "attempts"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "assignments" "rls_assignments" WHERE "rls_assignments"."id" = "assignmentId" AND "rls_assignments"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "assignments" "rls_assignments" WHERE "rls_assignments"."id" = "assignmentId" AND "rls_assignments"."tenantId" = current_setting('app.tenant_id', true)));

--
ALTER TABLE "exam_paper_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exam_paper_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exam_paper_items_tenant_isolation" ON "exam_paper_items";
CREATE POLICY "exam_paper_items_tenant_isolation" ON "exam_paper_items"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "exam_papers" "rls_exam_papers" WHERE "rls_exam_papers"."id" = "paperId" AND "rls_exam_papers"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "exam_papers" "rls_exam_papers" WHERE "rls_exam_papers"."id" = "paperId" AND "rls_exam_papers"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "exam_papers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exam_papers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exam_papers_tenant_isolation" ON "exam_papers";
CREATE POLICY "exam_papers_tenant_isolation" ON "exam_papers"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

