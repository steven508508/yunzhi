/**
 * 範圍：誰看得到哪些成績、一份任務涵蓋哪些人。
 *
 * # 這一支測的全部是「不會有錯誤訊息」的失敗
 *
 * 權限判斷寫寬了不會當機，畫面也不會壞——它只是讓某個老師看得到
 * 他不該看到的東西。發現的方式只有一種：有人提起。而外洩的是全班
 * 學生的姓名、學號與分數，那不是一句「不好意思」可以了事的。
 *
 * 人數算錯同理：畫面上是一個看起來完全正常的數字。老師照著它去催繳，
 * 少催了一個或多催了一個都要等到考完才會知道。
 *
 * 所以每一個測試的註解寫的是**錯了會怎樣**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countByAssignment, maySeeGrades, subjectScope } from '../lib/scope.mjs';

// ─────────────────────────────────────────────────────────────────
// 一、哪些角色不受科目限制
// ─────────────────────────────────────────────────────────────────

test('管理員與學科召集人不受科目限制', () => {
  // 錯的話：家長打電話來問分數時，值班的管理員查不到任何東西。
  for (const role of ['SYS_ADMIN', 'SCHOOL_ADMIN', 'SUBJECT_LEAD']) {
    assert.equal(subjectScope(role, []), null, `${role} 應該不受限制`);
  }
});

test('老師只到自己被指定的科目為止', () => {
  // 錯的話：數學老師看得到國文班每一位學生的分數。
  assert.deepEqual(subjectScope('TEACHER', ['math']), ['math']);
});

test('同一科被指定在三個班，只算一次', () => {
  // 一科三位老師、一位老師帶三班都是常態，class_subject_teachers
  // 會有三列。沒有去重的話清單會愈長愈慢，而且 in (...) 裡塞重複值。
  assert.deepEqual(subjectScope('TEACHER', ['math', 'math', 'math']), ['math']);
});

test('沒有被指定任何科目的老師，看不到任何一科', () => {
  // 錯的方向若是「空清單 = 不限制」，一個新進老師帳號在被排課之前
  // 就看得到全校的成績。這是這一支最重要的一格。
  assert.deepEqual(subjectScope('TEACHER', []), []);
});

test('學生、家長與認不得的角色一律是空清單', () => {
  // 預設值要往「看不到」倒：日後新增角色而忘了登錄時，症狀是
  // 「他說他看不到」——有人會來講。反過來沒有人會來講。
  for (const role of ['STUDENT', 'GUARDIAN', 'PROCTOR', '']) {
    assert.deepEqual(subjectScope(role, ['math']), [], `${role} 不該有科目職權`);
  }
});

// ─────────────────────────────────────────────────────────────────
// 二、看不看得到某一份任務的成績
// ─────────────────────────────────────────────────────────────────

const mathPaper = { subjectId: 'math', createdBy: 'teacher-b' };

test('不受限制的人看得到任何一份', () => {
  assert.equal(maySeeGrades(null, 'anyone', mathPaper), true);
});

test('教這一科的老師看得到', () => {
  assert.equal(maySeeGrades(['math', 'phys'], 'teacher-a', mathPaper), true);
});

test('不教這一科的老師看不到', () => {
  // **這是 /grades/[id] 那個洞。** 列表頁濾掉了別科的任務，但任務 id
  // 就在網址上；沒有這一格，國文老師把 id 換成數學那一份就看得到
  // 那一班每一位學生的姓名、學號與分數。
  assert.equal(maySeeGrades(['chinese'], 'teacher-a', mathPaper), false);
});

test('自己派出去的任務看得到，就算不是自己的科目', () => {
  // 導師派一份跨科的小考是正常的事。看不到自己派出去的東西的結果
  // 沒有道理，而且他會改用別人的帳號去看。
  assert.equal(maySeeGrades(['chinese'], 'teacher-b', mathPaper), true);
});

test('建立者是 null 時，不會變成「大家都看得到」', () => {
  // createdBy 在建立者離職後被 SetNull。少了 null 檢查的話
  // `null === null` 成立，於是每一個拿不到 actorId 的呼叫都放行——
  // 而那正是最常見的呼叫方式（未登入、批次工作）。
  const orphan = { subjectId: 'math', createdBy: null };
  assert.equal(maySeeGrades(['chinese'], null, orphan), false);
  assert.equal(maySeeGrades(['chinese'], undefined, orphan), false);
  assert.equal(maySeeGrades([], null, orphan), false);
});

test('沒有科目的老師只看得到自己派的', () => {
  assert.equal(maySeeGrades([], 'teacher-b', mathPaper), true);
  assert.equal(maySeeGrades([], 'teacher-a', mathPaper), false);
});

// ─────────────────────────────────────────────────────────────────
// 三、一份任務實際涵蓋幾個人
// ─────────────────────────────────────────────────────────────────

/** 甲班三人、乙班兩人，其中 s3 兩班都在（重補修）。 */
const MEMBERS = new Map([
  ['classA', ['s1', 's2', 's3']],
  ['classB', ['s3', 's4']],
]);
const ALL_VALID = new Set(['s1', 's2', 's3', 's4', 's5']);

test('一個班就是那個班的人數', () => {
  const n = countByAssignment(
    [{ assignmentId: 'a1', classId: 'classA', userId: null }],
    MEMBERS,
    ALL_VALID,
  );
  assert.equal(n.get('a1'), 3);
});

test('兩個班共有的學生只算一次', () => {
  // 錯的話：應交人數 6 而實際只有 5 個人，永遠差一份沒交，
  // 而老師會一直去找那個不存在的學生。
  const n = countByAssignment(
    [
      { assignmentId: 'a1', classId: 'classA', userId: null },
      { assignmentId: 'a1', classId: 'classB', userId: null },
    ],
    MEMBERS,
    ALL_VALID,
  );
  assert.equal(n.get('a1'), 4);
});

test('整班加上個別指定的那一位', () => {
  // 「整班加補考的那兩位」是個別指定唯一的實際用途。
  const n = countByAssignment(
    [
      { assignmentId: 'a1', classId: 'classA', userId: null },
      { assignmentId: 'a1', classId: null, userId: 's5' },
    ],
    MEMBERS,
    ALL_VALID,
  );
  assert.equal(n.get('a1'), 4);
});

test('個別指定的人已經在班上時不重複算', () => {
  const n = countByAssignment(
    [
      { assignmentId: 'a1', classId: 'classA', userId: null },
      { assignmentId: 'a1', classId: null, userId: 's2' },
    ],
    MEMBERS,
    ALL_VALID,
  );
  assert.equal(n.get('a1'), 3);
});

test('同一列同時帶班級與個人，兩邊都要算', () => {
  // schema 的 CHECK 只要求至少一邊有值，所以這種列是合法的。
  // 只處理其中一邊的話，另一邊的人安靜地收不到任務。
  const n = countByAssignment(
    [{ assignmentId: 'a1', classId: 'classB', userId: 's1' }],
    MEMBERS,
    ALL_VALID,
  );
  assert.equal(n.get('a1'), 3); // s3, s4, s1
});

test('不是學生的帳號不算', () => {
  // 名冊裡的助教與老師也在 class_memberships 裡。算進去的話
  // 應交人數永遠比實到多幾個，而催繳清單上會有交不出來的人。
  const n = countByAssignment(
    [{ assignmentId: 'a1', classId: 'classA', userId: null }],
    MEMBERS,
    new Set(['s1', 's2']), // s3 是助教
  );
  assert.equal(n.get('a1'), 2);
});

test('個別指定一個已經刪除的帳號，不算', () => {
  const n = countByAssignment(
    [{ assignmentId: 'a1', classId: null, userId: 'gone' }],
    MEMBERS,
    ALL_VALID,
  );
  assert.equal(n.get('a1'), 0);
});

test('派給一個空班是 0，而且真的回一個 0', () => {
  // 「派給了一個還沒匯入名冊的班」是列表頁那句警告存在的理由。
  // 這裡若不回 0 而是漏掉這一份，警告就不會出現。
  const n = countByAssignment(
    [{ assignmentId: 'a1', classId: 'classEmpty', userId: null }],
    MEMBERS,
    ALL_VALID,
  );
  assert.equal(n.get('a1'), 0);
});

test('好幾份任務一次算，彼此不互相汙染', () => {
  // 這一支存在的理由就是「一次算好幾份」（原本是每份各查一次，
  // 一頁 100 份就是 400 次往返）。分組錯了的話，甲任務的人數
  // 會出現在乙任務上，而兩個數字都看起來很正常。
  const n = countByAssignment(
    [
      { assignmentId: 'a1', classId: 'classA', userId: null },
      { assignmentId: 'a2', classId: 'classB', userId: null },
      { assignmentId: 'a2', classId: null, userId: 's1' },
    ],
    MEMBERS,
    ALL_VALID,
  );
  assert.equal(n.get('a1'), 3);
  assert.equal(n.get('a2'), 3);
});

test('沒有任何派發對象時不會爆', () => {
  assert.equal(countByAssignment([], MEMBERS, ALL_VALID).size, 0);
});
