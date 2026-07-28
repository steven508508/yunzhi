-- 租戶隔離：Postgres row-level security
--
-- 在此之前，隔離完全靠每一個查詢自己記得帶 tenantId。12 個 API 路由時
-- 漏一個還看得出來；80 個路由時，漏掉的那一個是水平越權漏洞，
-- 而且不會有任何錯誤訊息——它只是安靜地多回傳幾列。
--
-- 這一次把隔離下沉到資料庫。應用層漏了條件，資料庫仍然擋得住。
--
-- 三個設計重點：
--
--   一、FORCE。少了它，應用程式用資料表擁有者的身分連線時 RLS
--       形同虛設——而那正是最常見的部署方式。
--   二、fail closed。`current_setting('app.tenant_id', true)` 沒設時
--       回 NULL，而 `NULL = 任何值` 是 NULL 不是 true，所以**沒設租戶
--       時什麼都看不到**。忘記設比設錯常見得多，而忘記設必須是
--       「查不到東西」而不是「查到全部」。
--   三、有名字的逃生口。`app.cross_tenant = 'on'` 讓背景工作者與遷移
--       腳本跨租戶工作。沒有逃生口的話那些程式會被迫關掉 RLS，
--       而那比留一個可稽核的開關糟。tools/rls-check.mjs 會檢查它
--       只出現在允許的檔案裡。
--
-- 本檔由 `node tools/rls-check.mjs --emit` 產生。
-- **不要手改**，改 tools/tenancy.mjs 之後重新產生。

ALTER TABLE "academic_years" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "academic_years" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "academic_years_tenant_isolation" ON "academic_years";
CREATE POLICY "academic_years_tenant_isolation" ON "academic_years"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "ai_budget_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_budget_counters" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_budget_counters_tenant_isolation" ON "ai_budget_counters";
CREATE POLICY "ai_budget_counters_tenant_isolation" ON "ai_budget_counters"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "ai_usage_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage_logs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_usage_logs_tenant_isolation" ON "ai_usage_logs";
CREATE POLICY "ai_usage_logs_tenant_isolation" ON "ai_usage_logs"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_logs_tenant_isolation" ON "audit_logs";
CREATE POLICY "audit_logs_tenant_isolation" ON "audit_logs"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "class_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "class_memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "class_memberships_tenant_isolation" ON "class_memberships";
CREATE POLICY "class_memberships_tenant_isolation" ON "class_memberships"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "classes" "rls_classes" WHERE "rls_classes"."id" = "classId" AND "rls_classes"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "classes" "rls_classes" WHERE "rls_classes"."id" = "classId" AND "rls_classes"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "class_subject_teachers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "class_subject_teachers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "class_subject_teachers_tenant_isolation" ON "class_subject_teachers";
CREATE POLICY "class_subject_teachers_tenant_isolation" ON "class_subject_teachers"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "classes" "rls_classes" WHERE "rls_classes"."id" = "classId" AND "rls_classes"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "classes" "rls_classes" WHERE "rls_classes"."id" = "classId" AND "rls_classes"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "classes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "classes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "classes_tenant_isolation" ON "classes";
CREATE POLICY "classes_tenant_isolation" ON "classes"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "curriculum_nodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "curriculum_nodes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "curriculum_nodes_tenant_isolation" ON "curriculum_nodes";
CREATE POLICY "curriculum_nodes_tenant_isolation" ON "curriculum_nodes"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "custom_question_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_question_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "custom_question_types_tenant_isolation" ON "custom_question_types";
CREATE POLICY "custom_question_types_tenant_isolation" ON "custom_question_types"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "duplicate_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "duplicate_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "duplicate_groups_tenant_isolation" ON "duplicate_groups";
CREATE POLICY "duplicate_groups_tenant_isolation" ON "duplicate_groups"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "duplicate_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "duplicate_members" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "duplicate_members_tenant_isolation" ON "duplicate_members";
CREATE POLICY "duplicate_members_tenant_isolation" ON "duplicate_members"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "duplicate_groups" "rls_duplicate_groups" WHERE "rls_duplicate_groups"."id" = "groupId" AND "rls_duplicate_groups"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "duplicate_groups" "rls_duplicate_groups" WHERE "rls_duplicate_groups"."id" = "groupId" AND "rls_duplicate_groups"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "explanations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "explanations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "explanations_tenant_isolation" ON "explanations";
CREATE POLICY "explanations_tenant_isolation" ON "explanations"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "guardian_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guardian_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "guardian_links_tenant_isolation" ON "guardian_links";
CREATE POLICY "guardian_links_tenant_isolation" ON "guardian_links"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "users" "rls_users" WHERE "rls_users"."id" = "studentId" AND "rls_users"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "users" "rls_users" WHERE "rls_users"."id" = "studentId" AND "rls_users"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "import_candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_candidates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "import_candidates_tenant_isolation" ON "import_candidates";
CREATE POLICY "import_candidates_tenant_isolation" ON "import_candidates"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "import_jobs" "rls_import_jobs" WHERE "rls_import_jobs"."id" = "jobId" AND "rls_import_jobs"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "import_jobs" "rls_import_jobs" WHERE "rls_import_jobs"."id" = "jobId" AND "rls_import_jobs"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "import_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_files" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "import_files_tenant_isolation" ON "import_files";
CREATE POLICY "import_files_tenant_isolation" ON "import_files"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "import_jobs" "rls_import_jobs" WHERE "rls_import_jobs"."id" = "jobId" AND "rls_import_jobs"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "import_jobs" "rls_import_jobs" WHERE "rls_import_jobs"."id" = "jobId" AND "rls_import_jobs"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "import_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_jobs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "import_jobs_tenant_isolation" ON "import_jobs";
CREATE POLICY "import_jobs_tenant_isolation" ON "import_jobs"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "import_pages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_pages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "import_pages_tenant_isolation" ON "import_pages";
CREATE POLICY "import_pages_tenant_isolation" ON "import_pages"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "import_jobs" "rls_import_jobs" WHERE "rls_import_jobs"."id" = "jobId" AND "rls_import_jobs"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "import_jobs" "rls_import_jobs" WHERE "rls_import_jobs"."id" = "jobId" AND "rls_import_jobs"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "knowledge_points" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_points" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "knowledge_points_tenant_isolation" ON "knowledge_points";
CREATE POLICY "knowledge_points_tenant_isolation" ON "knowledge_points"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "kp_curriculum_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kp_curriculum_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "kp_curriculum_links_tenant_isolation" ON "kp_curriculum_links";
CREATE POLICY "kp_curriculum_links_tenant_isolation" ON "kp_curriculum_links"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "knowledge_points" "rls_knowledge_points" WHERE "rls_knowledge_points"."id" = "knowledgePointId" AND "rls_knowledge_points"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "knowledge_points" "rls_knowledge_points" WHERE "rls_knowledge_points"."id" = "knowledgePointId" AND "rls_knowledge_points"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "kp_prerequisites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kp_prerequisites" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "kp_prerequisites_tenant_isolation" ON "kp_prerequisites";
CREATE POLICY "kp_prerequisites_tenant_isolation" ON "kp_prerequisites"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "knowledge_points" "rls_knowledge_points" WHERE "rls_knowledge_points"."id" = "kpId" AND "rls_knowledge_points"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "knowledge_points" "rls_knowledge_points" WHERE "rls_knowledge_points"."id" = "kpId" AND "rls_knowledge_points"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notification_preferences_tenant_isolation" ON "notification_preferences";
CREATE POLICY "notification_preferences_tenant_isolation" ON "notification_preferences"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "users" "rls_users" WHERE "rls_users"."id" = "userId" AND "rls_users"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "users" "rls_users" WHERE "rls_users"."id" = "userId" AND "rls_users"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "notification_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_templates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notification_templates_tenant_isolation" ON "notification_templates";
CREATE POLICY "notification_templates_tenant_isolation" ON "notification_templates"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notifications_tenant_isolation" ON "notifications";
CREATE POLICY "notifications_tenant_isolation" ON "notifications"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "question_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "question_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "question_groups_tenant_isolation" ON "question_groups";
CREATE POLICY "question_groups_tenant_isolation" ON "question_groups"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "question_knowledge_points" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "question_knowledge_points" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "question_knowledge_points_tenant_isolation" ON "question_knowledge_points";
CREATE POLICY "question_knowledge_points_tenant_isolation" ON "question_knowledge_points"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "questions" "rls_questions" WHERE "rls_questions"."id" = "questionId" AND "rls_questions"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "questions" "rls_questions" WHERE "rls_questions"."id" = "questionId" AND "rls_questions"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "question_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "question_options" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "question_options_tenant_isolation" ON "question_options";
CREATE POLICY "question_options_tenant_isolation" ON "question_options"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "questions" "rls_questions" WHERE "rls_questions"."id" = "questionId" AND "rls_questions"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "questions" "rls_questions" WHERE "rls_questions"."id" = "questionId" AND "rls_questions"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "question_textbook_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "question_textbook_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "question_textbook_links_tenant_isolation" ON "question_textbook_links";
CREATE POLICY "question_textbook_links_tenant_isolation" ON "question_textbook_links"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "questions" "rls_questions" WHERE "rls_questions"."id" = "questionId" AND "rls_questions"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "questions" "rls_questions" WHERE "rls_questions"."id" = "questionId" AND "rls_questions"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "questions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "questions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "questions_tenant_isolation" ON "questions";
CREATE POLICY "questions_tenant_isolation" ON "questions"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "rubric_bands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rubric_bands" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rubric_bands_tenant_isolation" ON "rubric_bands";
CREATE POLICY "rubric_bands_tenant_isolation" ON "rubric_bands"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "rubrics" "rls_rubrics" WHERE "rls_rubrics"."id" = "rubricId" AND "rls_rubrics"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "rubrics" "rls_rubrics" WHERE "rls_rubrics"."id" = "rubricId" AND "rls_rubrics"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "rubric_dimensions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rubric_dimensions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rubric_dimensions_tenant_isolation" ON "rubric_dimensions";
CREATE POLICY "rubric_dimensions_tenant_isolation" ON "rubric_dimensions"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "rubrics" "rls_rubrics" WHERE "rls_rubrics"."id" = "rubricId" AND "rls_rubrics"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "rubrics" "rls_rubrics" WHERE "rls_rubrics"."id" = "rubricId" AND "rls_rubrics"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "rubrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rubrics" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rubrics_tenant_isolation" ON "rubrics";
CREATE POLICY "rubrics_tenant_isolation" ON "rubrics"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sessions_tenant_isolation" ON "sessions";
CREATE POLICY "sessions_tenant_isolation" ON "sessions"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "users" "rls_users" WHERE "rls_users"."id" = "userId" AND "rls_users"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "users" "rls_users" WHERE "rls_users"."id" = "userId" AND "rls_users"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "subjects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subjects" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "subjects_tenant_isolation" ON "subjects";
CREATE POLICY "subjects_tenant_isolation" ON "subjects"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenants_tenant_isolation" ON "tenants";
CREATE POLICY "tenants_tenant_isolation" ON "tenants"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "id" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "id" = current_setting('app.tenant_id', true));

ALTER TABLE "textbook_curriculum_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "textbook_curriculum_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "textbook_curriculum_links_tenant_isolation" ON "textbook_curriculum_links";
CREATE POLICY "textbook_curriculum_links_tenant_isolation" ON "textbook_curriculum_links"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "textbook_nodes" "rls_textbook_nodes" WHERE "rls_textbook_nodes"."id" = "textbookNodeId" AND EXISTS (SELECT 1 FROM "textbook_editions" "rls_textbook_editions" WHERE "rls_textbook_editions"."id" = "rls_textbook_nodes"."editionId" AND "rls_textbook_editions"."tenantId" = current_setting('app.tenant_id', true)))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "textbook_nodes" "rls_textbook_nodes" WHERE "rls_textbook_nodes"."id" = "textbookNodeId" AND EXISTS (SELECT 1 FROM "textbook_editions" "rls_textbook_editions" WHERE "rls_textbook_editions"."id" = "rls_textbook_nodes"."editionId" AND "rls_textbook_editions"."tenantId" = current_setting('app.tenant_id', true))));

ALTER TABLE "textbook_editions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "textbook_editions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "textbook_editions_tenant_isolation" ON "textbook_editions";
CREATE POLICY "textbook_editions_tenant_isolation" ON "textbook_editions"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "textbook_nodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "textbook_nodes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "textbook_nodes_tenant_isolation" ON "textbook_nodes";
CREATE POLICY "textbook_nodes_tenant_isolation" ON "textbook_nodes"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "textbook_editions" "rls_textbook_editions" WHERE "rls_textbook_editions"."id" = "editionId" AND "rls_textbook_editions"."tenantId" = current_setting('app.tenant_id', true))) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR EXISTS (SELECT 1 FROM "textbook_editions" "rls_textbook_editions" WHERE "rls_textbook_editions"."id" = "editionId" AND "rls_textbook_editions"."tenantId" = current_setting('app.tenant_id', true)));

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_tenant_isolation" ON "users";
CREATE POLICY "users_tenant_isolation" ON "users"
  FOR ALL USING (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.cross_tenant', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

