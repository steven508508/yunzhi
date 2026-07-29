/**
 * 範圍：誰看得到哪些成績、一份任務涵蓋哪些人。
 *
 * # 為什麼這三支不留在 lib/scoring.ts 與 lib/assignment.ts 裡
 *
 * 因為它們是**沒有測試保護的判斷**，而判斷錯了的代價分成兩種：
 *
 *   · `maySeeGrades` 錯 → 國文老師看得到數學班每一位學生的姓名、
 *     學號與分數。這不會有任何錯誤訊息，而且只有被看的人受影響，
 *     所以不會有人來回報。
 *   · `countByAssignment` 錯 → 「派給 63 人」與實際收到的人數對不上。
 *     症狀是催繳名單上有一個交不出來的人，或者少了一個該交的人。
 *
 * 兩者都需要「一個角色 × 一份科目清單 × 一組班級」這種組合式的驗證，
 * 而那要跑得起來就不能碰資料庫。所以資料庫查詢留在 .ts 那一側，
 * 判斷本身搬到這裡——與 `lib/grading.mjs` 是同一個分工：
 * **會算錯的東西要能在沒有資料庫的情況下驗。**
 */

/**
 * 不受科目限制的角色。
 *
 * 學科召集人在這裡面，是因為他的職責就是跨班看同一科；管理員
 * 在裡面，是因為系統的維運與家長申訴最後都落在他身上。
 */
const UNRESTRICTED = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN', 'SUBJECT_LEAD']);

/** 有科目職權的角色。**沒列進來的一律當成沒有任何科目。** */
const SUBJECT_BOUND = new Set(['TEACHER']);

/**
 * 這個角色看得到哪幾科。`null` 代表「不受限制」。
 *
 * @param {string} systemRole
 * @param {readonly string[]} taughtSubjectIds 這個人實際被指定的授課科目
 * @returns {string[] | null}
 *
 * 認不得的角色回空陣列而不是 null。權限判斷的預設值要往「看不到」倒：
 * 日後新增一個角色而忘了在這裡登錄時，症狀是「他說他看不到成績」，
 * 有人會來講；反過來的症狀是沒有人會來講。
 */
export function subjectScope(systemRole, taughtSubjectIds) {
  if (UNRESTRICTED.has(systemRole)) return null;
  if (!SUBJECT_BOUND.has(systemRole)) return [];
  return [...new Set(taughtSubjectIds ?? [])];
}

/**
 * 看得到這一份任務的成績嗎。
 *
 * 比「能不能改分數」多一種人：**自己派出去的任務**。導師派一份跨科的
 * 小考時他不是那一科的授課老師，但那是他發出去的東西。
 *
 * @param {string[] | null} scope `subjectScope()` 的結果
 * @param {string} actorId 誰在看
 * @param {{ subjectId: string, createdBy: string | null }} assignment
 * @returns {boolean}
 */
export function maySeeGrades(scope, actorId, assignment) {
  if (scope === null) return true;
  // createdBy 是可為 null 的欄位（建立者離職後被 SetNull）。
  // 沒有 `assignment.createdBy &&` 這一段的話，兩個 null 會相等，
  // 於是**任何拿不到 actorId 的呼叫都變成看得到全部**。
  if (assignment.createdBy && assignment.createdBy === actorId) return true;
  return scope.includes(assignment.subjectId);
}

/**
 * 一組派發對象實際涵蓋幾個人，一次算好幾份任務。
 *
 * 三個輸入都是已經查好的資料，所以這一支不碰資料庫：
 *
 * @param {readonly {assignmentId: string, classId: string | null, userId: string | null}[]} targets
 * @param {Map<string, readonly string[]>} membersOfClass 班級 → 在學學生的 id
 * @param {ReadonlySet<string>} validUserIds 通過帳號檢查（未刪除、是學生）的 id
 * @returns {Map<string, number>} 任務 → 實際人數
 *
 * 三件一定要對的事，每一件錯了都只是一個數字不對而已：
 *
 *   · **去重。** 同一位學生同時在兩個被派到的班上（重補修很常見），
 *     算成兩個人的話應交人數永遠比實到多。
 *   · **一列可以同時帶班級與個人**（schema 只要求至少一邊有值），
 *     所以兩邊都要處理，不是二選一。
 *   · **帳號檢查在最後。** 班上的助教與已軟刪除的帳號不算，
 *     否則催繳名單上會有一個永遠交不出來的人。
 */
export function countByAssignment(targets, membersOfClass, validUserIds) {
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  for (const t of targets) {
    let set = seen.get(t.assignmentId);
    if (!set) seen.set(t.assignmentId, (set = new Set()));
    if (t.classId) {
      for (const uid of membersOfClass.get(t.classId) ?? []) {
        if (validUserIds.has(uid)) set.add(uid);
      }
    }
    if (t.userId && validUserIds.has(t.userId)) set.add(t.userId);
  }
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const [id, set] of seen) out.set(id, set.size);
  return out;
}
