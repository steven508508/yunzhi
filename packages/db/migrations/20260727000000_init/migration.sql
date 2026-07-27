-- 雲端智學 — 初始遷移
--
-- 這份 SQL 是 `prisma migrate deploy` 實際執行的內容。
-- 手寫而非全依賴 `migrate dev` 產生，理由是正式部署要能
-- **審閱**遷移內容 —— 尤其是索引與約束，它們對 300 人同時
-- 交卷的效能有直接影響，不該是黑盒子。

-- ── 擴充功能 ──────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 列舉 ──────────────────────────────────────────────────────
CREATE TYPE "UserStatus"    AS ENUM ('PENDING_CONSENT','ACTIVE','SUSPENDED','ARCHIVED');
CREATE TYPE "SystemRole"    AS ENUM ('STUDENT','GUARDIAN','TEACHER','SUBJECT_LEAD','SCHOOL_ADMIN','SYS_ADMIN');
CREATE TYPE "ClassRole"     AS ENUM ('STUDENT','TEACHER','ASSISTANT','COUNSELOR');
CREATE TYPE "ClassType"     AS ENUM ('HOMEROOM','GROUP');
CREATE TYPE "AuditCategory" AS ENUM ('AUTH','USER','QUESTION','GRADE','EXAM','BILLING','SYSTEM','SECURITY');
CREATE TYPE "AiPurpose"     AS ENUM ('IMPORT_EXTRACT','IMPORT_SOLVE','IMPORT_ANNOTATE','IMPORT_REWRITE','GRADING','EXPLANATION','TUTOR','ERROR_TAG','QUALITY_CHECK','EMBEDDING','OTHER');
CREATE TYPE "AiTier"        AS ENUM ('HIGH','MID','LIGHT','EMBEDDING');
CREATE TYPE "NotifyChannel" AS ENUM ('IN_APP','EMAIL','LINE','SMS');
CREATE TYPE "NotifyStatus"  AS ENUM ('QUEUED','SENDING','SENT','FAILED','SUPPRESSED');

-- ── 租戶與學年 ────────────────────────────────────────────────
CREATE TABLE "tenants" (
  "id"        TEXT PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "settings"  JSONB NOT NULL DEFAULT '{}',
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "academic_years" (
  "id"        TEXT PRIMARY KEY,
  "tenantId"  TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name"      TEXT NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate"   TIMESTAMP(3) NOT NULL,
  "isCurrent" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "academic_years_tenantId_name_key" ON "academic_years"("tenantId","name");
CREATE INDEX "academic_years_tenantId_isCurrent_idx" ON "academic_years"("tenantId","isCurrent");

-- ── 身分 ──────────────────────────────────────────────────────
CREATE TABLE "users" (
  "id"                 TEXT PRIMARY KEY,
  "tenantId"           TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "username"           TEXT NOT NULL,
  "email"              TEXT,
  "displayName"        TEXT NOT NULL,
  "passwordHash"       TEXT,
  "status"             "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "systemRole"         "SystemRole" NOT NULL DEFAULT 'STUDENT',
  "birthDate"          TIMESTAMP(3),
  "guardianEmail"      TEXT,
  "consentAt"          TIMESTAMP(3),
  "a11yProfile"        JSONB,
  "failedLoginCount"   INTEGER NOT NULL DEFAULT 0,
  "lockedUntil"        TIMESTAMP(3),
  "lastLoginAt"        TIMESTAMP(3),
  "passwordChangedAt"  TIMESTAMP(3),
  "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  "deletedAt"          TIMESTAMP(3)
);
CREATE UNIQUE INDEX "users_tenantId_username_key" ON "users"("tenantId","username");
CREATE UNIQUE INDEX "users_tenantId_email_key"    ON "users"("tenantId","email");
CREATE INDEX "users_tenantId_status_idx"     ON "users"("tenantId","status");
CREATE INDEX "users_tenantId_systemRole_idx" ON "users"("tenantId","systemRole");

CREATE TABLE "guardian_links" (
  "id"         TEXT PRIMARY KEY,
  "guardianId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "studentId"  TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "verifiedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "guardian_links_guardianId_studentId_key" ON "guardian_links"("guardianId","studentId");
CREATE INDEX "guardian_links_studentId_idx" ON "guardian_links"("studentId");

CREATE TABLE "classes" (
  "id"             TEXT PRIMARY KEY,
  "tenantId"       TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "academicYearId" TEXT NOT NULL REFERENCES "academic_years"("id") ON DELETE RESTRICT,
  "name"           TEXT NOT NULL,
  "type"           "ClassType" NOT NULL DEFAULT 'HOMEROOM',
  "active"         BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "classes_tenantId_academicYearId_name_key" ON "classes"("tenantId","academicYearId","name");
CREATE INDEX "classes_tenantId_active_idx" ON "classes"("tenantId","active");

CREATE TABLE "class_memberships" (
  "id"       TEXT PRIMARY KEY,
  "classId"  TEXT NOT NULL REFERENCES "classes"("id") ON DELETE CASCADE,
  "userId"   TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role"     "ClassRole" NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt"   TIMESTAMP(3)
);
CREATE UNIQUE INDEX "class_memberships_classId_userId_role_key" ON "class_memberships"("classId","userId","role");
CREATE INDEX "class_memberships_userId_leftAt_idx" ON "class_memberships"("userId","leftAt");

-- ── Session ───────────────────────────────────────────────────
-- 用資料庫 session 而非純 JWT：考試場景需要「立刻登出某個帳號」，
-- 而 JWT 要等到過期才失效。
CREATE TABLE "sessions" (
  "id"           TEXT PRIMARY KEY,
  "sessionToken" TEXT NOT NULL UNIQUE,
  "userId"       TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "expires"      TIMESTAMP(3) NOT NULL,
  "ipAddress"    TEXT,
  "userAgent"    TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "sessions_userId_idx"  ON "sessions"("userId");
CREATE INDEX "sessions_expires_idx" ON "sessions"("expires");

-- ── 稽核（append-only，觸發器在 seed 階段建立） ────────────────
CREATE TABLE "audit_logs" (
  "id"         TEXT PRIMARY KEY,
  "tenantId"   TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE RESTRICT,
  "category"   "AuditCategory" NOT NULL,
  "action"     TEXT NOT NULL,
  "actorId"    TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "actorIp"    TEXT,
  "targetType" TEXT,
  "targetId"   TEXT,
  "before"     JSONB,
  "after"      JSONB,
  "metadata"   JSONB,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "audit_logs_tenantId_category_createdAt_idx"  ON "audit_logs"("tenantId","category","createdAt");
CREATE INDEX "audit_logs_tenantId_targetType_targetId_idx" ON "audit_logs"("tenantId","targetType","targetId");
CREATE INDEX "audit_logs_actorId_createdAt_idx"            ON "audit_logs"("actorId","createdAt");

-- ── 系統設定與部署紀錄 ────────────────────────────────────────
CREATE TABLE "system_settings" (
  "key"         TEXT PRIMARY KEY,
  "value"       JSONB NOT NULL,
  "description" TEXT,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "updatedBy"   TEXT
);

CREATE TABLE "deployment_records" (
  "id"            TEXT PRIMARY KEY,
  "appVersion"    TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "action"        TEXT NOT NULL,
  "startedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"    TIMESTAMP(3),
  "succeeded"     BOOLEAN,
  "backupPath"    TEXT,
  "notes"         TEXT
);
CREATE INDEX "deployment_records_startedAt_idx" ON "deployment_records"("startedAt");

-- ── AI 用量 ───────────────────────────────────────────────────
CREATE TABLE "ai_usage_logs" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL,
  "purpose"       "AiPurpose" NOT NULL,
  "tier"          "AiTier" NOT NULL,
  "provider"      TEXT NOT NULL,
  "model"         TEXT NOT NULL,
  "baseUrl"       TEXT,
  "inputTokens"   INTEGER NOT NULL DEFAULT 0,
  "outputTokens"  INTEGER NOT NULL DEFAULT 0,
  "estimatedCost" DECIMAL(12,6),
  "latencyMs"     INTEGER,
  "succeeded"     BOOLEAN NOT NULL DEFAULT true,
  "errorCode"     TEXT,
  "retryCount"    INTEGER NOT NULL DEFAULT 0,
  "refType"       TEXT,
  "refId"         TEXT,
  "promptVersion" TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ai_usage_logs_tenantId_createdAt_idx"         ON "ai_usage_logs"("tenantId","createdAt");
CREATE INDEX "ai_usage_logs_tenantId_purpose_createdAt_idx" ON "ai_usage_logs"("tenantId","purpose","createdAt");
CREATE INDEX "ai_usage_logs_refType_refId_idx"              ON "ai_usage_logs"("refType","refId");

CREATE TABLE "ai_budget_counters" (
  "id"           TEXT PRIMARY KEY,
  "tenantId"     TEXT NOT NULL,
  "yearMonth"    TEXT NOT NULL,
  "inputTokens"  BIGINT NOT NULL DEFAULT 0,
  "outputTokens" BIGINT NOT NULL DEFAULT 0,
  "callCount"    INTEGER NOT NULL DEFAULT 0,
  "updatedAt"    TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "ai_budget_counters_tenantId_yearMonth_key" ON "ai_budget_counters"("tenantId","yearMonth");

-- ── 通知 ──────────────────────────────────────────────────────
CREATE TABLE "notification_templates" (
  "id"        TEXT PRIMARY KEY,
  "tenantId"  TEXT NOT NULL,
  "key"       TEXT NOT NULL,
  "channel"   "NotifyChannel" NOT NULL,
  "subject"   TEXT,
  "body"      TEXT NOT NULL,
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "notification_templates_tenantId_key_channel_key" ON "notification_templates"("tenantId","key","channel");

CREATE TABLE "notifications" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "channel"     "NotifyChannel" NOT NULL,
  "templateKey" TEXT NOT NULL,
  "payload"     JSONB NOT NULL,
  "status"      "NotifyStatus" NOT NULL DEFAULT 'QUEUED',
  "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt"      TIMESTAMP(3),
  "readAt"      TIMESTAMP(3),
  "failReason"  TEXT,
  "retryCount"  INTEGER NOT NULL DEFAULT 0,
  "dedupeKey"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- 去重鍵：同一事件重試或多次觸發時只送一次，
-- 避免家長在一分鐘內收到五則相同的到班通知。
CREATE UNIQUE INDEX "notifications_tenantId_dedupeKey_key" ON "notifications"("tenantId","dedupeKey");
CREATE INDEX "notifications_recipientId_status_scheduledAt_idx" ON "notifications"("recipientId","status","scheduledAt");
CREATE INDEX "notifications_tenantId_status_scheduledAt_idx"    ON "notifications"("tenantId","status","scheduledAt");

CREATE TABLE "notification_preferences" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL UNIQUE,
  "channels"   JSONB NOT NULL DEFAULT '{}',
  "quietHours" JSONB,
  "lineUserId" TEXT,
  "updatedAt"  TIMESTAMP(3) NOT NULL
);
