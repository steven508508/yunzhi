/**
 * 學測標準科目表與科目欄位的檢查。
 *
 * # 這一支測的是「安裝之後系統開箱即無法使用」的那一格
 *
 * 沒有科目就匯不了題、建不了卷子、開不了知識點——而畫面上沒有任何
 * 地方說得出原因（科目下拉是空的，看起來就像還沒有資料）。
 *
 * 而代碼寫錯的症狀更難查：AI 管線送回 `CHEMISTRY` 的題目對不上任何
 * 一科，匯入畫面上一路都是綠燈，題目落在候選裡沒有人看得到。所以
 * 代碼與 `apps/ai/pipeline/canonical.py` 的 `SubjectCode` 一字不差
 * 這件事要有測試守著。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  STANDARD_CODES,
  STANDARD_SUBJECTS,
  checkParentCode,
  checkSubjectCode,
  checkSubjectName,
  seedStandardSubjects,
} from '../lib/subjects.mjs';
import { GSAT_FULL_SCORE } from '../lib/gsat.mjs';

// ─────────────────────────────────────────────────────────────────
// 一、清單本身
// ─────────────────────────────────────────────────────────────────

test('學測的 13 個科目一個都不少', () => {
  // 少一科的症狀是那一科的老師上傳講義時選不到自己的科目，
  // 他只能選合科，然後他的題目跟別科的混在同一個題庫裡篩不出來。
  assert.equal(STANDARD_SUBJECTS.length, 13);
  assert.deepEqual(
    STANDARD_SUBJECTS.map((s) => s.code).sort(),
    [
      'BIOLOGY',
      'CHEMISTRY',
      'CHINESE',
      'CIVICS',
      'EARTH_SCIENCE',
      'ENGLISH',
      'GEOGRAPHY',
      'HISTORY',
      'MATH_A',
      'MATH_B',
      'PHYSICS',
      'SCIENCE',
      'SOCIAL',
    ].sort(),
  );
});

test('每一個代碼都是 AI 管線認得的 SubjectCode', () => {
  // 這一格對著 apps/ai/pipeline/canonical.py 讀。管線靠代碼分流，
  // 兩邊差一個字母，那一科匯進來的題目會掛在一個網頁端不認得的
  // 科目底下——而匯入的每一個階段都會顯示成功。
  const py = readFileSync(
    new URL('../../ai/pipeline/canonical.py', import.meta.url),
    'utf8',
  );
  const declared = new Set(
    [...py.matchAll(/^\s{4}([A-Z][A-Z0-9_]*)\s*=\s*"([A-Z0-9_]+)"$/gm)].map((m) => m[2]),
  );
  for (const s of STANDARD_SUBJECTS) {
    assert.ok(declared.has(s.code), `管線的 SubjectCode 裡沒有 ${s.code}`);
  }
});

test('分科的上層合科與管線的 PARENT_SUBJECT 一致', () => {
  // 錯的話：學測模擬卷湊不齊分科的題目，而級分換算會查不到滿分
  // ——成績頁上級分那一欄整欄空白，沒有人會想到是科目設定。
  const py = readFileSync(
    new URL('../../ai/pipeline/canonical.py', import.meta.url),
    'utf8',
  );
  const block = py.slice(py.indexOf('PARENT_SUBJECT = {'));
  const pairs = new Map(
    [...block.matchAll(/SubjectCode\.([A-Z_]+):\s*SubjectCode\.([A-Z_]+),/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  assert.equal(pairs.size, 7, '管線的分科對映應該有 7 筆');
  for (const [child, parent] of pairs) {
    const ours = STANDARD_SUBJECTS.find((s) => s.code === child);
    assert.ok(ours, `清單裡沒有分科 ${child}`);
    assert.equal(ours.parentCode, parent, `${child} 的上層對不上管線`);
  }
  // 反方向：我們標了上層的，管線也要標。
  for (const s of STANDARD_SUBJECTS.filter((x) => x.parentCode)) {
    assert.equal(pairs.get(s.code), s.parentCode, `管線沒有把 ${s.code} 標成分科`);
  }
});

test('自然 128、社會 144，其餘 100', () => {
  // 用 100 當預設值的話，社會科全班的得分率會變成 144/100 = 144%，
  // 而級分換算會全部偏高——畫面上不會有任何地方看起來不對。
  for (const [code, score] of Object.entries(GSAT_FULL_SCORE)) {
    const s = STANDARD_SUBJECTS.find((x) => x.code === code);
    assert.ok(s, `清單裡沒有學測考科 ${code}`);
    assert.equal(s.gsatFullScore, score, `${code} 的滿分對不上 lib/gsat.mjs`);
  }
});

test('分科沒有自己的學測滿分', () => {
  // 分科不是獨立考科。給了滿分的話，級分換算會用分科自己的滿分算，
  // 而那個級分沒有任何意義——但它看起來與其他科的級分一模一樣。
  for (const s of STANDARD_SUBJECTS.filter((x) => x.parentCode)) {
    assert.equal(s.gsatFullScore, null, `${s.code} 不該有自己的滿分`);
  }
});

test('每一個分科的上層都是清單裡的合科，而且只有一層', () => {
  // 「化學 → 物理 → 自然」這種鏈會讓級分換算要遞迴，而 lib/gsat.mjs
  // 只看一層——多出來的那一層會安靜地查不到滿分。
  const byCode = new Map(STANDARD_SUBJECTS.map((s) => [s.code, s]));
  for (const s of STANDARD_SUBJECTS.filter((x) => x.parentCode)) {
    const parent = byCode.get(s.parentCode);
    assert.ok(parent, `${s.code} 的上層 ${s.parentCode} 不在清單裡`);
    assert.equal(parent.parentCode, null, `${s.code} 的上層自己也是分科`);
  }
});

test('order 不重複', () => {
  // 重複的話，科目在下拉裡的順序取決於資料庫怎麼排——同一個畫面
  // 在兩次部署之間會換順序，而老師是靠位置在記的。
  const orders = STANDARD_SUBJECTS.map((s) => s.order);
  assert.equal(new Set(orders).size, orders.length);
});

test('STANDARD_CODES 與清單一致', () => {
  assert.equal(STANDARD_CODES.size, STANDARD_SUBJECTS.length);
  for (const s of STANDARD_SUBJECTS) assert.ok(STANDARD_CODES.has(s.code));
});

// ─────────────────────────────────────────────────────────────────
// 二、開機種子的冪等
// ─────────────────────────────────────────────────────────────────

/** 只認得 subject.findMany 與 subject.create 的最小假 client。 */
function fakeDb() {
  const rows = [];
  return {
    rows,
    subject: {
      findMany: async ({ where }) =>
        rows.filter((r) => r.tenantId === where.tenantId).map((r) => ({ code: r.code })),
      create: async ({ data }) => {
        if (rows.some((r) => r.tenantId === data.tenantId && r.code === data.code)) {
          // 真的資料庫有 @@unique([tenantId, code])，假的也要有——
          // 否則「跑第二次會不會變成 26 筆」這一格測不到重點。
          throw new Error(`唯一鍵衝突：${data.code}`);
        }
        rows.push({ ...data });
        return data;
      },
    },
  };
}

test('種子跑一次建出 13 個科目', () => {
  // 少了這一段，系統裝起來一個科目都沒有——匯不了題、建不了卷子，
  // 而畫面上只是幾個空的下拉選單。
  const db = fakeDb();
  return seedStandardSubjects(db, 'tenant-1').then((r) => {
    assert.equal(r.created.length, 13);
    assert.equal(db.rows.length, 13);
    assert.equal(db.rows.filter((x) => x.tenantId === 'tenant-1').length, 13);
  });
});

test('種子跑第二次不會變成 26 個', async () => {
  // 升級部署會重跑 migrate-and-seed。不冪等的話，第二次啟動之後
  // 每一個科目下拉都會出現兩份一模一樣的選項，而老師挑到哪一個
  // 決定了他的題目落在哪一科。
  const db = fakeDb();
  await seedStandardSubjects(db, 'tenant-1');
  const again = await seedStandardSubjects(db, 'tenant-1');
  assert.equal(again.created.length, 0);
  assert.equal(again.existing, 13);
  assert.equal(db.rows.length, 13);
});

test('種子不會覆蓋管理員改過的科目名稱', async () => {
  // 用 upsert 寫的話，補習班把「公民」改成「公民與社會」之後，
  // 下一次升級部署就會把它改回去——一個沒有人按過的變更，
  // 出現在重啟之後，看起來像資料庫壞了。
  const db = fakeDb();
  await seedStandardSubjects(db, 'tenant-1');
  const civics = db.rows.find((r) => r.code === 'CIVICS');
  civics.name = '公民與社會';
  await seedStandardSubjects(db, 'tenant-1');
  assert.equal(db.rows.find((r) => r.code === 'CIVICS').name, '公民與社會');
});

test('缺了幾科時只補缺的那幾科', async () => {
  // 手動刪過、或上一次種子跑到一半掛掉。補的時候要接得下去，
  // 而不是整批失敗（createMany 的行為）——那會讓一個少了三科的
  // 系統永遠補不齊。
  const db = fakeDb();
  await seedStandardSubjects(db, 'tenant-1');
  const gone = ['PHYSICS', 'CIVICS'];
  for (const code of gone) {
    db.rows.splice(db.rows.findIndex((r) => r.code === code), 1);
  }
  const r = await seedStandardSubjects(db, 'tenant-1');
  assert.deepEqual(r.created.sort(), gone.sort());
  assert.equal(db.rows.length, 13);
});

test('不同租戶各自有一份', async () => {
  // 種子沒有帶 tenantId 的話，第二個租戶會被判定成「已經有科目了」
  // 而一科都拿不到——白牌授權給第二家時才會發現。
  const db = fakeDb();
  await seedStandardSubjects(db, 'tenant-1');
  const r = await seedStandardSubjects(db, 'tenant-2');
  assert.equal(r.created.length, 13);
  assert.equal(db.rows.length, 26);
});

// ─────────────────────────────────────────────────────────────────
// 三、新增科目的欄位檢查
// ─────────────────────────────────────────────────────────────────

test('代碼一定要是大寫英數與底線', () => {
  // 允許小寫的話，MATH_A 與 math_a 會變成兩個科目，而匯入的題目
  // 落在其中一個、老師在另一個裡面找。
  for (const bad of ['', 'a', 'math_a', '數學', 'MATH-A', 'MATH A', '1MATH']) {
    assert.ok(checkSubjectCode(bad), `${JSON.stringify(bad)} 竟然是合法代碼`);
  }
  for (const good of ['MATH_A', 'SCIENCE', 'COMPOSITION', 'ENG2']) {
    assert.equal(checkSubjectCode(good), null, `${good} 應該是合法代碼`);
  }
});

test('代碼撞到既有的就擋住', () => {
  const problem = checkSubjectCode('SCIENCE', new Set(['SCIENCE']));
  assert.ok(problem);
  assert.match(problem, /已經有/);
});

test('名稱不能空白、不能過長', () => {
  assert.ok(checkSubjectName('   '));
  assert.ok(checkSubjectName('科'.repeat(31)));
  assert.equal(checkSubjectName('作文班'), null);
});

test('上層合科要存在，而且自己不能是分科', () => {
  // 指到不存在的代碼：級分換算查不到滿分，成績頁的級分欄整欄空白。
  // 指到另一個分科：級分換算要遞迴，而 lib/gsat.mjs 只看一層。
  const known = new Map([
    ['SCIENCE', null],
    ['CHEMISTRY', 'SCIENCE'],
  ]);
  assert.equal(checkParentCode('', known), null, '留空代表它自己是合科');
  assert.equal(checkParentCode(null, known), null);
  assert.equal(checkParentCode('SCIENCE', known), null);
  assert.ok(checkParentCode('NOPE', known), '不存在的上層竟然通過了');
  assert.ok(checkParentCode('CHEMISTRY', known), '分科竟然可以當上層');
});
