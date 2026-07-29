/**
 * 學測的標準科目表，與開機時把它建起來的那一段。
 *
 * # 為什麼這件事不能留給人工
 *
 * 在此之前，`subject.create` 在正式程式碼裡**一次都沒有出現過**。
 * 13 個科目只寫在 `packages/db/seed/demo-115.sql` 裡，而全 repo 沒有
 * 任何腳本、compose 服務或文件會去執行那個檔案，它還硬編碼了
 * `demo-tenant`——與開機時產生的 cuid 租戶對不上。
 *
 * 也就是說系統裝起來之後**一個科目都沒有**，而沒有科目就建不了卷、
 * 匯不了題、開不了知識點：`/import/new` 的科目下拉是空的，`/papers`
 * 按「新增卷子」會失敗，`/knowledge` 直接顯示「還沒有科目」。
 * 整套系統開箱即無法使用，而畫面上沒有任何地方說得出原因。
 *
 * 這 13 個科目對每一家補習班都一樣（依 111 學年度起的學測考科），
 * 所以它是**安裝的一部分**，不是使用者的第一件工作。
 *
 * # 為什麼放在 .mjs
 *
 * 兩個呼叫端不經過 TypeScript 編譯：`scripts/migrate-and-seed.mjs`
 * 與驗證用的 shim。而這份清單同時要被網頁端（`lib/subject.ts`）引用，
 * 分成兩份寫的話，兩邊的科目代碼遲早分岐——而分岐的症狀是匯入管線
 * 把題目分到一個網頁端不認得的科目，題庫裡看不到它。
 *
 * # 代碼是對外的契約，不是顯示用的名字
 *
 * `code` 要與 `apps/ai/pipeline/canonical.py` 的 `SubjectCode` 一字不差：
 * 管線靠代碼分流（分科／合科的 `PARENT_SUBJECT` 對映也在那裡）。
 * 這裡拼錯一個字母，那一科匯進來的題目會掛在一個沒有人看得到的
 * 科目底下，而匯入畫面上一路都是綠燈。
 */

/**
 * 學測的 13 個科目。順序與代碼與 `packages/db/seed/demo-115.sql`
 * 及 `apps/ai/pipeline/canonical.py` 對齊，**不要在這裡發明新代碼**。
 *
 * `order` 刻意留下 51–54、61–63 的跳號：合科排前面（老師每天在用的
 * 是「自然」這張學測卷），分科接在自己的合科後面成一組。中間留白
 * 是為了日後插入科目時不必重排整張表——重排會讓每一個畫面上的
 * 科目順序在某一次部署後全部改變，而沒有人知道為什麼。
 */
export const STANDARD_SUBJECTS = Object.freeze([
  // ── 學測考科 ────────────────────────────────────────────────
  // gsatFullScore 不是全部 100：社會 144、自然 128（文件 A.1）。
  // 填錯或留空的話，級分換算會安靜地偏掉——社會科全班的得分率
  // 會變成 144/100 = 144%，而畫面上沒有任何地方看起來不對。
  { code: 'MATH_A', name: '數學A', parentCode: null, gsatFullScore: 100, order: 1 },
  { code: 'MATH_B', name: '數學B', parentCode: null, gsatFullScore: 100, order: 2 },
  { code: 'CHINESE', name: '國文', parentCode: null, gsatFullScore: 100, order: 3 },
  { code: 'ENGLISH', name: '英文', parentCode: null, gsatFullScore: 100, order: 4 },
  { code: 'SCIENCE', name: '自然', parentCode: null, gsatFullScore: 128, order: 5 },
  { code: 'SOCIAL', name: '社會', parentCode: null, gsatFullScore: 144, order: 6 },

  // ── 分科 ────────────────────────────────────────────────────
  //
  // 學測考的是合科的「自然」與「社會」，但補習班是分科教的：
  // 化學老師傳的是化學講義、地理老師傳的是地理講義。
  //
  // 少了這幾科，化學老師上傳講義時**選不到自己的科目**——他只能選
  // 「自然」，然後他的題目跟物理、生物的混在同一個題庫裡，要組一份
  // 化學小考時篩不出來。
  //
  // 分科沒有自己的學測滿分（它們不是獨立考科），級分換算一律看
  // parentCode 指到的合科（見 lib/gsat.mjs 的 fullScoreFor）。
  { code: 'PHYSICS', name: '物理', parentCode: 'SCIENCE', gsatFullScore: null, order: 51 },
  { code: 'CHEMISTRY', name: '化學', parentCode: 'SCIENCE', gsatFullScore: null, order: 52 },
  { code: 'BIOLOGY', name: '生物', parentCode: 'SCIENCE', gsatFullScore: null, order: 53 },
  { code: 'EARTH_SCIENCE', name: '地球科學', parentCode: 'SCIENCE', gsatFullScore: null, order: 54 },
  { code: 'HISTORY', name: '歷史', parentCode: 'SOCIAL', gsatFullScore: null, order: 61 },
  { code: 'GEOGRAPHY', name: '地理', parentCode: 'SOCIAL', gsatFullScore: null, order: 62 },
  { code: 'CIVICS', name: '公民', parentCode: 'SOCIAL', gsatFullScore: null, order: 63 },
]);

/** 標準科目的代碼集合。判斷「這一科是不是安裝時附的」時用。 */
export const STANDARD_CODES = Object.freeze(
  new Set(STANDARD_SUBJECTS.map((s) => s.code)),
);

/**
 * 科目代碼的格式。
 *
 * **大寫英數與底線，而且不能改。** 這不是潔癖：代碼是 AI 管線與
 * 網頁端之間的契約（`apps/ai/pipeline/canonical.py` 的 `SubjectCode`），
 * 而管線送回來的是字串。允許小寫或中文的話，`MATH_A` 與 `math_a`
 * 會變成兩個科目，而匯入的題目會落在其中一個、老師在另一個裡面找。
 */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,30}$/;

/**
 * 檢查一個新科目的代碼。回傳問題敘述，沒問題回 `null`。
 *
 * 純判斷、不碰資料庫，所以測得動——這一支寫錯的症狀是「匯進來的
 * 題目不見了」，那是最不容易被聯想到代碼格式的一種症狀。
 *
 * @param {string} raw
 * @param {ReadonlySet<string>} [taken] 已經有的代碼
 * @returns {string | null}
 */
export function checkSubjectCode(raw, taken) {
  const code = (raw ?? '').trim();
  if (!code) return '請填寫科目代碼';
  if (!CODE_SHAPE.test(code)) {
    return (
      `科目代碼「${code}」不合格式。要用大寫英文字母、數字與底線，` +
      '至少兩個字、開頭是字母，例如 MATH_A 或 SCIENCE。' +
      '代碼是 AI 匯入管線用來分科的鍵，不是給人看的名字——名稱請填在下一格。'
    );
  }
  if (taken?.has(code)) {
    return `已經有一個代碼是「${code}」的科目了。要改它的名稱請直接編輯那一筆。`;
  }
  return null;
}

/**
 * 檢查科目名稱。回傳問題敘述，沒問題回 `null`。
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function checkSubjectName(raw) {
  const name = (raw ?? '').trim();
  if (!name) return '請填寫科目名稱';
  if (name.length > 30) return '科目名稱太長（最多 30 個字）';
  return null;
}

/**
 * 檢查「這一科的上層合科」填得對不對。回傳問題敘述，沒問題回 `null`。
 *
 * 兩件事要擋：
 *
 *   · **指到不存在的代碼。** 級分換算會查不到滿分，而 `fullScoreFor`
 *     查不到就回 null（它刻意不預設 100）——症狀是成績頁上級分那一欄
 *     整欄空白，而沒有人會想到是科目設定。
 *   · **指到另一個分科。** 「化學 → 物理 → 自然」這種鏈會讓級分換算
 *     要遞迴，而 `lib/gsat.mjs` 只看一層。合科底下只能有一層分科。
 *
 * @param {string | null | undefined} parentCode
 * @param {ReadonlyMap<string, string | null>} codeToParent 現有科目：代碼 → 它的上層
 * @returns {string | null}
 */
export function checkParentCode(parentCode, codeToParent) {
  const parent = (parentCode ?? '').trim();
  if (!parent) return null;
  if (!codeToParent.has(parent)) {
    return `找不到代碼是「${parent}」的科目，不能把它當成上層考科。`;
  }
  if (codeToParent.get(parent)) {
    return (
      `「${parent}」本身是某一科的分科，不能再被當成上層。` +
      '學測的合科只有自然（SCIENCE）與社會（SOCIAL）兩層，級分換算也只看一層。'
    );
  }
  return null;
}

/**
 * 開機時把標準科目建起來。**可以重複執行。**
 *
 * # 為什麼是「先查再補」而不是 upsert
 *
 * upsert 會把名稱寫回標準值。補習班把「公民」改成「公民與社會」之後，
 * 下一次升級部署就會把它改回去——而那是一個沒有人按過的變更，
 * 出現在下一次重啟之後，看起來像資料庫壞了。
 *
 * 所以只補**不存在的代碼**：跑一百次也還是 13 筆，而管理員改過的
 * 名稱、停用過的科目都保持原狀。
 *
 * # 為什麼不用 createMany
 *
 * 一次插不進去時（例如另一個 migrate 服務同時在跑，撞到
 * `@@unique([tenantId, code])`）整批會失敗。逐筆建立時撞到的那一筆
 * 才是失敗的那一筆，其餘照樣建好——而這一支的重點就是「跑第二次
 * 要沒事」。
 *
 * @param {{ subject: { findMany: Function, create: Function } }} prisma
 * @param {string} tenantId
 * @returns {Promise<{ created: string[], existing: number }>}
 */
export async function seedStandardSubjects(prisma, tenantId) {
  const rows = await prisma.subject.findMany({
    where: { tenantId },
    select: { code: true },
  });
  const have = new Set(rows.map((r) => r.code));

  /** @type {string[]} */
  const created = [];
  for (const s of STANDARD_SUBJECTS) {
    if (have.has(s.code)) continue;
    await prisma.subject.create({
      data: {
        tenantId,
        code: s.code,
        name: s.name,
        parentCode: s.parentCode,
        gsatFullScore: s.gsatFullScore,
        order: s.order,
        active: true,
      },
    });
    created.push(s.code);
  }
  return { created, existing: have.size };
}
