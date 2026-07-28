-- 雲端智學 — 示範資料（115 學年度學科能力測驗）
--
-- 用途：安裝後立刻有東西可以看，不必先匯入一份題本。
-- 執行：psql -d yunzhi -f packages/db/seed/demo-115.sql
--
-- 內容取自大考中心公布之 115 學測試題。依著作權法第 9 條，
-- 依法令舉行之各類考試試題不受著作權保護，可自由使用。
-- 評分原則的分數區間為事實，描述文字標記為僅供內部呈現（見文件 16 §3）。
--
-- 刻意涵蓋四種最難處理的結構，讓校對介面一開始就被真實情況考驗：
--   · 五選項單選（1）（2）（3）（4）（5）
--   · 多選題（部分給分）
--   · 選填題（答案卡格位 ⑬⑭）
--   · 題組（共用前導敘述，子題用全形（a））

BEGIN;

-- ── 租戶脈絡 ────────────────────────────────────────────────
--
-- **這一行不是選配。** 20260736000000_tenant_isolation_rls 之後，
-- 每一張表都 ENABLE ＋ FORCE row level security，政策比對的是
-- `current_setting('app.tenant_id', true)`。psql 直接連進來時那個值
-- 是 NULL，於是：
--
--   INSERT  → 撞 WITH CHECK，整個交易 abort，後面每一句都是
--             「current transaction is aborted」，COMMIT 變 ROLLBACK
--   UPDATE  → 比對不到任何一列，**0 rows 而且不報錯**
--             （檔案最後那句 confirmedCount 就是這一種）
--
-- 兩種結果都是「跑完了，資料庫裡什麼都沒有」，而第二種連錯誤訊息
-- 都沒有。設成本檔要寫入的那個租戶而不是開跨租戶模式：種子資料
-- 本來就只屬於 demo-tenant，不需要繞過隔離，只需要說明自己是誰。
--
-- SET LOCAL 只在這個交易內有效，不會留在連線上影響下一個人。
SET LOCAL app.tenant_id = 'demo-tenant';

-- ── 租戶與科目 ──────────────────────────────────────────────
INSERT INTO tenants (id, name, "updatedAt")
VALUES ('demo-tenant', '雲端智學', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO subjects (id, "tenantId", code, name, "parentCode", "gsatFullScore", "order") VALUES
  ('subj-math-a', 'demo-tenant', 'MATH_A',  '數學A', NULL, 100, 1),
  ('subj-math-b', 'demo-tenant', 'MATH_B',  '數學B', NULL, 100, 2),
  ('subj-chinese','demo-tenant', 'CHINESE', '國文',  NULL, 100, 3),
  ('subj-english','demo-tenant', 'ENGLISH', '英文',  NULL, 100, 4),
  -- 自然與社會的滿分不是 100，級分換算會用到（規格書文件 03 §6.4）
  ('subj-science','demo-tenant', 'SCIENCE', '自然',  NULL, 128, 5),
  ('subj-social', 'demo-tenant', 'SOCIAL',  '社會',  NULL, 144, 6),

  -- ── 分科 ──────────────────────────────────────────────────
  --
  -- 學測考的是合科的「自然」與「社會」，但補習班是分科教的：
  -- 物理老師傳的是物理講義、地理老師傳的是地理講義。訪談時說的
  -- 「每科三位老師、七個班」指的就是這一層。
  --
  -- 少了這幾列，物理老師上傳講義時**選不到自己的科目**——他只能
  -- 選「自然」，然後他的題目跟化學、生物的混在同一個題庫裡，
  -- 要組一份物理小考時篩不出來。
  --
  -- 分科沒有自己的學測滿分（它們不是獨立考科），級分換算一律看
  -- parentCode 指到的合科。
  ('subj-physics',  'demo-tenant', 'PHYSICS',       '物理', 'SCIENCE', NULL, 51),
  ('subj-chemistry','demo-tenant', 'CHEMISTRY',     '化學', 'SCIENCE', NULL, 52),
  ('subj-biology',  'demo-tenant', 'BIOLOGY',       '生物', 'SCIENCE', NULL, 53),
  ('subj-earth',    'demo-tenant', 'EARTH_SCIENCE', '地球科學', 'SCIENCE', NULL, 54),
  ('subj-history',  'demo-tenant', 'HISTORY',       '歷史', 'SOCIAL',  NULL, 61),
  ('subj-geography','demo-tenant', 'GEOGRAPHY',     '地理', 'SOCIAL',  NULL, 62),
  ('subj-civics',   'demo-tenant', 'CIVICS',        '公民', 'SOCIAL',  NULL, 63)
ON CONFLICT DO NOTHING;

-- ── 知識點 ──────────────────────────────────────────────────
INSERT INTO knowledge_points (id, "tenantId", "subjectId", name, "decayRate", "updatedAt") VALUES
  ('kp-expect',   'demo-tenant', 'subj-math-a', '期望值',       0.05, now()),
  ('kp-indep',    'demo-tenant', 'subj-math-a', '獨立事件',     0.04, now()),
  ('kp-linprog',  'demo-tenant', 'subj-math-a', '線性規劃',     0.07, now()),
  ('kp-ineq',     'demo-tenant', 'subj-math-a', '不等式區域',   0.06, now()),
  ('kp-arith',    'demo-tenant', 'subj-math-a', '等差級數',     0.06, now()),
  ('kp-log',      'demo-tenant', 'subj-math-a', '對數運算',     0.08, now()),
  ('kp-sexdet',   'demo-tenant', 'subj-science','性別決定',     0.05, now()),
  ('kp-generegu', 'demo-tenant', 'subj-science','基因表現調控', 0.06, now())
ON CONFLICT DO NOTHING;

-- 前置關係：等差級數要先會不等式，才解得了「使 Sn>500 的最小 n」
INSERT INTO kp_prerequisites ("kpId", "prereqKpId", strength) VALUES
  ('kp-arith', 'kp-ineq', 0.6),
  ('kp-linprog', 'kp-ineq', 0.9)
ON CONFLICT DO NOTHING;

-- ── 匯入工作（待校對狀態）────────────────────────────────────
-- 這一段撞過兩個約束，兩個都值得記下來：
--
--   · `rightsBasis` 原本寫的是一整句「著作權法第 9 條：…」，但那一欄
--     受 `import_jobs_rights_basis_valid` 約束，只收
--     OWNED / LICENSED / OFFICIAL_PUBLIC / UNVERIFIED 四個值。
--     法條的說明屬於 `rightsNote`，不是權利基礎本身。
--   · `rightsDeclaredBy` 被 `import_jobs_rights_declared` 要求非空。
--     「誰聲明的」是責任歸屬，沒有它這筆匯入在法遵上說不出話。
--
-- 兩個都是 ERROR 不是警告，而整份種子是一個交易，所以任何一個撞上
-- 就是**整份 ROLLBACK、一列都沒進去**。
INSERT INTO users (id, "tenantId", username, "displayName", "systemRole", status, "updatedAt")
VALUES ('user-demo-admin', 'demo-tenant', 'admin', '示範管理員', 'SCHOOL_ADMIN', 'ACTIVE', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO import_jobs (
  id, "tenantId", "subjectId", title, status, "sourceType", "licenseScope",
  "rightsBasis", "rightsNote", "rightsDeclaredBy", "rightsDeclaredName",
  "totalPages", "totalCandidates", "updatedAt"
) VALUES (
  'job-demo-115', 'demo-tenant', 'subj-math-a',
  '115 學年度學科能力測驗　數學A考科', 'READY_FOR_REVIEW',
  'OFFICIAL_PAST', 'PUBLIC',
  'OFFICIAL_PUBLIC',
  '著作權法第 9 條：依法令舉行之各類考試試題不受著作權保護',
  'user-demo-admin', '示範管理員',
  12, 5, now()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO import_files (id, "jobId", role, "fileName", "mimeType", "sizeBytes", "storageKey", "pageCount", "qualityScore")
VALUES ('file-demo-115', 'job-demo-115', 'QUESTION_BOOK',
        '03-115學測數學A試卷.pdf', 'application/pdf', 1482301,
        'imports/job-demo-115/paper.pdf', 12, 1.0)
ON CONFLICT (id) DO NOTHING;

-- ── 候選題 ──────────────────────────────────────────────────

-- 1．單選題，五個選項。高信心，校對時應該一鍵通過。
INSERT INTO import_candidates (
  id, "jobId", "order", "questionNo", type, content, options, "answerKeys",
  score, confidence, "confidenceReasons", "answerOrigin", "selfConsistency",
  "kpSuggestions", "sourcePage", state, "updatedAt"
) VALUES (
  'cand-1', 'job-demo-115', 1, '1', 'SINGLE_CHOICE',
  '某財神廟舉辦抽籤活動，參加者抽兩次籤，各次出現「吉」、「祥」的機率均為 $\tfrac{1}{3}$。若兩次都抽到「吉」可獲得獎金 180 元，兩次都抽到「祥」可獲得獎金 90 元，其餘情形沒有獎金。試問參加者可獲得獎金的期望值為何？',
  '[{"order":1,"label":"1","content":"20 元"},
    {"order":2,"label":"2","content":"30 元"},
    {"order":3,"label":"3","content":"45 元"},
    {"order":4,"label":"4","content":"60 元"},
    {"order":5,"label":"5","content":"90 元"}]'::jsonb,
  '{4}', 5, 0.96, '[]'::jsonb, 'AI_SOLVED', 1.0,
  '[{"id":"kp-expect","name":"期望值","weight":0.8,"evidence":"題幹要求計算獎金的期望值"},
    {"id":"kp-indep","name":"獨立事件","weight":0.2,"evidence":"兩次抽籤互相獨立"}]'::jsonb,
  2, 'PENDING', now()
) ON CONFLICT (id) DO NOTHING;

-- 7．多選題。低信心，且自答未完全一致 —— 這一題是校對介面要證明
--    自己有用的地方：老師應該只看側註指出的第 (3) 項。
INSERT INTO import_candidates (
  id, "jobId", "order", "questionNo", type, content, options, "answerKeys",
  score, confidence, "confidenceReasons", "answerOrigin", "selfConsistency",
  "solveTrace", "kpSuggestions", "sourcePage", state, "updatedAt"
) VALUES (
  'cand-2', 'job-demo-115', 2, '7', 'MULTI_CHOICE',
  '坐標平面上，考慮同時滿足 $2x-3y\geq 0$ 及 $2x-y\leq 10$ 的所有點 $P(x,y)$ 所形成的區域。試問下列哪些選項中的位置，可能有此區域中的點？',
  '[{"order":1,"label":"1","content":"第一象限"},
    {"order":2,"label":"2","content":"第二象限"},
    {"order":3,"label":"3","content":"第三象限"},
    {"order":4,"label":"4","content":"第四象限"},
    {"order":5,"label":"5","content":"$x$ 軸"}]'::jsonb,
  '{1,3,4,5}', 5, 0.61,
  '[{"code":"solve_mid","severity":"warn",
     "detail":"AI 推導 5 次，一致率 80%（其中 1 次未含選項 (3)）。已填入多數答案，少數派的推導保留於下方供對照。"},
    {"code":"manual_check","severity":"warn",
     "detail":"第 (3) 項需人工確認：第三象限（x<0 且 y<0）是否確實存在同時滿足兩式的點。"}]'::jsonb,
  'AI_SOLVED', 0.8,
  '[{"approach":"direct","reasoning":"由 2x-3y≥0 得 y≤(2/3)x；由 2x-y≤10 得 y≥2x-10。取交集後檢視各象限。","answer_keys":[1,3,4,5]},
    {"approach":"verify_each","reasoning":"逐一代入各象限的代表點檢驗。","answer_keys":[1,3,4,5]},
    {"approach":"backward","reasoning":"自選項反推，第三象限取 (-1,-1) 檢驗：2(-1)-3(-1)=1≥0 成立，2(-1)-(-1)=-1≤10 成立。","answer_keys":[1,3,4,5]},
    {"approach":"estimate","reasoning":"先估區域範圍再驗證。","answer_keys":[1,3,4,5]},
    {"approach":"alternate","reasoning":"改以圖解法，但第三象限的判定在圖上不易確認。","answer_keys":[1,4,5]}]'::jsonb,
  '[{"id":"kp-linprog","name":"線性規劃","weight":0.7,"evidence":"題幹為兩個一次不等式所圍成的區域"},
    {"id":"kp-ineq","name":"不等式區域","weight":0.3,"evidence":"需判定各象限與可行區域的交集"}]'::jsonb,
  4, 'PENDING', now()
) ON CONFLICT (id) DO NOTHING;

-- 13．選填題。答案要填進答案卡上編號的格位，且題本未附答案。
INSERT INTO import_candidates (
  id, "jobId", "order", "questionNo", type, content, options, "answerKeys",
  "answerSlots", score, confidence, "confidenceReasons",
  "answerOrigin", "selfConsistency", "kpSuggestions", "sourcePage", state, "updatedAt"
) VALUES (
  'cand-3', 'job-demo-115', 3, '13', 'FILL_SLOT',
  '設等差數列 $\langle a_n\rangle$ 的首項 $a_1=3$，公差 $d=4$。若前 $n$ 項和為 $S_n$，則使 $S_n>500$ 成立的最小正整數 $n$ 為 ⑬⑭。',
  '[]'::jsonb, '{}',
  '[{"slot":"⑬","value":"1"},{"slot":"⑭","value":"5"}]'::jsonb,
  5, 0.57,
  '[{"code":"no_answer_key","severity":"info",
     "detail":"題本未附答案，以下為 AI 獨立推導 5 次的結果（一致率 100%）。"},
    {"code":"slot_count","severity":"warn",
     "detail":"格位數需人工確認：本題答案 15 為兩位數，對應答案卡 ⑬⑭ 兩格。若原稿的格位數與此不符，請修正。"}]'::jsonb,
  'AI_SOLVED', 1.0,
  '[{"id":"kp-arith","name":"等差級數","weight":0.8,"evidence":"題幹給定首項與公差，求前 n 項和"},
    {"id":"kp-ineq","name":"不等式區域","weight":0.2,"evidence":"需解 Sn>500 的不等式"}]'::jsonb,
  6, 'PENDING', now()
) ON CONFLICT (id) DO NOTHING;

-- 37-39 題組（自然科，示範跨科的題組結構）。
-- 混合題子題編號用全形（a），與一般題號體例不同。
INSERT INTO import_candidates (
  id, "jobId", "order", "questionNo", "subLabel", "groupKey", type,
  stimulus, content, options, "answerKeys", "answerText",
  score, confidence, "confidenceReasons", "kpSuggestions", "sourcePage", state, "updatedAt"
) VALUES (
  'cand-4', 'job-demo-115', 4, '37-39', '（a）', 'grp-turtle', 'SHORT_ANSWER',
  '科學家研究巴西龜（Trachemys scripta）的性別決定機制。巴西龜的性別並非由性染色體決定，而是受孵化溫度影響：在 26 ℃ 孵化多為雄性，31 ℃ 孵化多為雌性。研究顯示，溫度會影響 Kdm6b 基因的表現量，進而調控 Dmrt1 基因。',
  '因此，可推論在 26 ℃ 孵化的巴西龜受精卵，若在適當時間點對其胚胎注射抑制 Kdm6b 基因表現的藥物，則此幼龜的性別為何？',
  '[]'::jsonb, '{}', '雌性。抑制 Kdm6b 會使 Dmrt1 表現下降，而 Dmrt1 為雄性化的關鍵基因。',
  2, 0.72,
  '[{"code":"group_member","severity":"info",
     "detail":"本題為題組第 38 題的子題（a），與第 37、39 題共用前導敘述。"},
    {"code":"sublabel_fullwidth","severity":"info",
     "detail":"混合題的子題編號採全形括號（a）（b），與一般題號體例不同，已依原稿保留。"},
    {"code":"score_at_end","severity":"warn",
     "detail":"非選擇題的配分標於題末「（2 分）」，已抽取為 2 分。本部分各題配分不一，請確認。"}]'::jsonb,
  '[{"id":"kp-sexdet","name":"性別決定","weight":0.6,"evidence":"題幹主題為溫度決定性別機制"},
    {"id":"kp-generegu","name":"基因表現調控","weight":0.4,"evidence":"涉及 Kdm6b 對 Dmrt1 的調控關係"}]'::jsonb,
  9, 'PENDING', now()
) ON CONFLICT (id) DO NOTHING;

-- 一題已經校畢的，讓進度不是從零開始
INSERT INTO import_candidates (
  id, "jobId", "order", "questionNo", type, content, options, "answerKeys",
  score, confidence, "confidenceReasons", "answerOrigin", "selfConsistency",
  "kpSuggestions", "sourcePage", state, "updatedAt"
) VALUES (
  'cand-5', 'job-demo-115', 5, '2', 'SINGLE_CHOICE',
  '設 $a$ 為實數，且 $\log_{2}a+\log_{2}(a-2)=3$。試問 $a$ 之值為何？',
  '[{"order":1,"label":"1","content":"2"},{"order":2,"label":"2","content":"4"},
    {"order":3,"label":"3","content":"6"},{"order":4,"label":"4","content":"8"},
    {"order":5,"label":"5","content":"10"}]'::jsonb,
  '{2}', 5, 0.94, '[]'::jsonb, 'AI_SOLVED', 1.0,
  '[{"id":"kp-log","name":"對數運算","weight":1.0,"evidence":"題幹為對數方程式"}]'::jsonb,
  2, 'CONFIRMED', now()
) ON CONFLICT (id) DO NOTHING;

UPDATE import_jobs SET "confirmedCount" = 1 WHERE id = 'job-demo-115';

-- ── 評分量表 ────────────────────────────────────────────────
-- 結構取自 114 學測國寫閱卷評分原則與英文考科非選擇題評分原則。
-- 分數區間為事實可自由使用；描述文字受著作權保護，
-- 故 internalOnly 為 true（見文件 16 §3）。

INSERT INTO rubrics (id, "tenantId", name, "totalScore", mode, "sourceRef", "internalOnly", "updatedAt")
VALUES ('rub-guoxie-2', 'demo-tenant', '國寫　第二大題', 25, 'BAND',
        '114 學年度學科能力測驗國語文寫作能力測驗閱卷評分原則說明', true, now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO rubric_bands (id, "rubricId", grade, "scoreMax", "scoreMin", descriptor, "order") VALUES
  ('rb-1','rub-guoxie-2','A+',25,22,'具體書寫獨特的故事，結構嚴謹，文辭洗練，情感雋永',1),
  ('rb-2','rub-guoxie-2','A', 21,18,'清楚書寫獨特故事，結構完整，文辭暢達，情感深刻',2),
  ('rb-3','rub-guoxie-2','B+',17,14,'書寫獨特故事，內容平實，情感合宜，結構清楚，文辭通順',3),
  ('rb-4','rub-guoxie-2','B', 13,10,'略能書寫獨特故事，內容較欠深刻，結構尚可，文辭平順',4),
  ('rb-5','rub-guoxie-2','C+', 9, 6,'敘寫浮泛，文辭欠通順',5),
  ('rb-6','rub-guoxie-2','C',  5, 1,'敘寫雜亂，文句不通',6),
  ('rb-7','rub-guoxie-2','0',  0, 0,'空白卷、文不對題，或僅抄錄題幹',7)
ON CONFLICT (id) DO NOTHING;

INSERT INTO rubrics (id, "tenantId", name, "totalScore", mode, "sourceRef", "internalOnly", "updatedAt")
VALUES ('rub-en-essay', 'demo-tenant', '英文作文', 20, 'DIMENSION',
        '114 學年度學科能力測驗英文考科非選擇題評分原則', true, now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO rubric_dimensions (id, "rubricId", name, "nameEn", "maxScore", descriptor, "order") VALUES
  ('rd-1','rub-en-essay','內容',      'Content',                5,'主題清楚切題，並有具體、完整的相關細節支持',1),
  ('rd-2','rub-en-essay','組織',      'Organization',           5,'重點分明，有開頭、發展、結尾，前後連貫',2),
  ('rd-3','rub-en-essay','文法、句構','Grammar & Structure',    5,'全文幾無文法、格式、標點錯誤，文句結構富變化',3),
  ('rd-4','rub-en-essay','字彙、拼字','Vocabulary & Spelling',  5,'用字精確、得宜，且幾無拼字、大小寫錯誤',4)
ON CONFLICT (id) DO NOTHING;

COMMIT;
