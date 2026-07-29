/**
 * 每一張資料表屬於誰：租戶歸屬的唯一真實來源。
 *
 * # 為什麼要有這個檔案
 *
 * 系統是單一補習班自架，之後要白牌授權給別家。那一刻起，
 * 「A 補習班看得到 B 補習班的資料」就從一個 bug 變成一個法律問題——
 * 出版社詳解的授權範圍是「機構內部使用」，跨機構就是對外散布。
 *
 * 在此之前，隔離完全靠每個查詢自己記得帶 `tenantId`。12 個 API 路由
 * 時漏一個還看得出來；80 個路由時，漏掉的那一個是水平越權漏洞，
 * 而且**不會有任何錯誤訊息**——它只是安靜地多回傳幾列。
 *
 * 所以隔離下沉到資料庫：Postgres 的 row-level security。應用層漏了
 * 條件，資料庫仍然擋得住。
 *
 * # 這個檔案怎麼被使用
 *
 *   tools/rls-check.mjs --emit    產生遷移用的 SQL
 *   tools/rls-check.mjs           對著真的資料庫驗證政策存在且正確
 *
 * **schema 加了新模型而這裡沒有分類，檢查會失敗。** 那是刻意的：
 * 「新增一張表」與「決定這張表屬於誰」必須是同一個動作，否則遲早
 * 會有一張表在沒有人注意的情況下對所有租戶敞開。
 *
 * # 寫遷移的人一定要知道的一件事
 *
 * **`ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` 的驗證掃描受
 * RLS 影響**，而 psql 預設沒有租戶脈絡。對「已經有資料」的租戶表
 * 補外鍵時會出現兩種都很難看的結果（兩種都在 e2e 裡實際重現過）：
 *
 *   · 被參照表看不見、參照表看得見 → 遷移中止，錯誤說
 *     `Key (questionId)=(...) is not present in table "questions"`，
 *     **而那一列其實存在**。訊息指向一個不存在的問題。
 *   · 兩張表都看不見（一般連線的預設狀態）→ **驗證「通過」但一列都
 *     沒檢查**，等於加了一條從來沒被驗證過的外鍵。第二種比第一種
 *     糟得多：它不會失敗，只會在幾個月後某次資料清理時才爆出來。
 *
 * 建表當下是空的所以不受影響（目前所有遷移都屬於這一類）。要對
 * 有資料的表補外鍵時，在同一個交易裡先
 * `SELECT set_config('app.cross_tenant', 'on', true);`，
 * 或用 `ADD CONSTRAINT ... NOT VALID` 再帶著 GUC `VALIDATE CONSTRAINT`。
 *
 * # 三種歸屬
 *
 *   root      租戶表自己。用 id 比對。
 *   direct    自己有 tenantId 欄位。
 *   indirect  沒有 tenantId，靠外鍵掛到某個父表。政策遞迴展開。
 *   global    刻意不屬於任何租戶。**每一項都要寫理由。**
 */

/** 租戶表本身。 */
export const ROOT_TABLE = 'tenants';

/**
 * 不屬於任何租戶的表。**每一項都必須寫清楚為什麼**——這份清單是
 * 唯一能繞過隔離的地方，所以它必須小、而且每一項都經得起問。
 */
export const GLOBAL = {
  system_settings:
    '部署層級的設定（維護模式、功能開關），不是租戶資料',
  deployment_records:
    '部署紀錄（版本、遷移時間）。運維資料，與租戶無關',
  publishers:
    '出版社名冊（翰林、南一、龍騰）。是共用的參照資料，' +
    '不是任何一家補習班的資產。注意：出版社「的題目」屬於租戶，' +
    '這裡只有名字',
  official_source_fetches:
    '大考中心公開資料的抓取紀錄。來源是公開的，抓取行為是系統層的',
};

/**
 * 靠外鍵掛到父表的表。值是 [父表, 本表的外鍵欄位]。
 *
 * 政策會遞迴展開到 root——所以兩層以上（textbook_curriculum_links
 * → textbook_nodes → textbook_editions）不必特別處理。
 */
export const INDIRECT = {
  // 智慧老師與考試行為（掛在既有的父表上，不自己帶 tenantId）
  tutor_messages: ['tutor_sessions', 'sessionId'],
  proctor_events: ['attempts', 'attemptId'],

  // 考卷、任務、作答（B2–B4）
  exam_paper_items: ['exam_papers', 'paperId'],
  assignment_targets: ['assignments', 'assignmentId'],
  attempts: ['assignments', 'assignmentId'],
  attempt_answers: ['attempts', 'attemptId'],

  sessions: ['users', 'userId'],
  guardian_links: ['users', 'studentId'],
  notification_preferences: ['users', 'userId'],
  class_memberships: ['classes', 'classId'],
  class_subject_teachers: ['classes', 'classId'],
  kp_prerequisites: ['knowledge_points', 'kpId'],
  kp_curriculum_links: ['knowledge_points', 'knowledgePointId'],
  textbook_nodes: ['textbook_editions', 'editionId'],
  textbook_curriculum_links: ['textbook_nodes', 'textbookNodeId'],
  question_options: ['questions', 'questionId'],
  question_knowledge_points: ['questions', 'questionId'],
  question_textbook_links: ['questions', 'questionId'],
  rubric_dimensions: ['rubrics', 'rubricId'],
  rubric_bands: ['rubrics', 'rubricId'],
  import_files: ['import_jobs', 'jobId'],
  import_pages: ['import_jobs', 'jobId'],
  import_candidates: ['import_jobs', 'jobId'],
  duplicate_members: ['duplicate_groups', 'groupId'],
};

/**
 * 目前的租戶。沒設就是 NULL，而 `NULL = 任何值` 是 NULL 不是 true
 * ——所以**沒設租戶時什麼都看不到**。這個 fail-closed 的性質是整套
 * 設計的重點：忘記設比設錯更常見，而忘記設必須是「查不到東西」
 * 而不是「查到全部」。
 */
export const TENANT_GUC = 'app.tenant_id';

/**
 * 跨租戶的逃生口。**只有背景工作者與遷移腳本該用。**
 *
 * 它存在是因為有些工作本來就是跨租戶的：worker 要處理所有租戶的
 * 佇列、遷移要改所有租戶的資料、備份要讀全部。沒有逃生口的話，
 * 那些程式會被迫關掉 RLS，而那比留一個有名字、可稽核的開關糟。
 *
 * `tools/rls-check.mjs` 會檢查它只出現在允許的檔案裡。
 */
export const BYPASS_GUC = 'app.cross_tenant';

/**
 * 允許**直接動資料庫設定值**的檔案。
 *
 * 這一層是「誰有資格把 app.cross_tenant 送進 SQL」。清單很短而且
 * 全部是基礎設施——業務程式一律走 `withoutTenantScope()`，
 * 那個有下面另一份清單管。
 */
export const BYPASS_ALLOWED = [
  'apps/web/lib/tenantContext.mjs',   // 逃生口本身的實作
  'apps/web/lib/prismaClient.mjs',    // 把脈絡送進資料庫的那一層
  'tools/pg-shim.mjs',                // 測試替身，做同一件事
  'tools/tenancy.mjs',                // 本檔
  'tools/rls-check.mjs',              // 檢查器
];

/**
 * 允許呼叫 `withoutTenantScope()` 的檔案。**這一份比上一份重要。**
 *
 * 上一份管的是「誰能碰底層開關」，這一份管的是「誰能真的跨租戶
 * 做事」。每一項都要說得出為什麼那件事本質上就是跨租戶的——
 * 「這樣寫比較方便」不是理由。
 */
export const CROSS_TENANT_ALLOWED = {
  'apps/web/lib/tenant.ts': '逃生口的型別外殼',
  'apps/web/lib/tenantContext.mjs': '逃生口本身的實作',
  'apps/web/lib/auth.ts':
    'session 查核與租戶解析。雞生蛋：要知道這次請求屬於哪個租戶，' +
    '得先查出 session 是誰的。sessionToken 是密碼學亂數，猜不到別人的，' +
    '所以跨租戶查一個給定的 token 不會洩漏東西',
  'apps/web/scripts/worker.mjs':
    '背景維護：清所有租戶的過期 session、解鎖所有租戶的帳號、' +
    '找出所有租戶卡住的匯入。工作者不屬於任何一家補習班',
  'apps/web/scripts/import-pipeline.mjs':
    '佇列只給 jobId，要先查出這個工作屬於誰才能建立租戶脈絡',
  'apps/web/scripts/migrate-and-seed.mjs':
    '遷移與種子：這支腳本比租戶本身更早執行',
  'apps/web/app/api/auth/logout/route.ts':
    '登出：手上只有 cookie 裡的 token，還不知道它屬於哪個租戶。' +
    '少了跨租戶，RLS 會讓刪除比對不到任何一列——cookie 清掉了、' +
    '伺服器端的 session 卻還活著，而畫面上看起來完全正常',
};

/** 這一張表的「屬於本租戶」條件。遞迴展開到 root。 */
export function predicate(table, alias = '') {
  const p = alias ? `${q(alias)}.` : '';
  if (table === ROOT_TABLE) return `${p}"id" = current_setting('${TENANT_GUC}', true)`;
  if (GLOBAL[table]) return 'true';
  if (INDIRECT[table]) {
    const [parent, fk] = INDIRECT[table];
    const a = `rls_${parent}`;
    return (
      `EXISTS (SELECT 1 FROM ${q(parent)} ${q(a)} ` +
      `WHERE ${q(a)}."id" = ${p}${q(fk)} AND ${predicate(parent, a)})`
    );
  }
  // 其餘一律視為直接持有 tenantId。rls-check 會驗證欄位真的存在。
  return `${p}"tenantId" = current_setting('${TENANT_GUC}', true)`;
}

/** 完整的政策條件：本租戶的資料，或明確開啟的跨租戶模式。 */
export function policyExpr(table) {
  return `(current_setting('${BYPASS_GUC}', true) = 'on' OR ${predicate(table)})`;
}

/** 產生一張表的 RLS SQL。 */
export function tableSql(table) {
  const expr = policyExpr(table);
  return [
    `ALTER TABLE ${q(table)} ENABLE ROW LEVEL SECURITY;`,
    // FORCE 讓政策連資料表的擁有者也適用。少了它，應用程式用擁有者
    // 身分連線時 RLS 形同虛設——而那正是最常見的部署方式。
    `ALTER TABLE ${q(table)} FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${q(policyName(table))} ON ${q(table)};`,
    `CREATE POLICY ${q(policyName(table))} ON ${q(table)}`,
    `  FOR ALL USING ${expr} WITH CHECK ${expr};`,
  ].join('\n');
}

export function policyName(table) {
  return `${table}_tenant_isolation`;
}

export function q(id) {
  return `"${String(id).replace(/"/g, '""')}"`;
}
