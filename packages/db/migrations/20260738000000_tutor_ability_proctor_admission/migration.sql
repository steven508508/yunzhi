-- 智慧老師、能力分析、考試行為偵測、升學輔導（第一階段）
--
-- 設計決定寫在 schema.prisma 對應區塊的註解裡，這裡只寫 SQL 層面的事。
--
-- **所有新表建立時都是空的**，所以外鍵的驗證掃描不受 RLS 影響
-- （見 tools/tenancy.mjs 檔頭的警告）。日後對這幾張表補外鍵時要注意。

-- ── Enum ────────────────────────────────────────────────────

CREATE TYPE "TutorRole" AS ENUM ('STUDENT', 'TUTOR', 'CONTEXT');
CREATE TYPE "TutorStatus" AS ENUM ('OPEN', 'CLOSED', 'HALTED');
CREATE TYPE "ProctorEventType" AS ENUM (
  'TAB_HIDDEN', 'TAB_VISIBLE', 'WINDOW_BLUR', 'WINDOW_FOCUS',
  'FULLSCREEN_EXIT', 'FULLSCREEN_ENTER', 'PASTE', 'LONG_ABSENCE'
);
CREATE TYPE "AdmissionChannel" AS ENUM ('SPECIAL', 'STAR', 'APPLY', 'PLACEMENT');
CREATE TYPE "StarCategory" AS ENUM ('NONE', 'GROUP_1_7', 'GROUP_8');

-- ── 智慧老師 ────────────────────────────────────────────────

CREATE TABLE "tutor_sessions" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "attemptId"    TEXT,
  "questionId"   TEXT NOT NULL,
  "status"       "TutorStatus" NOT NULL DEFAULT 'OPEN',
  "stuckAt"      TEXT,
  "kpIds"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "resolvedAt"   TIMESTAMP(3),
  "messageCount" INTEGER NOT NULL DEFAULT 0,
  "tokensIn"     INTEGER NOT NULL DEFAULT 0,
  "tokensOut"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tutor_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tutor_sessions_tenantId_userId_createdAt_idx"
  ON "tutor_sessions"("tenantId", "userId", "createdAt");
CREATE INDEX "tutor_sessions_questionId_idx" ON "tutor_sessions"("questionId");

ALTER TABLE "tutor_sessions" ADD CONSTRAINT "tutor_sessions_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tutor_sessions" ADD CONSTRAINT "tutor_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tutor_sessions" ADD CONSTRAINT "tutor_sessions_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tutor_sessions" ADD CONSTRAINT "tutor_sessions_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 用量計數不可能是負的。算錯的話帳單對不起來，而那要到月底才發現。
ALTER TABLE "tutor_sessions" ADD CONSTRAINT "tutor_sessions_counts_nonneg"
  CHECK ("messageCount" >= 0 AND "tokensIn" >= 0 AND "tokensOut" >= 0);

CREATE TABLE "tutor_messages" (
  "id"            TEXT NOT NULL,
  "sessionId"     TEXT NOT NULL,
  "role"          "TutorRole" NOT NULL,
  "content"       TEXT NOT NULL,
  "blocked"       BOOLEAN NOT NULL DEFAULT false,
  "blockedReason" TEXT,
  "modelUsed"     TEXT,
  "promptVersion" TEXT,
  "latencyMs"     INTEGER,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tutor_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tutor_messages_sessionId_createdAt_idx"
  ON "tutor_messages"("sessionId", "createdAt");
ALTER TABLE "tutor_messages" ADD CONSTRAINT "tutor_messages_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "tutor_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 被擋下來的訊息一定要說得出為什麼。沒有理由的 blocked 等於沒有記錄。
ALTER TABLE "tutor_messages" ADD CONSTRAINT "tutor_messages_blocked_has_reason"
  CHECK ("blocked" = false OR "blockedReason" IS NOT NULL);

-- ── 能力分析 ────────────────────────────────────────────────

CREATE TABLE "ability_snapshots" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "knowledgePointId" TEXT NOT NULL,
  "correct"          INTEGER NOT NULL DEFAULT 0,
  "total"            INTEGER NOT NULL DEFAULT 0,
  "mastery"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "reliable"         BOOLEAN NOT NULL DEFAULT false,
  "lastAnsweredAt"   TIMESTAMP(3),
  "streakWrong"      INTEGER NOT NULL DEFAULT 0,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ability_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ability_snapshots_userId_knowledgePointId_key"
  ON "ability_snapshots"("userId", "knowledgePointId");
CREATE INDEX "ability_snapshots_tenantId_knowledgePointId_idx"
  ON "ability_snapshots"("tenantId", "knowledgePointId");

ALTER TABLE "ability_snapshots" ADD CONSTRAINT "ability_snapshots_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ability_snapshots" ADD CONSTRAINT "ability_snapshots_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ability_snapshots" ADD CONSTRAINT "ability_snapshots_kp_fkey"
  FOREIGN KEY ("knowledgePointId") REFERENCES "knowledge_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 掌握度是 0 到 1。超出範圍代表計算公式寫錯了，而畫面上會顯示
-- 「掌握度 137%」——那種東西沒有人會相信，但也不會有人回報。
ALTER TABLE "ability_snapshots" ADD CONSTRAINT "ability_snapshots_mastery_range"
  CHECK ("mastery" >= 0 AND "mastery" <= 1);
-- 答對數不可能超過作答數。
ALTER TABLE "ability_snapshots" ADD CONSTRAINT "ability_snapshots_counts_sane"
  CHECK ("correct" >= 0 AND "total" >= 0 AND "correct" <= "total" AND "streakWrong" >= 0);

-- ── 考試行為偵測 ────────────────────────────────────────────

CREATE TABLE "proctor_events" (
  "id"            TEXT NOT NULL,
  "attemptId"     TEXT NOT NULL,
  "type"          "ProctorEventType" NOT NULL,
  "at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "durationMs"    INTEGER,
  "questionOrder" INTEGER,
  "meta"          JSONB,
  CONSTRAINT "proctor_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "proctor_events_attemptId_at_idx" ON "proctor_events"("attemptId", "at");
ALTER TABLE "proctor_events" ADD CONSTRAINT "proctor_events_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "proctor_events" ADD CONSTRAINT "proctor_events_duration_nonneg"
  CHECK ("durationMs" IS NULL OR "durationMs" >= 0);

-- ── 升學輔導 ────────────────────────────────────────────────

CREATE TABLE "admission_profiles" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "year"            INTEGER NOT NULL,
  "isRepeater"      BOOLEAN NOT NULL DEFAULT false,
  "sameSchoolAll"   BOOLEAN NOT NULL DEFAULT true,
  "specialAdmitted" BOOLEAN NOT NULL DEFAULT false,
  "specialWaived"   BOOLEAN NOT NULL DEFAULT false,
  "starCategory"    "StarCategory" NOT NULL DEFAULT 'NONE',
  "starWaived"      BOOLEAN NOT NULL DEFAULT false,
  "applyAdmitted"   BOOLEAN NOT NULL DEFAULT false,
  "applyWaived"     BOOLEAN NOT NULL DEFAULT false,
  "gsatScores"      JSONB,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "admission_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "admission_profiles_userId_year_key" ON "admission_profiles"("userId", "year");
CREATE INDEX "admission_profiles_tenantId_year_idx" ON "admission_profiles"("tenantId", "year");
ALTER TABLE "admission_profiles" ADD CONSTRAINT "admission_profiles_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admission_profiles" ADD CONSTRAINT "admission_profiles_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 民國學年度。115 是 2026 學年。範圍寬一點，但擋得掉把西元年填進來
-- 的那一次——2026 會讓所有的資格判定安靜地比對不到任何一年。
ALTER TABLE "admission_profiles" ADD CONSTRAINT "admission_profiles_year_roc"
  CHECK ("year" BETWEEN 100 AND 200);
-- 沒有錄取就談不上放棄。放棄一個沒錄取的管道是資料錯誤，而它會讓
-- 資格判定走進一個規格書沒有定義的狀態。
ALTER TABLE "admission_profiles" ADD CONSTRAINT "admission_profiles_waive_needs_admit"
  CHECK (
    ("specialWaived" = false OR "specialAdmitted" = true)
    AND ("starWaived" = false OR "starCategory" <> 'NONE')
    AND ("applyWaived" = false OR "applyAdmitted" = true)
  );

CREATE TABLE "academic_ranks" (
  "id"         TEXT NOT NULL,
  "tenantId"   TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "year"       INTEGER NOT NULL,
  "percentile" DOUBLE PRECISION NOT NULL,
  "semesters"  INTEGER NOT NULL DEFAULT 5,
  "importedBy" TEXT NOT NULL,
  "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "academic_ranks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "academic_ranks_userId_year_key" ON "academic_ranks"("userId", "year");
CREATE INDEX "academic_ranks_tenantId_year_idx" ON "academic_ranks"("tenantId", "year");
ALTER TABLE "academic_ranks" ADD CONSTRAINT "academic_ranks_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "academic_ranks" ADD CONSTRAINT "academic_ranks_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 百分比是 0 到 100，而且越小越好。填成 0.15 而不是 15 的那一次，
-- 這個約束擋不掉——但它擋得掉 150 與負數。
ALTER TABLE "academic_ranks" ADD CONSTRAINT "academic_ranks_percentile_range"
  CHECK ("percentile" > 0 AND "percentile" <= 100);
ALTER TABLE "academic_ranks" ADD CONSTRAINT "academic_ranks_semesters_positive"
  CHECK ("semesters" > 0);

CREATE TABLE "wishes" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "year"            INTEGER NOT NULL,
  "channel"         "AdmissionChannel" NOT NULL,
  "rank"            INTEGER NOT NULL,
  "institutionName" TEXT NOT NULL,
  "programName"     TEXT,
  "starGroup"       INTEGER,
  "interestTag"     TEXT,
  "note"            TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "wishes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wishes_userId_year_channel_rank_key"
  ON "wishes"("userId", "year", "channel", "rank");
CREATE INDEX "wishes_tenantId_year_channel_idx" ON "wishes"("tenantId", "year", "channel");
ALTER TABLE "wishes" ADD CONSTRAINT "wishes_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wishes" ADD CONSTRAINT "wishes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wishes" ADD CONSTRAINT "wishes_rank_positive" CHECK ("rank" > 0);
-- 繁星學群是 1 到 8。第 8 類是醫牙，規則與 1-7 類不同。
ALTER TABLE "wishes" ADD CONSTRAINT "wishes_star_group_range"
  CHECK ("starGroup" IS NULL OR ("starGroup" BETWEEN 1 AND 8));
-- 繁星的志願一定要指定學群，否則校內賽局模擬排不出推薦序。
ALTER TABLE "wishes" ADD CONSTRAINT "wishes_star_needs_group"
  CHECK ("channel" <> 'STAR' OR "starGroup" IS NOT NULL);

-- ── 租戶隔離（由 tools/rls-check.mjs --emit 產生）────────────

ALTER TABLE "ability_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ability_snapshots" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ability_snapshots_tenant_isolation" ON "ability_snapshots";
CREATE POLICY "ability_snapshots_tenant_isolation" ON "ability_snapshots"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "academic_ranks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "academic_ranks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "academic_ranks_tenant_isolation" ON "academic_ranks";
CREATE POLICY "academic_ranks_tenant_isolation" ON "academic_ranks"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "admission_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admission_profiles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admission_profiles_tenant_isolation" ON "admission_profiles";
CREATE POLICY "admission_profiles_tenant_isolation" ON "admission_profiles"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "proctor_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "proctor_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "proctor_events_tenant_isolation" ON "proctor_events";
CREATE POLICY "proctor_events_tenant_isolation" ON "proctor_events"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "attempts" "rls_attempts" WHERE "rls_attempts"."id" = "attemptId" AND EXISTS (SELECT 1 FROM "assignments" "rls_assignments" WHERE "rls_assignments"."id" = "rls_attempts"."assignmentId" AND "rls_assignments"."tenantId" = current_setting('app.tenant_id', true)))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "attempts" "rls_attempts" WHERE "rls_attempts"."id" = "attemptId" AND EXISTS (SELECT 1 FROM "assignments" "rls_assignments" WHERE "rls_assignments"."id" = "rls_attempts"."assignmentId" AND "rls_assignments"."tenantId" = current_setting('app.tenant_id', true))));
ALTER TABLE "tutor_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tutor_messages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tutor_messages_tenant_isolation" ON "tutor_messages";
CREATE POLICY "tutor_messages_tenant_isolation" ON "tutor_messages"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "tutor_sessions" "rls_tutor_sessions" WHERE "rls_tutor_sessions"."id" = "sessionId" AND "rls_tutor_sessions"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "tutor_sessions" "rls_tutor_sessions" WHERE "rls_tutor_sessions"."id" = "sessionId" AND "rls_tutor_sessions"."tenantId" = current_setting('app.tenant_id', true)));
ALTER TABLE "tutor_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tutor_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tutor_sessions_tenant_isolation" ON "tutor_sessions";
CREATE POLICY "tutor_sessions_tenant_isolation" ON "tutor_sessions"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "wishes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wishes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wishes_tenant_isolation" ON "wishes";
CREATE POLICY "wishes_tenant_isolation" ON "wishes"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
