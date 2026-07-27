-- 雲端智學 — 題庫與匯入管線
--
-- 手寫 SQL 而非全依賴 prisma migrate dev，理由同前一份遷移：
-- 正式部署要能審閱索引與約束，它們對「全班同時交卷」的效能有直接影響。
--
-- 本次新增的重點，全部來自 115 學測真實試卷的體例：
--   · 選項數不固定（數學 5 個、英文 4 個），所以選項獨立成表而非 JSON 陣列
--   · 多選題需要多個正解 → answerKeys 為陣列
--   · 選填題的答案要對應答案卡上編號的格位 → answerSlots
--   · 題組共用前導敘述，子題編號用全形（a）（b）→ QuestionGroup + subLabel
--   · 非選題沒有答案只有評分等第 → Rubric / RubricBand

-- ═══════════════════════════════════════════════════════════════
-- 列舉
-- ═══════════════════════════════════════════════════════════════

CREATE TYPE "QuestionType" AS ENUM (
  'SINGLE_CHOICE',    -- 單選題
  'MULTI_CHOICE',     -- 多選題（部分給分：答錯 k 個得 (n-2k)/n）
  'FILL_SLOT',        -- 選填題（答案填入答案卡編號格位）
  'FILL_TEXT',        -- 一般填空
  'SHORT_ANSWER',     -- 簡答（非選，有評分原則）
  'ESSAY',            -- 作文／申論
  'TRANSLATION',      -- 中譯英
  'TRUE_FALSE'
);

CREATE TYPE "QuestionStatus" AS ENUM ('DRAFT','PENDING_REVIEW','PUBLISHED','RETIRED');

CREATE TYPE "SourceType" AS ENUM (
  'OFFICIAL_PAST',    -- 歷屆試題：著作權法第 9 條，不受保護
  'TEACHER_ORIGINAL',
  'SCHOOL_EXAM',
  'PUBLISHER_SCAN',
  'AI_GENERATED'
);

CREATE TYPE "LicenseScope" AS ENUM (
  'PUBLIC',           -- 可自由散布（僅 OFFICIAL_PAST）
  'TENANT_EXPORTABLE',
  'TENANT_NO_EXPORT', -- PUBLISHER_SCAN 強制為此
  'INTERNAL_USE_ONLY'
);

CREATE TYPE "BloomLevel" AS ENUM ('REMEMBER','UNDERSTAND','APPLY','ANALYZE','EVALUATE','CREATE');
CREATE TYPE "BloomLevelLegacy" AS ENUM ('KNOWLEDGE','COMPREHENSION','APPLICATION','ANALYSIS','SYNTHESIS','EVALUATION');

CREATE TYPE "ImportStatus" AS ENUM (
  'QUEUED','NORMALIZING','SEGMENTING','EXTRACTING','SOLVING',
  'ANNOTATING','DEDUPING','READY_FOR_REVIEW','COMMITTING','COMMITTED','FAILED'
);

CREATE TYPE "ImportFileRole" AS ENUM ('QUESTION_BOOK','ANSWER_KEY','EXPLANATION_BOOK','RUBRIC','UNKNOWN');

CREATE TYPE "CandidateState" AS ENUM ('PENDING','CONFIRMED','FLAGGED','DISCARDED');

CREATE TYPE "TextbookNodeType" AS ENUM ('VOLUME','THEME','CHAPTER','SECTION','LESSON');

-- ═══════════════════════════════════════════════════════════════
-- 科目與課綱
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE "subjects" (
  "id"        TEXT PRIMARY KEY,
  "tenantId"  TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "code"      TEXT NOT NULL,              -- 'MATH_A' 'CHINESE' 'ENGLISH' 'SCIENCE' 'SOCIAL'
  "name"      TEXT NOT NULL,
  "gsatFullScore" INTEGER,                -- 學測滿分：社會 144、自然 128、其餘 100
  "order"     INTEGER NOT NULL DEFAULT 0,
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "subjects_tenantId_code_key" ON "subjects"("tenantId","code");

CREATE TABLE "curriculum_nodes" (
  "id"        TEXT PRIMARY KEY,
  "tenantId"  TEXT NOT NULL,
  "subjectId" TEXT NOT NULL REFERENCES "subjects"("id") ON DELETE CASCADE,
  "parentId"  TEXT REFERENCES "curriculum_nodes"("id") ON DELETE SET NULL,
  "code"      TEXT NOT NULL,              -- 108 課綱官方編碼，如 'S-10-1'
  "title"     TEXT NOT NULL,
  "version"   TEXT NOT NULL DEFAULT '108',
  "order"     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "curriculum_nodes_subjectId_code_version_key"
  ON "curriculum_nodes"("subjectId","code","version");
CREATE INDEX "curriculum_nodes_parentId_order_idx" ON "curriculum_nodes"("parentId","order");

CREATE TABLE "knowledge_points" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "subjectId"   TEXT NOT NULL REFERENCES "subjects"("id") ON DELETE CASCADE,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  -- 遺忘衰減率。程序性知識（計算技巧）衰減快，概念性較慢。
  "decayRate"   DOUBLE PRECISION NOT NULL DEFAULT 0.05,
  "gsatWeight"  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  -- 供候選檢索。維度依 EMBEDDING_DIM，預設 bge-m3 的 1024。
  "embedding"   vector(1024),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "knowledge_points_subjectId_name_key" ON "knowledge_points"("subjectId","name");
CREATE INDEX "knowledge_points_tenantId_subjectId_idx" ON "knowledge_points"("tenantId","subjectId");

-- 知識點 ↔ 課綱節點，多對多
CREATE TABLE "kp_curriculum_links" (
  "knowledgePointId" TEXT NOT NULL REFERENCES "knowledge_points"("id") ON DELETE CASCADE,
  "curriculumNodeId" TEXT NOT NULL REFERENCES "curriculum_nodes"("id") ON DELETE CASCADE,
  PRIMARY KEY ("knowledgePointId","curriculumNodeId")
);

-- 前置關係 DAG。供智慧老師回溯與能力診斷。
CREATE TABLE "kp_prerequisites" (
  "kpId"        TEXT NOT NULL REFERENCES "knowledge_points"("id") ON DELETE CASCADE,
  "prereqKpId"  TEXT NOT NULL REFERENCES "knowledge_points"("id") ON DELETE CASCADE,
  "strength"    DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "verifiedBy"  TEXT,
  PRIMARY KEY ("kpId","prereqKpId"),
  CONSTRAINT "kp_prereq_no_self" CHECK ("kpId" <> "prereqKpId")
);

-- ═══════════════════════════════════════════════════════════════
-- 教科書索引（訪談第 5 題：目前只有一所高中，建檔成本低）
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE "publishers" (
  "id"     TEXT PRIMARY KEY,
  "name"   TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE "textbook_editions" (
  "id"                TEXT PRIMARY KEY,
  "tenantId"          TEXT NOT NULL,
  "publisherId"       TEXT NOT NULL REFERENCES "publishers"("id") ON DELETE RESTRICT,
  "subjectId"         TEXT NOT NULL REFERENCES "subjects"("id") ON DELETE CASCADE,
  "curriculumVersion" TEXT NOT NULL DEFAULT '108',
  "adoptedYears"      INTEGER[] NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX "textbook_editions_key"
  ON "textbook_editions"("tenantId","publisherId","subjectId","curriculumVersion");

CREATE TABLE "textbook_nodes" (
  "id"        TEXT PRIMARY KEY,
  "editionId" TEXT NOT NULL REFERENCES "textbook_editions"("id") ON DELETE CASCADE,
  "parentId"  TEXT REFERENCES "textbook_nodes"("id") ON DELETE CASCADE,
  "type"      "TextbookNodeType" NOT NULL,
  "label"     TEXT NOT NULL,
  "order"     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "textbook_nodes_editionId_parentId_order_idx"
  ON "textbook_nodes"("editionId","parentId","order");

CREATE TABLE "textbook_curriculum_links" (
  "textbookNodeId"   TEXT NOT NULL REFERENCES "textbook_nodes"("id") ON DELETE CASCADE,
  "curriculumNodeId" TEXT NOT NULL REFERENCES "curriculum_nodes"("id") ON DELETE CASCADE,
  "coverage"         DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  PRIMARY KEY ("textbookNodeId","curriculumNodeId")
);

-- ═══════════════════════════════════════════════════════════════
-- 題組與題目
-- ═══════════════════════════════════════════════════════════════

-- 題組：共用前導敘述。學測的混合題全部是這個結構。
CREATE TABLE "question_groups" (
  "id"        TEXT PRIMARY KEY,
  "tenantId"  TEXT NOT NULL,
  "subjectId" TEXT NOT NULL REFERENCES "subjects"("id") ON DELETE CASCADE,
  "stimulus"  TEXT NOT NULL,              -- 前導敘述／閱讀素材
  "stimulusAssets" JSONB,                 -- 素材中的圖表
  "label"     TEXT,                       -- 「37-39 題為題組」
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "question_groups_tenantId_subjectId_idx" ON "question_groups"("tenantId","subjectId");

CREATE TABLE "questions" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "subjectId"   TEXT NOT NULL REFERENCES "subjects"("id") ON DELETE RESTRICT,

  -- 版本控制：familyId 跨版本穩定，id 是版本列的主鍵。
  -- 作答記錄指向 id，因此天然版本化，不需要另存版本號。
  "familyId"    TEXT NOT NULL,
  "version"     INTEGER NOT NULL DEFAULT 1,
  "inheritStats" BOOLEAN NOT NULL DEFAULT true,

  "groupId"     TEXT REFERENCES "question_groups"("id") ON DELETE SET NULL,
  "subLabel"    TEXT,                     -- 混合題子題：「（a）」「（b）」，全形

  "type"        "QuestionType" NOT NULL,
  "content"     TEXT NOT NULL,            -- 題幹，內含 $LaTeX$
  "contentAssets" JSONB,                  -- 圖片引用與替代文字

  "score"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- 多選題的部分給分規則：(n-2k)/n。存規則而非寫死，因為各科不同。
  "scoringRule" JSONB,

  -- 選擇題正解（可多個，對應多選題）。存的是 option.order。
  "answerKeys"  INTEGER[] NOT NULL DEFAULT '{}',
  -- 選填題：答案卡上的格位與應填內容，如 [{"slot":"⑬","value":"1"},{"slot":"⑭","value":"5"}]
  "answerSlots" JSONB,
  -- 非選題的參考答案（文字）
  "answerText"  TEXT,

  "difficulty"       DOUBLE PRECISION,    -- 0–1，AI 預估或 IRT 實測
  "irtDifficulty"    DOUBLE PRECISION,
  "irtDiscrimination" DOUBLE PRECISION,
  "irtGuessing"      DOUBLE PRECISION,
  "responseCount"    INTEGER NOT NULL DEFAULT 0,
  "correctRate"      DOUBLE PRECISION,

  "bloomLevel"       "BloomLevel",
  "bloomLevelLegacy" "BloomLevelLegacy",
  "estTimeSeconds"   INTEGER,

  "sourceType"   "SourceType" NOT NULL,
  "sourceRef"    TEXT,                    -- 「115學測數學A第12題」
  "licenseScope" "LicenseScope" NOT NULL,
  "sourceImportJobId" TEXT,

  "status"       "QuestionStatus" NOT NULL DEFAULT 'DRAFT',
  "qualityFlags" JSONB,
  "embedding"    vector(1024),            -- 去重與相似題檢索

  "createdBy"  TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  "retiredAt"  TIMESTAMP(3)
);
CREATE UNIQUE INDEX "questions_familyId_version_key" ON "questions"("familyId","version");
CREATE INDEX "questions_tenantId_subjectId_status_idx" ON "questions"("tenantId","subjectId","status");
CREATE INDEX "questions_groupId_idx" ON "questions"("groupId");
CREATE INDEX "questions_sourceType_idx" ON "questions"("sourceType");
-- 題幹的模糊搜尋（老師用關鍵字找題目，不是用知識點）
CREATE INDEX "questions_content_trgm_idx" ON "questions" USING gin ("content" gin_trgm_ops);

-- 授權範圍必須與來源相符。這是資料庫層的強制，不只靠應用層。
-- PUBLISHER_SCAN 一律不可匯出；只有歷屆試題可以 PUBLIC。
ALTER TABLE "questions" ADD CONSTRAINT "questions_license_matches_source" CHECK (
  ("sourceType" = 'PUBLISHER_SCAN' AND "licenseScope" IN ('TENANT_NO_EXPORT','INTERNAL_USE_ONLY'))
  OR ("sourceType" <> 'PUBLISHER_SCAN' AND ("licenseScope" <> 'PUBLIC' OR "sourceType" = 'OFFICIAL_PAST'))
);

-- 選項獨立成表而非 JSON 陣列：選項數不固定（數學 5、英文 4），
-- 且需要逐選項統計（哪個誘答項最多人選）。
CREATE TABLE "question_options" (
  "id"         TEXT PRIMARY KEY,
  "questionId" TEXT NOT NULL REFERENCES "questions"("id") ON DELETE CASCADE,
  "order"      INTEGER NOT NULL,          -- 1..n，對應 (1)(2)(3)(4)(5)
  "label"      TEXT NOT NULL,             -- 顯示用，通常等於 order
  "content"    TEXT NOT NULL,
  "assets"     JSONB,
  "selectCount" INTEGER NOT NULL DEFAULT 0,
  UNIQUE ("questionId","order")
);

CREATE TABLE "question_knowledge_points" (
  "questionId"       TEXT NOT NULL REFERENCES "questions"("id") ON DELETE CASCADE,
  "knowledgePointId" TEXT NOT NULL REFERENCES "knowledge_points"("id") ON DELETE CASCADE,
  "weight"           DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "confirmedBy"      TEXT,
  PRIMARY KEY ("questionId","knowledgePointId"),
  CONSTRAINT "qkp_weight_range" CHECK ("weight" > 0 AND "weight" <= 1)
);

CREATE TABLE "question_textbook_links" (
  "questionId"     TEXT NOT NULL REFERENCES "questions"("id") ON DELETE CASCADE,
  "textbookNodeId" TEXT NOT NULL REFERENCES "textbook_nodes"("id") ON DELETE CASCADE,
  PRIMARY KEY ("questionId","textbookNodeId")
);

-- ═══════════════════════════════════════════════════════════════
-- 評分量表（非選題沒有答案，只有等第）
--
-- 結構直接對應大考中心的評分原則：
--   國寫  → 單一維度、多個等第（A+ 25–22、A 21–18…）
--   英作文 → 四個維度各 5 分（內容／組織／文法句構／字彙拼字）
--   中譯英 → 扣分制（每錯 0.5，相同錯誤只扣一次）
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE "rubrics" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "questionId"  TEXT REFERENCES "questions"("id") ON DELETE CASCADE,
  "name"        TEXT NOT NULL,
  "totalScore"  DOUBLE PRECISION NOT NULL,
  -- BAND 等第制／DIMENSION 分維度／DEDUCTION 扣分制
  "mode"        TEXT NOT NULL DEFAULT 'BAND',
  -- 評分原則的描述文字受著作權保護（見文件 16 §3）。
  -- 內部閱卷可呈現，但不得散布或匯出給學生。
  "sourceRef"   TEXT,
  "internalOnly" BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rubrics_mode_valid" CHECK ("mode" IN ('BAND','DIMENSION','DEDUCTION'))
);

CREATE TABLE "rubric_dimensions" (
  "id"        TEXT PRIMARY KEY,
  "rubricId"  TEXT NOT NULL REFERENCES "rubrics"("id") ON DELETE CASCADE,
  "name"      TEXT NOT NULL,              -- 「內容」「組織」
  "nameEn"    TEXT,
  "maxScore"  DOUBLE PRECISION NOT NULL,
  "descriptor" TEXT,
  "order"     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "rubric_bands" (
  "id"          TEXT PRIMARY KEY,
  "rubricId"    TEXT NOT NULL REFERENCES "rubrics"("id") ON DELETE CASCADE,
  "dimensionId" TEXT REFERENCES "rubric_dimensions"("id") ON DELETE CASCADE,
  "grade"       TEXT NOT NULL,            -- 'A+' 'A' 'B+' … '0'
  "scoreMax"    DOUBLE PRECISION NOT NULL,
  "scoreMin"    DOUBLE PRECISION NOT NULL,
  "descriptor"  TEXT NOT NULL,
  "order"       INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "rubric_bands_range" CHECK ("scoreMin" <= "scoreMax")
);
CREATE INDEX "rubric_bands_rubricId_order_idx" ON "rubric_bands"("rubricId","order");

-- ═══════════════════════════════════════════════════════════════
-- 匯入管線
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE "import_jobs" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "subjectId"   TEXT NOT NULL REFERENCES "subjects"("id") ON DELETE RESTRICT,
  "title"       TEXT NOT NULL,
  "status"      "ImportStatus" NOT NULL DEFAULT 'QUEUED',
  "sourceType"  "SourceType" NOT NULL,
  "licenseScope" "LicenseScope" NOT NULL,
  -- 權利聲明：誰聲明的、聲明了什麼。責任歸屬明確。
  "rightsDeclaredBy" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "rightsBasis" TEXT,
  "rightsNote"  TEXT,

  "totalPages"  INTEGER,
  "totalCandidates" INTEGER NOT NULL DEFAULT 0,
  "confirmedCount"  INTEGER NOT NULL DEFAULT 0,
  "flaggedCount"    INTEGER NOT NULL DEFAULT 0,

  -- 校對節奏。驗收標準是 50 題 20 分鐘。
  "reviewStartedAt" TIMESTAMP(3),
  "reviewSeconds"   INTEGER NOT NULL DEFAULT 0,

  "error"       TEXT,
  "stageDetail" JSONB,
  "createdBy"   TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "committedAt" TIMESTAMP(3)
);
CREATE INDEX "import_jobs_tenantId_status_idx" ON "import_jobs"("tenantId","status");
CREATE INDEX "import_jobs_createdAt_idx" ON "import_jobs"("createdAt");

CREATE TABLE "import_files" (
  "id"         TEXT PRIMARY KEY,
  "jobId"      TEXT NOT NULL REFERENCES "import_jobs"("id") ON DELETE CASCADE,
  "role"       "ImportFileRole" NOT NULL DEFAULT 'UNKNOWN',
  "fileName"   TEXT NOT NULL,
  "mimeType"   TEXT NOT NULL,
  "sizeBytes"  BIGINT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "pageCount"  INTEGER,
  -- 掃描件與照片的品質評估，決定要提示老師逐題確認的程度
  "qualityScore" DOUBLE PRECISION,
  "qualityNote"  TEXT,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "import_files_jobId_idx" ON "import_files"("jobId");

-- 匯入候選題：校對介面操作的對象。確認後才寫入 questions。
CREATE TABLE "import_candidates" (
  "id"          TEXT PRIMARY KEY,
  "jobId"       TEXT NOT NULL REFERENCES "import_jobs"("id") ON DELETE CASCADE,
  "order"       INTEGER NOT NULL,
  "questionNo"  TEXT,                     -- 原稿上的題號，可能是「37-39」
  "subLabel"    TEXT,
  "groupKey"    TEXT,                     -- 同一題組的候選共用此鍵

  "type"        "QuestionType",
  "content"     TEXT,
  "stimulus"    TEXT,
  "options"     JSONB,                    -- [{order,label,content}]
  "answerKeys"  INTEGER[] NOT NULL DEFAULT '{}',
  "answerSlots" JSONB,
  "answerText"  TEXT,
  "score"       DOUBLE PRECISION,

  -- 信心與扣分理由。校對者靠這個決定「要不要細看」，
  -- 是 20 分鐘校完 50 題的關鍵。
  "confidence"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  "confidenceReasons" JSONB NOT NULL DEFAULT '[]',

  -- 答案來源：題本附的、獨立答案卷對齊的、或 AI 自答
  "answerOrigin" TEXT,
  "selfConsistency" DOUBLE PRECISION,     -- 自答一致率
  "solveTrace"  JSONB,                    -- 各次推導，低一致率時給老師看

  "kpSuggestions" JSONB,                  -- [{id,name,weight}]
  "sourceBbox"  JSONB,                    -- 原稿座標，供左右連動
  "sourcePage"  INTEGER,

  "state"       "CandidateState" NOT NULL DEFAULT 'PENDING',
  "reviewedBy"  TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewedAt"  TIMESTAMP(3),
  "reviewNote"  TEXT,
  "questionId"  TEXT REFERENCES "questions"("id") ON DELETE SET NULL,

  "duplicateOfId" TEXT REFERENCES "questions"("id") ON DELETE SET NULL,
  "duplicateScore" DOUBLE PRECISION,

  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  UNIQUE ("jobId","order")
);
CREATE INDEX "import_candidates_jobId_state_idx" ON "import_candidates"("jobId","state");
CREATE INDEX "import_candidates_jobId_confidence_idx" ON "import_candidates"("jobId","confidence");

-- ═══════════════════════════════════════════════════════════════
-- 解析
-- ═══════════════════════════════════════════════════════════════

CREATE TYPE "ExplanationOrigin" AS ENUM ('AI_GENERATED','TEACHER_WRITTEN','OFFICIAL_CEEC','AI_REWRITTEN','VERBATIM_IMPORT');
CREATE TYPE "RightsBasis" AS ENUM ('OWNED','LICENSED','OFFICIAL_PUBLIC','UNVERIFIED');
CREATE TYPE "ExplanationDisplay" AS ENUM ('FULL','SUMMARY_ONLY','HIDDEN');

CREATE TABLE "explanations" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "questionId"  TEXT NOT NULL REFERENCES "questions"("id") ON DELETE CASCADE,
  "origin"      "ExplanationOrigin" NOT NULL,
  "rightsBasis" "RightsBasis" NOT NULL,
  "licenseScope" "LicenseScope" NOT NULL,
  "displayMode" "ExplanationDisplay" NOT NULL DEFAULT 'FULL',
  "isPrimary"   BOOLEAN NOT NULL DEFAULT false,

  -- 分層結構：結論、步驟、誘答項剖析、延伸
  "layers"      JSONB NOT NULL DEFAULT '{}',
  -- 匯入的原文。不直接呈現給學生，僅作為 AI 改寫的依據。
  "rawBody"     TEXT,
  "groundedOnId" TEXT REFERENCES "explanations"("id") ON DELETE SET NULL,

  "sourceRef"   TEXT,
  "declaredBy"  TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "modelUsed"   TEXT,
  "promptVersion" TEXT,
  "takedownAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);
CREATE INDEX "explanations_questionId_idx" ON "explanations"("questionId");
-- 每題最多一份主要解析
CREATE UNIQUE INDEX "explanations_primary_per_question"
  ON "explanations"("questionId") WHERE "isPrimary" = true;

-- 權利基礎為 UNVERIFIED 者，強制走 AI 改寫，不得原文呈現。
-- 這是資料庫層的強制，不只靠應用層過濾。
ALTER TABLE "explanations" ADD CONSTRAINT "explanations_unverified_must_rewrite" CHECK (
  "rightsBasis" <> 'UNVERIFIED' OR "origin" IN ('AI_REWRITTEN','AI_GENERATED')
);

-- ═══════════════════════════════════════════════════════════════
-- 去重
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE "duplicate_groups" (
  "id"         TEXT PRIMARY KEY,
  "tenantId"   TEXT NOT NULL,
  "subjectId"  TEXT NOT NULL,
  "resolvedBy" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "resolvedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "duplicate_members" (
  "groupId"    TEXT NOT NULL REFERENCES "duplicate_groups"("id") ON DELETE CASCADE,
  "questionId" TEXT NOT NULL REFERENCES "questions"("id") ON DELETE CASCADE,
  "similarity" DOUBLE PRECISION NOT NULL,
  "isKeeper"   BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY ("groupId","questionId")
);

-- ═══════════════════════════════════════════════════════════════
-- 班級職權的擴充
--
-- 訪談第 14 題：「派：科目或班級老師／催：班級老師／改：科目或班級老師」
-- 且「有時候班級老師就是那一科的老師」。
-- 原本的 ClassRole 只有單一 TEACHER，分不出這兩種職權。
-- ═══════════════════════════════════════════════════════════════

-- 科目老師：這個人教這個班的這一科
CREATE TABLE "class_subject_teachers" (
  "id"        TEXT PRIMARY KEY,
  "classId"   TEXT NOT NULL REFERENCES "classes"("id") ON DELETE CASCADE,
  "subjectId" TEXT NOT NULL REFERENCES "subjects"("id") ON DELETE CASCADE,
  "userId"    TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- 主授或協同。一科三位老師（訪談第 1 題）需要區分。
  "isPrimary" BOOLEAN NOT NULL DEFAULT true,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("classId","subjectId","userId")
);
CREATE INDEX "class_subject_teachers_userId_idx" ON "class_subject_teachers"("userId");

-- 班級老師（導師）：負責催繳與整體班務，跨科目
ALTER TABLE "class_memberships" ADD COLUMN "isHomeroom" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "class_memberships_homeroom_idx"
  ON "class_memberships"("classId") WHERE "isHomeroom" = true;

-- ═══════════════════════════════════════════════════════════════
-- 官方資料的年度取得記錄（文件 16）
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE "official_source_fetches" (
  "id"         TEXT PRIMARY KEY,
  "sourceUrl"  TEXT NOT NULL,
  "docType"    TEXT NOT NULL,             -- 'PAPER' 'ANSWER_KEY' 'RUBRIC'
  "academicYear" INTEGER NOT NULL,
  "subjectCode"  TEXT,
  "sha256"     TEXT NOT NULL,
  "fetchedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 驗證結果。順序見文件 16 §4：
  -- 機械不變量 → 跨文件交叉 → 跨年度比對 → 獨立重抽比對 → 人工
  "checksPassed" JSONB NOT NULL DEFAULT '[]',
  "checksFailed" JSONB NOT NULL DEFAULT '[]',
  "verifiedBy" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "verifiedAt" TIMESTAMP(3),
  UNIQUE ("sourceUrl","sha256")
);
