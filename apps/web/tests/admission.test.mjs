/**
 * 升學管道的制度規則。
 *
 * # 這一支測的是一種沒有症狀、但代價極高的錯誤
 *
 * 資格判定錯了不會當機。畫面上會出現一句「可以報名個人申請」，
 * 學生照著填了六個志願、寫了六份備審、去了三場面試，然後在放榜那天
 * 才知道他從頭到尾就沒有資格。那時已經沒有任何補救——個申的放棄期限
 * 只有四天，而分發入學的報名早就結束了。
 *
 * # 為什麼是完整笛卡兒積而不是抽樣
 *
 * 因為三條規則的**述詞形式各不相同**：
 *
 *   · 繁星對個申用的是「錄取類別」——與有沒有放棄無關
 *   · 繁星第 8 類只封鎖「登記志願序」一個動作
 *   · 所有管道對分發用的是「錄取且未放棄」——放棄後解除
 *
 * 抽樣測試幾乎一定會抽到「錄取且未放棄」那一種形狀（三條裡有兩條
 * 長那樣），然後對「已放棄的第 3 類」給出綠燈——而那恰恰是唯一一種
 * 放棄沒有用的情形。所以這裡跑
 *
 *     特選(錄取×放棄) × 繁星(三類別×放棄) × 個申(錄取×放棄)
 *       = 4 × 6 × 4 = 96 種
 *
 * 再乘上應屆與全程同校的 4 種＝ 384 種，每一種都比對一份**照規格書
 * 原文另外抄一次**的期望值。抄兩次的用意就是不讓測試只是把實作再跑
 * 一遍——兩份都寫錯同一個地方的機率遠低於一份。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACTIONS,
  APPLY_WISH_LIMIT,
  NOT_OFFERED,
  REMEDY,
  SEVERITY,
  STAR_CATEGORIES,
  STAR_GROUP_1_7,
  STAR_GROUP_8,
  STAR_NONE,
  agreesWithPredicates,
  blockersFor,
  canApplyApply,
  canApplySpecial,
  canApplyStar,
  canRegisterApplyPreference,
  canRegisterPlacement,
  categoryOfGroup,
  eligibility,
  normalizeProfile,
  planConflicts,
  remediationAction,
  remediationPlan,
  remediationValue,
} from '../lib/admission.mjs';

// ═════════════════════════════════════════════════════════════════
// 期望值：規格書 §5.2 的第二次轉錄
//
// **刻意不 import 任何實作。** 這幾行是規格書原文的直譯，寫成一份
// 獨立的參考答案。實作那一份若被「簡化」成一個通用的管道封鎖函式，
// 這裡會立刻分家。
// ═════════════════════════════════════════════════════════════════

/** NOT (特選.錄取 AND NOT 特選.已放棄) */
const specialClear = (p) => !(p.specialAdmitted && !p.specialWaived);

const REFERENCE = {
  // 可報名特殊選才 = 恆真（時序最早）
  SPECIAL_APPLY: () => true,

  // 可報名繁星推薦 =
  //     NOT (特選.錄取 AND NOT 特選.已放棄) AND 應屆 AND 全程同校
  STAR_APPLY: (p) => specialClear(p) && !p.isRepeater && p.sameSchoolAll,

  // 可報名個人申請 =
  //     繁星.錄取類別 ≠ 第1-7類  AND  NOT (特選.錄取 AND NOT 特選.已放棄)
  APPLY_APPLY: (p) => p.starCategory !== STAR_GROUP_1_7 && specialClear(p),

  // 可登記個申志願序 = 可報名個人申請 AND 繁星.錄取類別 ≠ 第8類
  APPLY_PREFERENCE: (p) =>
    p.starCategory !== STAR_GROUP_1_7 && specialClear(p) && p.starCategory !== STAR_GROUP_8,

  // 可登記分發入學 =
  //     NOT (特選.錄取 AND NOT 特選.已放棄)
  //     AND NOT (繁星.錄取類別 ≠ 無 AND NOT 繁星.已放棄)
  //     AND NOT (個申.分發錄取 AND NOT 個申.已放棄)
  PLACEMENT_REGISTER: (p) =>
    specialClear(p) &&
    !(p.starCategory !== STAR_NONE && !p.starWaived) &&
    !(p.applyAdmitted && !p.applyWaived),
};

/** 三個管道的錄取狀態 × 已放棄與否 × 繁星的三種類別 = 96 種。 */
function channelStates() {
  const out = [];
  for (const specialAdmitted of [false, true])
    for (const specialWaived of [false, true])
      for (const starCategory of STAR_CATEGORIES)
        for (const starWaived of [false, true])
          for (const applyAdmitted of [false, true])
            for (const applyWaived of [false, true])
              out.push({
                specialAdmitted,
                specialWaived,
                starCategory,
                starWaived,
                applyAdmitted,
                applyWaived,
              });
  return out;
}

/** 再乘上繁星的兩項身分條件 = 384 種。 */
function allProfiles() {
  const out = [];
  for (const s of channelStates())
    for (const isRepeater of [false, true])
      for (const sameSchoolAll of [true, false]) out.push({ ...s, isRepeater, sameSchoolAll });
  return out;
}

const label = (p) =>
  `特選${p.specialAdmitted ? '錄' : '－'}${p.specialWaived ? '棄' : '－'}／` +
  `繁星${p.starCategory}${p.starWaived ? '棄' : '－'}／` +
  `個申${p.applyAdmitted ? '錄' : '－'}${p.applyWaived ? '棄' : '－'}／` +
  `${p.isRepeater ? '非應屆' : '應屆'}${p.sameSchoolAll ? '同校' : '轉學'}`;

// ═════════════════════════════════════════════════════════════════
// §1 笛卡兒積
// ═════════════════════════════════════════════════════════════════

test('笛卡兒積真的是完整的（96 種管道狀態、384 種含身分條件）', () => {
  // 這一條看起來多餘，但它擋的是「有人為了跑快一點把迴圈改成抽樣」。
  // 少掉的那幾種永遠是最少見的，而最少見的正是規則最特別的那幾種。
  assert.equal(channelStates().length, 96);
  assert.equal(allProfiles().length, 384);
  assert.equal(new Set(allProfiles().map(label)).size, 384, '384 種必須兩兩不同');
});

test('五個動作的判定，384 種組合逐一與規格書原文比對', () => {
  for (const p of allProfiles()) {
    for (const a of ACTIONS) {
      const got = blockersFor(a.key, p).length === 0;
      assert.equal(got, REFERENCE[a.key](p), `${a.label}：${label(p)}`);
    }
  }
});

test('述詞版與說明版永遠一致（同一批 384 種）', () => {
  // §3 那五條純述詞是給程式讀的，§4 的 blockersFor 是給人看的。
  // 兩份實作分家的症狀是「畫面說不行但按鈕是亮的」，而那時沒有人
  // 知道該相信哪一邊。
  for (const p of allProfiles()) {
    assert.ok(agreesWithPredicates(p), `述詞與說明不一致：${label(p)}`);
  }
});

test('純述詞五條逐一比對規格書原文', () => {
  for (const p of allProfiles()) {
    const n = normalizeProfile(p);
    assert.equal(canApplySpecial(n), REFERENCE.SPECIAL_APPLY(p), label(p));
    assert.equal(canApplyStar(n), REFERENCE.STAR_APPLY(p), label(p));
    assert.equal(canApplyApply(n), REFERENCE.APPLY_APPLY(p), label(p));
    assert.equal(canRegisterApplyPreference(n), REFERENCE.APPLY_PREFERENCE(p), label(p));
    assert.equal(canRegisterPlacement(n), REFERENCE.PLACEMENT_REGISTER(p), label(p));
  }
});

test('每一個封鎖都說得出「放棄有沒有用」', () => {
  // 只回「不可報名」是不夠的。學生看到那四個字的第一個反應是
  // 「那我放棄繁星不就好了」，而那正是本模組最貴的一個誤解。
  for (const p of allProfiles()) {
    for (const a of ACTIONS) {
      for (const b of blockersFor(a.key, p)) {
        assert.ok(Object.values(REMEDY).includes(b.remedy), `${b.code} 的 remedy 不合法`);
        assert.ok(b.text.length > 10, `${b.code} 沒有寫清楚為什麼`);
      }
    }
  }
});

test('可以做的動作不帶任何原因，不能做的一定至少帶一個', () => {
  for (const p of allProfiles()) {
    for (const e of eligibility(p)) {
      assert.equal(e.ok, e.blockers.length === 0, `${e.label}：${label(p)}`);
    }
  }
});

// ═════════════════════════════════════════════════════════════════
// §2 規格書 §5.5 點名的四個驗收案例
//
// 上面的笛卡兒積已經涵蓋了它們，但它們還是要各自有名字——
// 笛卡兒積失敗時印出來的是一行狀態字串，而這四條印出來的是
// 「放棄之後仍不可報名個申」。後者才看得出是哪一條制度被弄壞了。
// ═════════════════════════════════════════════════════════════════

test('驗收一：繁星第 3 類已錄取「且已放棄」，仍不可報名個人申請', () => {
  // 這一條專門驗證狀態模型沒有在放棄時丟失類別資訊。
  // 若把繁星狀態寫成單一列舉，這位學生會變成「已放棄」而類別消失，
  // 系統就再也分不出他原本是第 3 類還是第 8 類。
  const p = { starCategory: categoryOfGroup(3), starWaived: true };
  assert.equal(categoryOfGroup(3), STAR_GROUP_1_7);
  assert.equal(canApplyApply(normalizeProfile(p)), false);
  assert.equal(canRegisterApplyPreference(normalizeProfile(p)), false);

  const [b] = blockersFor('APPLY_APPLY', p);
  assert.equal(b.code, 'STAR_1_7_ADMITTED');
  assert.equal(b.remedy, REMEDY.NONE, '放棄不是解除方式');
  assert.match(b.text, /就算完成放棄/, '介面上必須說明放棄亦無法恢復資格');

  // 放棄之後分發回得來——三條規則的差異就在這裡。
  assert.equal(canRegisterPlacement(normalizeProfile(p)), true);
});

test('驗收二：繁星第 8 類已錄取，可報名個申並考二階，但不可登記志願序', () => {
  const p = { starCategory: categoryOfGroup(8), starWaived: false };
  assert.equal(categoryOfGroup(8), STAR_GROUP_8);
  assert.equal(canApplyApply(normalizeProfile(p)), true, '報名與第二階段不受封鎖');
  assert.equal(canRegisterApplyPreference(normalizeProfile(p)), false);

  const blockers = blockersFor('APPLY_PREFERENCE', p);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, 'STAR_8_ADMITTED');
  assert.match(blockers[0].text, /仍然可以報名個人申請/);

  // 放棄第 8 類也一樣不能登記志願序（與放棄無關），但分發解除。
  const waived = { starCategory: STAR_GROUP_8, starWaived: true };
  assert.equal(canRegisterApplyPreference(normalizeProfile(waived)), false);
  assert.equal(canRegisterPlacement(normalizeProfile(waived)), true);
});

test('驗收三：個申已分發錄取且未放棄不可登記分發，放棄後恢復', () => {
  const held = { applyAdmitted: true, applyWaived: false };
  assert.equal(canRegisterPlacement(normalizeProfile(held)), false);

  const [b] = blockersFor('PLACEMENT_REGISTER', held);
  assert.equal(b.code, 'APPLY_ADMITTED');
  assert.equal(b.remedy, REMEDY.WAIVE_APPLY);
  assert.match(b.text, /放棄有期限/, '要提示放棄期限與後果');

  const waived = { applyAdmitted: true, applyWaived: true };
  assert.equal(canRegisterPlacement(normalizeProfile(waived)), true, '放棄後資格恢復');
  assert.equal(blockersFor('PLACEMENT_REGISTER', waived).length, 0);
});

test('驗收四：特選已錄取且未放棄，三個後續管道皆不可報名（含繁星）', () => {
  const p = { specialAdmitted: true, specialWaived: false };
  const n = normalizeProfile(p);
  assert.equal(canApplySpecial(), true, '特選自己恆真');
  assert.equal(canApplyStar(n), false, '繁星最常被漏掉的一條');
  assert.equal(canApplyApply(n), false);
  assert.equal(canRegisterApplyPreference(n), false);
  assert.equal(canRegisterPlacement(n), false);

  for (const key of ['STAR_APPLY', 'APPLY_APPLY', 'APPLY_PREFERENCE', 'PLACEMENT_REGISTER']) {
    const codes = blockersFor(key, p).map((b) => b.code);
    assert.ok(codes.includes('SPECIAL_ADMITTED'), `${key} 應該指出特選`);
  }
  assert.match(blockersFor('STAR_APPLY', p)[0].text, /包含繁星推薦在內/);

  // 放棄之後三個都回來。
  const waived = normalizeProfile({ specialAdmitted: true, specialWaived: true });
  assert.equal(canApplyStar(waived), true);
  assert.equal(canApplyApply(waived), true);
  assert.equal(canRegisterPlacement(waived), true);
});

// ═════════════════════════════════════════════════════════════════
// §3 三條規則的形式差異（最容易被「重構」掉的地方）
// ═════════════════════════════════════════════════════════════════

test('繁星對個申看的是類別，放棄完全不影響', () => {
  for (const starWaived of [false, true]) {
    assert.equal(
      canApplyApply(normalizeProfile({ starCategory: STAR_GROUP_1_7, starWaived })),
      false,
      `第 1-7 類 放棄=${starWaived}`,
    );
    assert.equal(
      canApplyApply(normalizeProfile({ starCategory: STAR_GROUP_8, starWaived })),
      true,
      `第 8 類可報名 放棄=${starWaived}`,
    );
  }
});

test('繁星對分發看的是「錄取且未放棄」，放棄後解除', () => {
  for (const cat of [STAR_GROUP_1_7, STAR_GROUP_8]) {
    assert.equal(canRegisterPlacement(normalizeProfile({ starCategory: cat })), false);
    assert.equal(
      canRegisterPlacement(normalizeProfile({ starCategory: cat, starWaived: true })),
      true,
      `${cat} 放棄後分發恢復`,
    );
  }
});

test('第 8 類只封鎖「登記志願序」這一個動作', () => {
  const p = normalizeProfile({ starCategory: STAR_GROUP_8 });
  const ok = eligibility(p).filter((e) => e.ok).map((e) => e.key);
  assert.deepEqual(ok, ['SPECIAL_APPLY', 'STAR_APPLY', 'APPLY_APPLY']);
  // 分發被擋是因為「繁星錄取未放棄」，不是因為第 8 類本身。
  assert.deepEqual(
    blockersFor('PLACEMENT_REGISTER', p).map((b) => b.code),
    ['STAR_ADMITTED'],
  );
});

test('學群 1 至 7 是第 1-7 類、8 是第 8 類、其餘是無', () => {
  for (const g of [1, 2, 3, 4, 5, 6, 7]) assert.equal(categoryOfGroup(g), STAR_GROUP_1_7);
  assert.equal(categoryOfGroup(8), STAR_GROUP_8);
  for (const g of [0, 9, null, undefined, 'x']) assert.equal(categoryOfGroup(g), STAR_NONE);
});

// ═════════════════════════════════════════════════════════════════
// §4 正規化：預設值只有一個地方知道
// ═════════════════════════════════════════════════════════════════

test('sameSchoolAll 的預設是 true，其餘是 false', () => {
  // 這一條擋的是一個很難查的錯：`p.sameSchoolAll === true` 會把
  // 一列還沒填的資料判成「不是全程同校」，於是整批學生的繁星資格
  // 被靜靜關掉，而畫面上只會多一行「不符資格」。
  const d = normalizeProfile({});
  assert.equal(d.sameSchoolAll, true);
  assert.equal(d.isRepeater, false);
  assert.equal(d.specialAdmitted, false);
  assert.equal(d.starCategory, STAR_NONE);
  assert.equal(canApplyStar(d), true, '空白的 profile 不該擋掉繁星');
});

test('不認得的 starCategory 收斂成 NONE，不會漏進判定', () => {
  const n = normalizeProfile({ starCategory: 'GROUP_9' });
  assert.equal(n.starCategory, STAR_NONE);
  assert.equal(canApplyApply(n), true);
});

test('未知的動作要炸掉，不能靜靜回可以', () => {
  assert.throws(() => blockersFor('APPLY_SOMETHING', {}), /未知的升學動作/);
});

// ═════════════════════════════════════════════════════════════════
// §5 規劃階段的不可能組合
// ═════════════════════════════════════════════════════════════════

const wish = (channel, rank, extra = {}) => ({
  id: `${channel}-${rank}`,
  channel,
  rank,
  institutionName: extra.institutionName ?? '臺灣大學',
  programName: extra.programName ?? null,
  starGroup: extra.starGroup ?? null,
});

test('繁星第 3 類加六個個申志願：要說「放棄也無法挽回」', () => {
  const wishes = [
    wish('STAR', 1, { starGroup: 3 }),
    ...[1, 2, 3, 4, 5, 6].map((r) => wish('APPLY', r)),
  ];
  const hit = planConflicts({}, wishes).find((c) => c.code === 'STAR_1_7_KILLS_APPLY');
  assert.ok(hit, '沒有偵測到這個組合');
  assert.equal(hit.severity, SEVERITY.FUTURE);
  assert.match(hit.text, /6 個個申志願將全部失效/);
  assert.match(hit.text, /放棄繁星也無法挽回/);
  assert.equal(hit.wishIds.length, 7);
});

test('繁星第 8 類加個申志願：可報名可考二階，但登記不了', () => {
  const wishes = [wish('STAR', 1, { starGroup: 8 }), wish('APPLY', 1)];
  const codes = planConflicts({}, wishes).map((c) => c.code);
  assert.ok(codes.includes('STAR_8_KILLS_APPLY_PREFERENCE'));
  assert.ok(!codes.includes('STAR_1_7_KILLS_APPLY'), '第 8 類不該套第 1-7 類那一條');
  const hit = planConflicts({}, wishes).find((c) => c.code === 'STAR_8_KILLS_APPLY_PREFERENCE');
  assert.match(hit.text, /仍然可以報名個申/);
});

test('分發志願那一條要說「放棄之後就解除」', () => {
  const wishes = [wish('STAR', 1, { starGroup: 2 }), wish('PLACEMENT', 1)];
  const hit = planConflicts({}, wishes).find((c) => c.code === 'EARLIER_CHANNEL_KILLS_PLACEMENT');
  assert.ok(hit);
  assert.match(hit.text, /放棄之後就解除/);
});

test('依目前狀態已經不成立的志願會被指出來', () => {
  const p = { starCategory: STAR_GROUP_1_7, starWaived: true };
  const hit = planConflicts(p, [wish('APPLY', 1)]).find((c) => c.code === 'ALREADY_BLOCKED_APPLY');
  assert.ok(hit);
  assert.equal(hit.severity, SEVERITY.BLOCK);
  assert.match(hit.text, /個人申請已經不能報名/);
});

test('第 8 類已錄取時：報名沒問題，但要明說「不會被分發到」', () => {
  const p = { starCategory: STAR_GROUP_8 };
  const codes = planConflicts(p, [wish('APPLY', 1)]).map((c) => c.code);
  assert.ok(!codes.includes('ALREADY_BLOCKED_APPLY'), '報名沒被擋，不該說已經不能報名');
  assert.ok(codes.includes('APPLY_PREFERENCE_BLOCKED'));
});

test('繁星填了兩個不同的「大學 × 學群」：後面那個不是備選，是不存在', () => {
  const wishes = [
    wish('STAR', 1, { starGroup: 3 }),
    wish('STAR', 2, { institutionName: '成功大學', starGroup: 3 }),
  ];
  const hit = planConflicts({}, wishes).find((c) => c.code === 'STAR_MULTI_POSITION');
  assert.ok(hit);
  assert.match(hit.text, /不是備選，是不存在/);

  // 同一個位置填兩次不算違規（只是重複），不該報這一條。
  const dup = [wish('STAR', 1, { starGroup: 3 }), wish('STAR', 2, { starGroup: 3 })];
  assert.equal(
    planConflicts({}, dup).some((c) => c.code === 'STAR_MULTI_POSITION'),
    false,
  );
});

test('個申超過 6 個志願會提醒，但系統不替他砍', () => {
  const wishes = [1, 2, 3, 4, 5, 6, 7].map((r) => wish('APPLY', r));
  const hit = planConflicts({}, wishes).find((c) => c.code === 'APPLY_OVER_LIMIT');
  assert.ok(hit);
  assert.equal(APPLY_WISH_LIMIT, 6);
  assert.match(hit.text, /系統不會替你砍掉/);
});

test('特選在清單裡時要說它會封鎖後續全部三個管道', () => {
  const wishes = [wish('SPECIAL', 1), wish('STAR', 1, { starGroup: 1 })];
  const hit = planConflicts({}, wishes).find((c) => c.code === 'SPECIAL_KILLS_EVERYTHING');
  assert.ok(hit);
  assert.match(hit.text, /繁星、個人申請、分發入學/);
});

test('沒有志願、或只有單一管道的志願時，不製造假警報', () => {
  assert.deepEqual(planConflicts({}, []), []);
  assert.deepEqual(planConflicts({}, [wish('APPLY', 1), wish('APPLY', 2)]), []);
  assert.deepEqual(planConflicts({}, [wish('STAR', 1, { starGroup: 4 })]), []);
});

test('偵測到不可能的組合時，回傳的是說明而不是拒絕', () => {
  // 系統不做自動阻擋。這一條釘住的是 API 形狀：planConflicts 永遠
  // 只回一份清單，沒有任何「要不要擋」的欄位可以讓呼叫端去讀。
  const wishes = [wish('STAR', 1, { starGroup: 3 }), wish('APPLY', 1)];
  for (const c of planConflicts({}, wishes)) {
    assert.deepEqual(Object.keys(c).sort(), ['code', 'severity', 'text', 'wishIds']);
    assert.ok(Object.values(SEVERITY).includes(c.severity));
  }
});

// ═════════════════════════════════════════════════════════════════
// §6 明確不做的事
// ═════════════════════════════════════════════════════════════════

test('每一條「不做」都說得出為什麼，而且不是「暫不支援」', () => {
  // 坊間工具給得出落點機率，學生一定會問這裡為什麼沒有。
  // 回答必須是事實（資料取不到），不能是一句敷衍。
  const keys = NOT_OFFERED.map((n) => n.key);
  assert.ok(keys.includes('APPLY_ODDS'));
  assert.ok(keys.includes('GRADE_PREDICTION'));
  assert.ok(keys.includes('SECOND_STAGE'));
  for (const n of NOT_OFFERED) {
    assert.ok(n.title.length > 0 && n.body.length > 30, `${n.key} 的說明太短`);
  }
  assert.match(
    NOT_OFFERED.find((n) => n.key === 'APPLY_ODDS').body,
    /無法合法取得|禁止爬取/,
  );
});

test('繁星那一條要說清楚「校內算得出、全國算不出」', () => {
  const n = NOT_OFFERED.find((x) => x.key === 'STAR_ODDS');
  assert.match(n.body, /只有一個極值資料點/);
  assert.ok(!/有相當把握/.test(n.body));
});

// ═════════════════════════════════════════════════════════════════
// §7 N6 補救清單
// ═════════════════════════════════════════════════════════════════

const kp = (over) => ({
  id: 'kp',
  name: '機率統計',
  subjectId: 'sub',
  subjectName: '數學A',
  mastery: 0.35,
  reliable: true,
  correct: 7,
  total: 20,
  streakWrong: 0,
  gsatWeight: 1,
  ...over,
});

test('補救價值是「還沒學會的部分 × 學測權重」', () => {
  assert.equal(remediationValue({ mastery: 0.35, gsatWeight: 2 }), 1.3);
  assert.equal(remediationValue({ mastery: 1, gsatWeight: 2 }), 0);
  // 沒有權重時當 1 處理，而不是當 0——當 0 會讓它整個從清單裡消失。
  assert.equal(remediationValue({ mastery: 0.5 }), 0.5);
});

test('高權重但已經很穩的知識點，排在低權重但很弱的後面', () => {
  // 直覺會挑權重高的，而那是錯的：0.9 × 權重 2.0 只值 0.2，
  // 0.3 × 權重 1.0 值 0.7。
  const plan = remediationPlan({
    points: [
      kp({ id: 'solid', name: '三角函數', mastery: 0.9, gsatWeight: 2 }),
      kp({ id: 'weak', name: '排列組合', mastery: 0.3, gsatWeight: 1 }),
    ],
  });
  assert.deepEqual(plan.items.map((i) => i.id), ['weak', 'solid']);
});

test('資料不足的知識點不進清單，而且不給掌握度', () => {
  const plan = remediationPlan({
    points: [kp({ id: 'a' }), kp({ id: 'thin', reliable: false, total: 2, correct: 1 })],
  });
  assert.deepEqual(plan.items.map((i) => i.id), ['a']);
  assert.equal(plan.thin.length, 1);
  assert.equal('mastery' in plan.thin[0], false, '兩題算出來的小數不能出現在畫面上');
});

test('清單的每一句都是具體行動，帶得出數字', () => {
  const text = remediationAction(kp({ gsatWeight: 1.8 }));
  assert.match(text, /練「機率統計」/);
  assert.match(text, /20 題錯 13 題/);
  assert.match(text, /掌握度 35%/);
  assert.match(text, /學測權重 1.8/);
  // 不是鼓勵的話。
  assert.ok(!/加油|努力|相信自己/.test(text));
});

test('卡住與前置沒補的兩種情形，講的是不同的下一步', () => {
  const stuck = remediationAction(
    kp({ streakWrong: 3, step: { kind: 'STUCK', prereq: null } }),
  );
  assert.match(stuck, /找老師/);
  assert.match(stuck, /連續錯了 3 題/);

  const prereq = remediationAction(
    kp({ step: { kind: 'PREREQ', prereq: { id: 'p', name: '排列組合' } } }),
  );
  assert.match(prereq, /先補前置「排列組合」/);
  assert.match(prereq, /再回頭練「機率統計」/);
});

test('同分時題數多的排前面', () => {
  const plan = remediationPlan({
    points: [
      kp({ id: 'few', total: 6, correct: 2 }),
      kp({ id: 'many', total: 30, correct: 10 }),
    ],
  });
  assert.deepEqual(plan.items.map((i) => i.id), ['many', 'few']);
});

test('清單有長度上限，但 total 回報的是全部', () => {
  const points = Array.from({ length: 20 }, (_, i) =>
    kp({ id: `k${i}`, mastery: i / 100 }),
  );
  const plan = remediationPlan({ points, limit: 3 });
  assert.equal(plan.items.length, 3);
  assert.equal(plan.total, 20);
});
