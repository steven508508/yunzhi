/**
 * 教職員帳號的規則判斷。**純函式，不碰資料庫。**
 *
 * # 為什麼這一支要單獨存在
 *
 * 這裡每一條規則寫錯的症狀都不是當機，而是別的東西：
 *
 *   · **最後一個管理員被停用或降級** → 沒有人能管理系統，而且系統裡
 *     沒有任何一條救回來的路徑（要重設角色得先登入，要登入得有管理員）。
 *     唯一的解法是進到機房用 psql 手改一列資料。這是**一次按錯就要
 *     叫工程師出勤**的等級。
 *   · **角色給寬了** → 一位老師取得 SYS_ADMIN，而畫面上沒有任何地方
 *     會告訴任何人這件事發生了。
 *   · **學生帳號被改成老師** → 學生看得到全班的成績、家長信箱與題庫，
 *     而他的帳號在名冊上看起來完全正常。
 *
 * 三種都需要「一個角色 × 一個對象 × 剩下幾個管理員」這種組合式的驗證，
 * 而那要跑得起來就不能碰資料庫。所以查詢留在 `lib/staff.ts` 那一側，
 * 判斷本身在這裡——與 `lib/scope.mjs` 是同一個分工：
 * **會判錯的東西要能在沒有資料庫的情況下驗。**
 */

/**
 * 這一頁指派得出去的角色。
 *
 * **STUDENT 與 GUARDIAN 不在裡面，而且不是漏掉的。** 學生帳號走名冊
 * 匯入（`lib/roster.ts`）：那條路徑會一併處理家長同意、生日判定未成年、
 * 入班關係與初始密碼列印。從這一頁建一個 STUDENT 帳號會得到一個
 * 不在任何班上、沒有家長同意紀錄的學生——他登不進去，而名冊上找不到他。
 * 兩條路徑打架的結果是櫃檯人員以為系統壞了。
 */
export const ASSIGNABLE_ROLES = Object.freeze([
  'TEACHER',
  'SUBJECT_LEAD',
  'SCHOOL_ADMIN',
  'SYS_ADMIN',
]);

/** 職員角色的集合。判斷「這個帳號歸這一頁管嗎」時用。 */
export const STAFF_ROLE_SET = Object.freeze(new Set(ASSIGNABLE_ROLES));

/**
 * 帳號代號的格式。
 *
 * 不接受空白字元：登入表單送出前不會幫使用者 trim 中間的空白，而
 * 「王 老師」與「王老師」在畫面上幾乎看不出差別——症狀是新老師
 * 拿到帳號卻登不進去，而管理員照著螢幕唸給他聽的那一串是對的。
 */
const USERNAME_SHAPE = /^[^\s]{2,40}$/;

/**
 * 檢查登入帳號。回傳問題敘述，沒問題回 `null`。
 *
 * @param {string} raw
 * @param {ReadonlySet<string>} [taken] 這個機構已經有的帳號（含學生的）
 * @returns {string | null}
 */
export function checkStaffUsername(raw, taken) {
  const username = (raw ?? '').trim();
  if (!username) return '請填寫登入帳號';
  if (!USERNAME_SHAPE.test(username)) {
    return '登入帳號要 2 到 40 個字，而且中間不能有空白（老師會照著它打）。';
  }
  if (taken?.has(username)) {
    // 學生的學號與老師的代號在同一張表、同一個唯一鍵底下。撞到學號
    // 的機會不高但不是零（有人用 T001 當教師代號，也有補習班的學號
    // 長這樣），而撞到時的訊息要說得出「被誰佔走了」。
    return `「${username}」已經有人在用了（可能是某位學生的學號）。請換一個。`;
  }
  return null;
}

/** 檢查姓名。回傳問題敘述，沒問題回 `null`。 */
export function checkStaffName(raw) {
  const name = (raw ?? '').trim();
  if (!name) return '請填寫姓名';
  if (name.length > 40) return '姓名太長（最多 40 個字）';
  return null;
}

/**
 * 這是不是一個指派得出去的職員角色。
 *
 * @param {string} role
 * @returns {string | null}
 */
export function checkStaffRole(role) {
  if (!STAFF_ROLE_SET.has(role)) {
    if (role === 'STUDENT' || role === 'GUARDIAN') {
      return (
        '學生與家長帳號不從這一頁建立。學生請到班級頁匯入名冊——' +
        '那條路徑會一併處理家長同意、入班與初始密碼，' +
        '從這裡建出來的學生不在任何班上，也登不進去。'
      );
    }
    return `認不得的角色「${role}」`;
  }
  return null;
}

/**
 * 這個人給不給得起這個角色。
 *
 * **只有系統管理員能給出系統管理員。** 少了這一條，一位校務管理員
 * 可以建一個 SYS_ADMIN 帳號然後用它登入——那是一條沒有任何紀錄看得
 * 出來的提權路徑（稽核上只會看到「建立帳號」，那是他本來就該做的事）。
 *
 * @param {string} actorRole 操作者的系統角色
 * @param {string} targetRole 要給出去的角色
 * @returns {string | null}
 */
export function checkGrant(actorRole, targetRole) {
  const problem = checkStaffRole(targetRole);
  if (problem) return problem;
  if (targetRole === 'SYS_ADMIN' && actorRole !== 'SYS_ADMIN') {
    return '只有系統管理員能指派系統管理員。請找一位現任的系統管理員來做這件事。';
  }
  return null;
}

/**
 * 這個人動不動得了這個帳號。
 *
 * **校務管理員動不了系統管理員的帳號。** 少了這一條，他可以把在職的
 * 系統管理員停用掉再自己接手，而整個過程每一步看起來都是合法操作。
 *
 * @param {string} actorRole
 * @param {{ systemRole: string, displayName?: string }} target
 * @returns {string | null}
 */
export function checkActOn(actorRole, target) {
  if (!STAFF_ROLE_SET.has(target.systemRole)) {
    return (
      `「${target.displayName ?? target.systemRole}」不是教職員帳號，這一頁動不了它。` +
      '學生帳號請到他所屬的班級頁處理。'
    );
  }
  if (target.systemRole === 'SYS_ADMIN' && actorRole !== 'SYS_ADMIN') {
    return '只有系統管理員能修改系統管理員的帳號。';
  }
  return null;
}

/**
 * 改一個帳號的角色，可不可以。
 *
 * @param {object} p
 * @param {{ id: string, systemRole: string }} p.actor 操作者
 * @param {{ id: string, systemRole: string, displayName?: string, status?: string }} p.target
 * @param {string} p.nextRole
 * @param {number} p.otherActiveSysAdmins
 *   **除了 target 以外**還有幾個可以登入的系統管理員。
 *   刻意排除 target 自己，否則呼叫端要自己減一，而減錯的那一次
 *   正好是「只剩一個」的那一次。
 * @returns {string | null}
 */
export function checkRoleChange({ actor, target, nextRole, otherActiveSysAdmins }) {
  const actOn = checkActOn(actor.systemRole, target);
  if (actOn) return actOn;

  const grant = checkGrant(actor.systemRole, nextRole);
  if (grant) return grant;

  if (target.systemRole === nextRole) return null;

  // 改自己的角色一律擋。
  //
  // 從管理員降下來的那一瞬間，這一頁就不再對他開放——他改不回去，
  // 而且畫面上會直接變成「你沒有權限」。要找另一位管理員救，
  // 但如果他就是唯一的那一個，就沒有人救得了。
  //
  // 擋掉的代價只是「請另一位管理員幫你改」，而那本來就是比較安全的
  // 做法：角色異動應該有第二個人知道。
  if (actor.id === target.id) {
    return (
      '不能改自己的角色。降下來之後這一頁就不再對你開放，你也改不回去——' +
      '請找另一位系統管理員來做這件事。'
    );
  }

  if (target.systemRole === 'SYS_ADMIN' && nextRole !== 'SYS_ADMIN' && otherActiveSysAdmins === 0) {
    return (
      `「${target.displayName ?? target.systemRole}」是目前唯一一位可以登入的系統管理員，不能把他降級。` +
      '降下來之後就沒有人能管理科目、學年度、教職員與班級了，' +
      '而系統裡沒有任何一條把權限拿回來的路徑——只能進機房改資料庫。' +
      '請先指派另一位系統管理員。'
    );
  }
  return null;
}

/**
 * 停用或重新啟用一個帳號，可不可以。
 *
 * @param {object} p
 * @param {{ id: string, systemRole: string }} p.actor
 * @param {{ id: string, systemRole: string, displayName?: string, status: string }} p.target
 * @param {'ACTIVE' | 'SUSPENDED'} p.nextStatus
 * @param {number} p.otherActiveSysAdmins 除了 target 以外還有幾個可登入的系統管理員
 * @returns {string | null}
 */
export function checkStatusChange({ actor, target, nextStatus, otherActiveSysAdmins }) {
  if (nextStatus !== 'ACTIVE' && nextStatus !== 'SUSPENDED') {
    return `認不得的帳號狀態「${nextStatus}」`;
  }
  const actOn = checkActOn(actor.systemRole, target);
  if (actOn) return actOn;

  if (target.status === nextStatus) return null;

  // 停用自己等於把自己鎖在門外，而且是立刻生效（`requireUser` 只讓
  // ACTIVE 的帳號通過，下一次點擊就會被踢回登入頁）。
  // 重新啟用自己不用擋——能按到這顆按鈕就表示他還登得進來。
  if (actor.id === target.id && nextStatus === 'SUSPENDED') {
    return '不能停用自己的帳號。停用之後你下一次點擊就會被登出，而且自己救不回來。';
  }

  if (target.systemRole === 'SYS_ADMIN' && nextStatus === 'SUSPENDED' && otherActiveSysAdmins === 0) {
    return (
      `「${target.displayName ?? target.systemRole}」是目前唯一一位可以登入的系統管理員，不能停用。` +
      '停用之後沒有任何人進得了管理功能，而重新啟用他需要一個管理員帳號——' +
      '那正是被停用的那一個。請先指派另一位系統管理員。'
    );
  }
  return null;
}
