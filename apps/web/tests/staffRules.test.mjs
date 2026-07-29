/**
 * 教職員帳號的規則。
 *
 * # 這一支測的是「按下去就要叫工程師出勤」的那一格
 *
 * 最後一個系統管理員被停用或降級之後，系統裡**沒有任何一條救得回來
 * 的路徑**：要改角色得先登入，要登入得有一個管理員帳號，而那個帳號
 * 剛剛被停掉了。唯一的解法是進機房用 psql 手改一列資料。
 *
 * 這一條規則寫錯不會當機、不會有錯誤訊息——它只是在某個下午讓某個
 * 人按下「停用」，然後整間補習班的管理功能就沒了。所以它有測試，
 * 而且每一個測試的註解寫的是**錯了會怎樣**。
 *
 * 其餘幾條同樣是「不會有症狀」的那一種：角色給寬了沒有人會來講，
 * 學生帳號被改成老師之後他在名冊上看起來完全正常。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ASSIGNABLE_ROLES,
  checkActOn,
  checkGrant,
  checkRoleChange,
  checkStaffName,
  checkStaffRole,
  checkStaffUsername,
  checkStatusChange,
} from '../lib/staffRules.mjs';

const admin = { id: 'boss', systemRole: 'SYS_ADMIN' };
const school = { id: 'school', systemRole: 'SCHOOL_ADMIN' };

const staff = (over = {}) => ({
  id: 'u1',
  systemRole: 'TEACHER',
  displayName: '王老師',
  status: 'ACTIVE',
  ...over,
});

// ─────────────────────────────────────────────────────────────────
// 一、最後一個系統管理員
// ─────────────────────────────────────────────────────────────────

test('最後一個系統管理員不能被降級', () => {
  // 錯的話：降下去之後沒有人進得了教職員、科目、學年度與班級管理，
  // 而把權限拿回來需要一個管理員帳號——那正是剛剛被降的那一個。
  // 唯一的解法是進機房用 psql 手改資料庫。
  const problem = checkRoleChange({
    actor: admin,
    target: staff({ id: 'only', systemRole: 'SYS_ADMIN' }),
    nextRole: 'TEACHER',
    otherActiveSysAdmins: 0,
  });
  assert.ok(problem, '最後一個管理員被降級了');
  assert.match(problem, /唯一/);
});

test('最後一個系統管理員不能被停用', () => {
  // 錯的話：症狀與上一格一樣，而且更容易發生——「停用」是一顆
  // 每天都在按的按鈕（老師離職），「降級」不是。
  const problem = checkStatusChange({
    actor: admin,
    target: staff({ id: 'only', systemRole: 'SYS_ADMIN' }),
    nextStatus: 'SUSPENDED',
    otherActiveSysAdmins: 0,
  });
  assert.ok(problem, '最後一個管理員被停用了');
  assert.match(problem, /唯一/);
});

test('還有另一個管理員時，降級與停用都放行', () => {
  // 反方向也要測：擋得太寬的話，離職的管理員永遠停用不掉，
  // 而他的帳號會一直留著能登入——那是另一種安全問題。
  const target = staff({ id: 'old', systemRole: 'SYS_ADMIN' });
  assert.equal(
    checkRoleChange({ actor: admin, target, nextRole: 'TEACHER', otherActiveSysAdmins: 1 }),
    null,
  );
  assert.equal(
    checkStatusChange({ actor: admin, target, nextStatus: 'SUSPENDED', otherActiveSysAdmins: 1 }),
    null,
  );
});

test('otherActiveSysAdmins 已經排除了對象自己', () => {
  // 這一格擋的是呼叫端的一個必然錯誤：查「全機構有幾個管理員」
  // 然後忘記把對象減掉。那樣算出來的 1 其實是 0，而唯一一個管理員
  // 就這樣被停用了。參數名與語意在這裡釘死。
  const target = staff({ id: 'only', systemRole: 'SYS_ADMIN' });
  assert.equal(
    checkStatusChange({ actor: admin, target, nextStatus: 'SUSPENDED', otherActiveSysAdmins: 1 }),
    null,
    '「除了他以外還有一個」應該放行',
  );
  assert.ok(
    checkStatusChange({ actor: admin, target, nextStatus: 'SUSPENDED', otherActiveSysAdmins: 0 }),
    '「除了他以外一個都沒有」應該擋住',
  );
});

test('把最後一個管理員的角色改成他原本的角色，不算降級', () => {
  // 表單重送、連點兩下都會走到這裡。擋住的話畫面上會出現一則
  // 看不懂的錯誤，而使用者什麼都沒改。
  assert.equal(
    checkRoleChange({
      actor: admin,
      target: staff({ id: 'only', systemRole: 'SYS_ADMIN' }),
      nextRole: 'SYS_ADMIN',
      otherActiveSysAdmins: 0,
    }),
    null,
  );
});

test('唯一的管理員仍然可以被重新啟用', () => {
  // 只擋停用不擋啟用。反過來寫的話，一個被停用的唯一管理員永遠
  // 救不回來——那正是這一整組規則要避免的狀態。
  assert.equal(
    checkStatusChange({
      actor: admin,
      target: staff({ id: 'only', systemRole: 'SYS_ADMIN', status: 'SUSPENDED' }),
      nextStatus: 'ACTIVE',
      otherActiveSysAdmins: 0,
    }),
    null,
  );
});

// ─────────────────────────────────────────────────────────────────
// 二、動到自己
// ─────────────────────────────────────────────────────────────────

test('不能改自己的角色', () => {
  // 錯的話：管理員把自己改成老師，下一次點擊就進不了這一頁，
  // 而他改不回去。若他剛好是唯一的管理員，上面那一條也擋不住——
  // 因為 otherActiveSysAdmins 的判斷在自己這一條之後。
  const problem = checkRoleChange({
    actor: admin,
    target: { ...staff({ id: admin.id, systemRole: 'SYS_ADMIN' }) },
    nextRole: 'TEACHER',
    otherActiveSysAdmins: 3,
  });
  assert.ok(problem, '自己把自己降級了');
  assert.match(problem, /自己/);
});

test('不能停用自己', () => {
  // 錯的話：按下去的當下他還看得到畫面，下一次點擊被踢回登入頁，
  // 然後登不進來。要別人救，而別人不一定在。
  const problem = checkStatusChange({
    actor: admin,
    target: staff({ id: admin.id, systemRole: 'SYS_ADMIN' }),
    nextStatus: 'SUSPENDED',
    otherActiveSysAdmins: 3,
  });
  assert.ok(problem, '自己把自己停用了');
  assert.match(problem, /自己/);
});

test('重新啟用自己不擋', () => {
  // 能按到這顆按鈕就表示他登得進來，所以這是一個不可能發生的組合。
  // 擋它只會在某天多出一則沒有人看得懂的錯誤。
  assert.equal(
    checkStatusChange({
      actor: admin,
      target: staff({ id: admin.id, systemRole: 'SYS_ADMIN', status: 'SUSPENDED' }),
      nextStatus: 'ACTIVE',
      otherActiveSysAdmins: 0,
    }),
    null,
  );
});

// ─────────────────────────────────────────────────────────────────
// 三、角色的合法性
// ─────────────────────────────────────────────────────────────────

test('可指派的角色就是那四個，不含學生與家長', () => {
  // 多一個少一個都是問題：多了 STUDENT 就是兩條建立學生的路徑打架，
  // 少了 SUBJECT_LEAD 則是那個角色的帳號從教職員頁上整個消失。
  assert.deepEqual([...ASSIGNABLE_ROLES], [
    'TEACHER',
    'SUBJECT_LEAD',
    'SCHOOL_ADMIN',
    'SYS_ADMIN',
  ]);
});

test('這一頁建不出學生與家長帳號', () => {
  // 錯的話：從這裡建出來的學生不在任何班上、沒有家長同意紀錄，
  // 登不進去，而名冊上找不到他——櫃檯人員會以為系統壞了。
  for (const role of ['STUDENT', 'GUARDIAN']) {
    const problem = checkStaffRole(role);
    assert.ok(problem, `${role} 竟然指派得出去`);
    assert.match(problem, /名冊|學生/);
  }
});

test('認不得的角色一律擋', () => {
  // 預設值往「不行」倒。日後 schema 新增 FRONT_DESK 而這裡忘了登錄時，
  // 症狀是「建不出來」——有人會來講。反過來沒有人會來講。
  for (const role of ['', 'PROCTOR', 'FRONT_DESK', 'sys_admin']) {
    assert.ok(checkStaffRole(role), `${role} 竟然是合法角色`);
  }
});

test('只有系統管理員給得起系統管理員', () => {
  // 錯的話：一位校務管理員建一個 SYS_ADMIN 帳號然後用它登入，
  // 而稽核上只會看到「建立帳號」——那是他本來就該做的事。
  assert.ok(checkGrant('SCHOOL_ADMIN', 'SYS_ADMIN'), '校務管理員竟然給得起系統管理員');
  assert.equal(checkGrant('SYS_ADMIN', 'SYS_ADMIN'), null);
  assert.equal(checkGrant('SCHOOL_ADMIN', 'TEACHER'), null);
  assert.equal(checkGrant('SCHOOL_ADMIN', 'SCHOOL_ADMIN'), null);
});

test('校務管理員動不了系統管理員的帳號', () => {
  // 錯的話：他可以把在職的系統管理員停用再自己接手，
  // 而整個過程每一步看起來都是合法操作。
  assert.ok(checkActOn('SCHOOL_ADMIN', { systemRole: 'SYS_ADMIN', displayName: '主任' }));
  assert.equal(checkActOn('SYS_ADMIN', { systemRole: 'SYS_ADMIN' }), null);
  assert.equal(checkActOn('SCHOOL_ADMIN', { systemRole: 'TEACHER' }), null);
});

test('學生帳號不歸這一頁管', () => {
  // 錯的話：這支 API 變成一條把學生提權成老師的路徑，而那位學生
  // 在名冊上看起來完全正常——他只是突然看得到全班的成績與家長信箱。
  const problem = checkActOn('SYS_ADMIN', { systemRole: 'STUDENT', displayName: '王小明' });
  assert.ok(problem, '學生帳號竟然動得了');
  assert.match(problem, /不是教職員/);
});

test('改角色時，對象是學生一樣擋得住', () => {
  // checkActOn 在 checkRoleChange 的第一步。順序寫反的話（先看
  // 「是不是最後一個管理員」），一個學生帳號會直接被改成 SYS_ADMIN。
  const problem = checkRoleChange({
    actor: admin,
    target: staff({ systemRole: 'STUDENT' }),
    nextRole: 'SYS_ADMIN',
    otherActiveSysAdmins: 5,
  });
  assert.ok(problem, '學生被提權成管理員了');
});

test('校務管理員可以把老師升成校務管理員', () => {
  // 正常路徑也要測：擋得太寬的話這一頁對校務管理員等於唯讀，
  // 而他就是被指派來做這件事的人。
  assert.equal(
    checkRoleChange({
      actor: school,
      target: staff(),
      nextRole: 'SCHOOL_ADMIN',
      otherActiveSysAdmins: 1,
    }),
    null,
  );
});

// ─────────────────────────────────────────────────────────────────
// 四、帳號與姓名的格式
// ─────────────────────────────────────────────────────────────────

test('登入帳號中間不能有空白', () => {
  // 「王 老師」與「王老師」在畫面上幾乎看不出差別。症狀是新老師
  // 拿到帳號卻登不進去，而管理員照著螢幕唸給他聽的那一串是對的。
  assert.ok(checkStaffUsername('T 001'));
  assert.ok(checkStaffUsername('T\t001'));
  assert.equal(checkStaffUsername('T001'), null);
});

test('登入帳號前後的空白會被吃掉，不算錯', () => {
  // 從 Excel 或聊天室貼過來一定會帶到。要求使用者自己清乾淨，
  // 等於要求他先做那件他想用系統來避免的事。
  assert.equal(checkStaffUsername('  T001  '), null);
});

test('太短的帳號擋住', () => {
  assert.ok(checkStaffUsername(''));
  assert.ok(checkStaffUsername('T'));
});

test('撞到既有帳號時，訊息要說得出可能是學生的學號', () => {
  // 學生的學號與老師的代號在同一張表、同一個唯一鍵底下。撞到時
  // 只說「已存在」的話，管理員會在教職員清單裡找不到那個人，
  // 然後以為系統壞了。
  const problem = checkStaffUsername('S1234', new Set(['S1234']));
  assert.ok(problem);
  assert.match(problem, /學號/);
});

test('姓名不能空白、不能過長', () => {
  assert.ok(checkStaffName('  '));
  assert.ok(checkStaffName('王'.repeat(41)));
  assert.equal(checkStaffName('王老師'), null);
});
