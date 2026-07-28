-- 出版社專屬題型，以及分科的自然與社會
--
-- 兩件事，都是「老師實際上怎麼用」推出來的。

-- ═══════════════════════════════════════════════════════════════
-- 一、出版社專屬題型
--
-- 出版社常有自己設計的題型：翰林的「觀念速記」、南一的「圖表解碼」。
-- 它們呈現方式獨特，但**作答方式幾乎一定是標準的那幾種之一**——
-- 這一點讓它變得可處理：系統不必懂那個題型的教學設計，只要知道
-- 學生怎麼答、怎麼給分。
--
-- 流程是「問老師一次，之後記住」。授權記在題型上而不是只記在
-- 匯入工作上：題型會被反覆使用，「有沒有權利用」是題型層級的事實。
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE "custom_question_types" (
  "id"              TEXT PRIMARY KEY,
  "tenantId"        TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "publisherId"     TEXT REFERENCES "publishers"("id") ON DELETE SET NULL,
  -- 出版社名稱快照。出版社資料被整理過時，題型的來源仍然查得到。
  "publisherName"   TEXT,

  "name"            TEXT NOT NULL,
  "description"     TEXT NOT NULL,
  -- 學生實際上怎麼作答。決定作答介面與評分邏輯。
  "answerMode"      "QuestionType" NOT NULL,
  -- 給模型看的辨識線索，會被放進提示詞。寫得越具體，下次認得越準。
  "recognitionHint" TEXT,
  "exampleAssetKey" TEXT,

  -- 授權基礎。與 import_jobs 用同一組值。
  "rightsBasis"     TEXT NOT NULL,
  "rightsNote"      TEXT,
  "confirmedBy"     TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "confirmedName"   TEXT,
  "confirmedAt"     TIMESTAMP(3),

  "active"          BOOLEAN NOT NULL DEFAULT true,
  "usageCount"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL
);

-- 同一租戶下同一個出版社的題型名稱不重複。沒有這個約束的話，
-- 每一次匯入都會建一個新的「觀念速記」，篩選就失效了。
CREATE UNIQUE INDEX "custom_question_types_tenant_publisher_name_key"
  ON "custom_question_types" ("tenantId", "publisherName", "name");
CREATE INDEX "custom_question_types_tenantId_active_idx"
  ON "custom_question_types" ("tenantId", "active");
CREATE INDEX "custom_question_types_publisherId_idx"
  ON "custom_question_types" ("publisherId");
CREATE INDEX "custom_question_types_confirmedBy_idx"
  ON "custom_question_types" ("confirmedBy");

ALTER TABLE "custom_question_types"
  ADD CONSTRAINT "custom_question_types_rights_basis_valid" CHECK (
    "rightsBasis" IN ('OWNED','LICENSED','OFFICIAL_PUBLIC','UNVERIFIED')
  ) NOT VALID;
ALTER TABLE "custom_question_types"
  VALIDATE CONSTRAINT "custom_question_types_rights_basis_valid";

-- **確認過的題型必須說得出是誰確認的。** 「向老師確認即可」的
-- 那個確認就是責任歸屬——半年後題目出問題時要找得到人。
ALTER TABLE "custom_question_types"
  ADD CONSTRAINT "custom_question_types_confirmed_by_someone" CHECK (
    "confirmedAt" IS NULL
    OR "confirmedBy" IS NOT NULL
    OR "confirmedName" IS NOT NULL
  ) NOT VALID;
ALTER TABLE "custom_question_types"
  VALIDATE CONSTRAINT "custom_question_types_confirmed_by_someone";

ALTER TABLE "import_candidates"
  ADD COLUMN "customTypeId"   TEXT,
  ADD COLUMN "customTypeName" TEXT;

-- ═══════════════════════════════════════════════════════════════
-- 二、分科的自然與社會
--
-- 學測的「自然」與「社會」是合科考卷，但**補習班是分科教的**：
-- 化學老師傳的是化學講義、地理老師傳的是地理講義。訪談時說的
-- 「每科三位老師、七個班」指的就是分科。
--
-- 只有合科代碼的話，化學老師的題目會跟生物的混在同一個題庫裡，
-- 而他要組一份化學小考時篩不出來。
--
-- subjects 表本來就以 code 為自由字串，這裡加的是「分科屬於哪個
-- 合科」的對應，讓組學測模擬卷時能把分科的題目湊起來。
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE "subjects"
  ADD COLUMN "parentCode" TEXT;

COMMENT ON COLUMN "subjects"."parentCode" IS
  '分科所屬的學測合科代碼（CHEMISTRY → SCIENCE）。合科本身留空。';

CREATE INDEX "subjects_parent_code_idx" ON "subjects" ("tenantId", "parentCode");
