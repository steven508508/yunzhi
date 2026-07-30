/**
 * 學生自己查來的升學參考資料：信任度、過期、隔離，以及查資料指引。
 *
 * # 這一支裡最重要的是 §3
 *
 * 「學生自己輸入的在校百分比不進入校內賽局模擬」——這一條的失效方式
 * 是本模組最惡劣的一種：**受害的人不是打錯字的那一位。** 甲同學把自己
 * 的百分比打錯成 5%，乙同學打開頁面看到自己從第 1 位掉到第 2 位，
 * 而畫面上一切正常，沒有任何錯誤訊息，乙也沒有任何辦法知道那個數字
 * 是別人手打的。
 *
 * 所以那一組測試不是斷言「函式回了正確的東西」，而是**跑兩次模擬並
 * 比對其他學生的序位一個字都沒變**。那條斷言就是這個決定的護欄。
 *
 * # 網址那一組測的是一種安靜的過期
 *
 * 篩選標準一覽表的路徑是每年重新產生的亂碼（文件 07 §3.5）。寫死一個
 * 深連結的話，今年可以用、明年變成 404——而**畫面上仍然有一個看起來
 * 完全正常的連結**。所以有一條測試比對「回傳值裡不含任何路徑片段」，
 * 它擋的是有人日後為了方便把那串亂碼貼進來。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REF_KINDS,
  SOURCE_KINDS,
  TRUST_SOLID,
  TRUST_WEAK,
  TRUST_WORKABLE,
  adviceBasis,
  buildRefValue,
  describeRefValue,
  numbersIn,
  refKindOf,
  sourceTrustOf,
  stalenessOf,
  starParticipants,
  trustOf,
} from '../lib/admissionRef.mjs';
import {
  CAC_PORTAL,
  CEEC,
  JBCRC_CALENDAR,
  URL_DERIVED,
  URL_FIXED,
  URL_NONE,
  schoolOfficeOnly,
  sieveStandardGuide,
  sourceChecklist,
  starCircularUrl,
  whereToLookFor,
} from '../lib/admissionSources.mjs';
import {
  THRESHOLD_BASIS_NOTE,
  TWO_LAYER_NOTE,
  sameInstitution,
  simulate,
  studentView,
  withNationalThresholds,
} from '../lib/star.mjs';

const NOW = new Date('2026-03-10T00:00:00.000Z');

// ═════════════════════════════════════════════════════════════════
// §1 來源
// ═════════════════════════════════════════════════════════════════

test('「聽同學說的」是一個可以誠實選的選項', () => {
  // 不給這個選項的話，學生會選「官方文件」——他手上就是有一個數字，
  // 而選單裡沒有一個選項描述得出它的來歷。那筆資料從此帶著一個假的
  // 可信度，而且再也分不出來。
  const hearsay = SOURCE_KINDS.find((s) => s.value === 'HEARSAY');
  assert.ok(hearsay, '沒有 HEARSAY 這個選項');
  assert.equal(hearsay.trust, 0);
  // 標籤要像一件正常的事，不是「不可靠來源」這種讓人不想選的字。
  assert.match(hearsay.label, /聽同學說的/);
  assert.match(hearsay.hint, /可以選的選項/);
});

test('五種來源都在，而且認不出來的一律當成最低分', () => {
  assert.equal(SOURCE_KINDS.length, 5);
  assert.equal(sourceTrustOf('OFFICIAL_DOC').trust, 3);
  assert.equal(sourceTrustOf('SCHOOL_OFFICE').trust, 3);
  assert.equal(sourceTrustOf('CRAM_TEACHER').trust, 2);
  assert.equal(sourceTrustOf('STUDENT_NOTE').trust, 1);
  assert.equal(sourceTrustOf('HEARSAY').trust, 0);
  // 新增一種來源而忘記加進清單時，它要被當成「不知道哪來的」，
  // 不是靜靜給它一個中間值。
  assert.equal(sourceTrustOf('SOMETHING_NEW').trust, 0);
  assert.equal(sourceTrustOf(undefined).label, '來源不明');
});

// ═════════════════════════════════════════════════════════════════
// §2 過期與信任度
// ═════════════════════════════════════════════════════════════════

const ref = (over = {}) => ({
  year: 115,
  staleAfterYear: 115,
  sourceKind: 'OFFICIAL_DOC',
  lookedUpAt: '2026-03-05T00:00:00.000Z',
  ...over,
});

test('學年度過了就標成過期，但資料不會被丟掉', () => {
  const s = stalenessOf(ref({ year: 113, staleAfterYear: 113 }), { currentYear: 115, now: NOW });
  assert.equal(s.stale, true);
  assert.equal(s.staleBy, 2);

  const t = trustOf(ref({ year: 113, staleAfterYear: 113 }), { currentYear: 115, now: NOW });
  // 官方文件 + 過期兩年 → 降一級，不是歸零。歷年趨勢是繁星唯一可用的
  // 東西，去年的門檻仍然有意義，只是不能當成今年的。
  assert.equal(t.level, TRUST_WORKABLE);
  assert.ok(
    t.notes.some((n) => /113 學年度的資料.*115 學年度/.test(n)),
    '過期的說明要把兩個學年度都講出來',
  );
});

test('同一個學年度、剛查的官方文件是最高一級', () => {
  const t = trustOf(ref(), { currentYear: 115, now: NOW });
  assert.equal(t.level, TRUST_SOLID);
  assert.equal(t.stale, false);
  assert.equal(t.old, false);
  assert.deepEqual(t.notes, []);
});

test('查了超過一年沒再確認也降一級', () => {
  const t = trustOf(ref({ lookedUpAt: '2024-09-01T00:00:00.000Z' }), {
    currentYear: 115,
    now: NOW,
  });
  assert.equal(t.old, true);
  assert.equal(t.level, TRUST_WORKABLE);
  assert.ok(t.notes.some((n) => /天前查的/.test(n)));
});

test('聽同學說的永遠只是線索，不管多新', () => {
  const t = trustOf(ref({ sourceKind: 'HEARSAY' }), { currentYear: 115, now: NOW });
  assert.equal(t.level, TRUST_WEAK);
  assert.equal(t.stale, false);
  assert.ok(t.notes.some((n) => /聽說的/.test(n)));
});

test('兩個扣分同時發生時不會掉到 WEAK 以下', () => {
  const t = trustOf(
    ref({
      year: 112,
      staleAfterYear: 112,
      sourceKind: 'HEARSAY',
      lookedUpAt: '2023-01-01T00:00:00.000Z',
    }),
    { currentYear: 115, now: NOW },
  );
  assert.equal(t.level, TRUST_WEAK);
  assert.equal(t.notes.length, 3, '三個理由都要說出來');
});

test('沒有查詢日期時不當機（schema 不允許，但別炸）', () => {
  const s = stalenessOf({ year: 115, staleAfterYear: 115 }, { currentYear: 115, now: NOW });
  assert.equal(s.ageDays, null);
  assert.equal(s.old, false);
});

// ═════════════════════════════════════════════════════════════════
// §2.5 value 的形狀
// ═════════════════════════════════════════════════════════════════

test('百分比讀得懂全形與百分號，但擋得住 PR 值', () => {
  assert.deepEqual(buildRefValue('STAR_ROUND1', { percentile: '15.2%' }).value, { percentile: 15.2 });
  assert.deepEqual(buildRefValue('STAR_ROUND1', { percentile: '１５．２' }).value, {
    percentile: 15.2,
  });
  // PR 90 是很好，在校百分比 90 是很差，而系統看不出使用者填的是哪一種。
  const bad = buildRefValue('MY_PERCENTILE', { percentile: '120' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /PR 值/);
});

test('篩選門檻的科目與級分數量對不上會被擋', () => {
  const ok = buildRefValue('SIEVE_THRESHOLD', { subjects: '國文、英文', grades: '13、12' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { subjects: ['國文', '英文'], grades: [13, 12] });
  const bad = buildRefValue('SIEVE_THRESHOLD', { subjects: '國文、英文、數學A', grades: '13、12' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /數量對不上/);
});

test('每一種 kind 都描述得出來，也數得出裡面有哪些數字', () => {
  assert.equal(describeRefValue('STAR_ROUND1', { percentile: 18 }), '18%');
  assert.equal(describeRefValue('STAR_VACANCY', { count: 3 }), '3 名');
  assert.equal(
    describeRefValue('SIEVE_THRESHOLD', { subjects: ['國文'], grades: [13] }),
    '國文 13 級分',
  );
  // 自由文字裡的數字也要算進來——學生把「前 20%」寫在門檻那一欄時，
  // 建議提到 20% 是有來源的，不該被閘門當成編的。
  assert.deepEqual(numbersIn('QUALIFY', { rules: '在校前 20%、數A均標' }), ['20']);
  for (const k of REF_KINDS) {
    assert.ok(refKindOf(k.value), `${k.value} 查不回來`);
  }
});

test('自己的在校百分比被標成 selfOnly', () => {
  // 這個旗標是介面上那句「只用於你自己的建議」的來源。
  assert.equal(refKindOf('MY_PERCENTILE').selfOnly, true);
  assert.notEqual(refKindOf('STAR_ROUND1').selfOnly, true);
});

// ═════════════════════════════════════════════════════════════════
// §3 隔離：學生自己輸入的百分比不進入模擬
//
// **這一節是整支測試的重點。** 受害者不是打錯字的那一位。
// ═════════════════════════════════════════════════════════════════

/** 四位學生擠同一個位置，教務處匯了三位的百分比。 */
const WISHES = [
  { userId: 'u1', institutionName: '臺灣大學', starGroup: 2, wishRank: 1 },
  { userId: 'u2', institutionName: '臺灣大學', starGroup: 2, wishRank: 1 },
  { userId: 'u3', institutionName: '臺灣大學', starGroup: 2, wishRank: 1 },
  { userId: 'u4', institutionName: '臺灣大學', starGroup: 2, wishRank: 1 },
];
const OFFICIAL = [
  { userId: 'u1', percentile: 10 },
  { userId: 'u2', percentile: 20 },
  { userId: 'u3', percentile: 30 },
  // u4 教務處還沒匯。
];

/** u4 自己輸入了一個好到不合理的百分比。 */
const SELF_ENTERED = [
  { userId: 'u4', kind: 'MY_PERCENTILE', value: { percentile: 1 }, forSelfOnly: true },
];

const ordersOf = (sim) =>
  Object.fromEntries(sim.positions[0].entries.map((e) => [e.userId, e.order]));

test('★ 學生自己輸入的百分比不進入 simulate()', () => {
  const a = starParticipants({ wishes: WISHES, officialRanks: OFFICIAL, references: [] });
  const b = starParticipants({
    wishes: WISHES,
    officialRanks: OFFICIAL,
    references: SELF_ENTERED,
  });
  // 參賽名單一模一樣。u4 的百分比是 null，不是他自填的 1。
  assert.deepEqual(b.participants, a.participants);
  assert.equal(b.participants.find((p) => p.userId === 'u4').percentile, null);
});

test('★ 學生自己輸入的百分比不影響其他學生的序位', () => {
  const clean = simulate({
    participants: starParticipants({ wishes: WISHES, officialRanks: OFFICIAL }).participants,
    now: NOW,
  });
  const dirty = simulate({
    participants: starParticipants({
      wishes: WISHES,
      officialRanks: OFFICIAL,
      references: SELF_ENTERED,
    }).participants,
    now: NOW,
  });

  // u4 自填 1%（比誰都好）。若那個數字進得了模擬，u1 就會從第 1 掉到
  // 第 2——而 u1 打開頁面只會看到一個完全正常的「第 2 位」。
  assert.deepEqual(ordersOf(dirty), ordersOf(clean));
  assert.deepEqual(ordersOf(clean), { u1: 1, u2: 2, u3: 3 });
  assert.equal(studentView(dirty, 'u1').positions[0].order, 1);
  assert.equal(studentView(clean, 'u1').positions[0].order, 1);
});

test('★ 沒有官方百分比的學生落在 unranked，不是排最後', () => {
  const sim = simulate({
    participants: starParticipants({
      wishes: WISHES,
      officialRanks: OFFICIAL,
      references: SELF_ENTERED,
    }).participants,
    now: NOW,
  });
  // 「你排最後」是一個假結論，而真正的問題是承辦人少匯了一列。
  assert.deepEqual(
    sim.unranked.map((u) => u.userId),
    ['u4'],
  );
  assert.equal(studentView(sim, 'u4').unranked, true);
  assert.equal(studentView(sim, 'u4').positions.length, 0);
});

test('被忽略的自填百分比要報出來，而且說得出為什麼', () => {
  // 不說的話，學生填了之後看到序位沒變，會以為系統壞了然後再填一次。
  const { ignoredSelfEntered } = starParticipants({
    wishes: WISHES,
    officialRanks: OFFICIAL,
    references: SELF_ENTERED,
  });
  assert.equal(ignoredSelfEntered.length, 1);
  assert.equal(ignoredSelfEntered[0].userId, 'u4');
  assert.equal(ignoredSelfEntered[0].percentile, 1);
  assert.match(ignoredSelfEntered[0].reason, /不進入校內賽局模擬/);
  assert.match(ignoredSelfEntered[0].reason, /教務處/);
});

test('連 forSelfOnly=false 的自填百分比也不進模擬', () => {
  // 輔導老師代為輸入的校系資料可以是 false（那是全國的門檻，不是某位
  // 學生的成績），但「某位學生的在校百分比」永遠只有教務處那一份算得數。
  // 這一條是防止有人日後為了讓某個情境跑得動而把旗標翻掉。
  const { participants, ignoredSelfEntered } = starParticipants({
    wishes: WISHES,
    officialRanks: OFFICIAL,
    references: [
      { userId: 'u4', kind: 'MY_PERCENTILE', value: { percentile: 1 }, forSelfOnly: false },
    ],
  });
  assert.equal(participants.find((p) => p.userId === 'u4').percentile, null);
  assert.equal(ignoredSelfEntered.length, 1);
});

test('教務處匯入的百分比照樣進得去（隔離不是把功能關掉）', () => {
  const { participants } = starParticipants({
    wishes: WISHES,
    officialRanks: [...OFFICIAL, { userId: 'u4', percentile: 40 }],
    references: SELF_ENTERED,
  });
  assert.equal(participants.find((p) => p.userId === 'u4').percentile, 40, '教務處那一份要用');
});

// ═════════════════════════════════════════════════════════════════
// §4 建議的資料基礎：缺什麼要說得出來
// ═════════════════════════════════════════════════════════════════

const threshold = (over = {}) => ({
  year: 114,
  kind: 'STAR_ROUND1',
  kindLabel: '繁星第一輪錄取標準',
  institutionName: '臺灣大學',
  starGroup: 2,
  value: { percentile: 18 },
  describe: '18%',
  sourceKind: 'OFFICIAL_DOC',
  sourceRef: 'x',
  lookedUpAt: '2026-03-05T00:00:00.000Z',
  staleAfterYear: 115,
  ...over,
});

const STAR_WISH = [{ channel: 'STAR', institutionName: '臺灣大學', starGroup: 2, rank: 1 }];

test('填了繁星志願但沒有任何門檻資料 → 說出來，不要硬給結論', () => {
  const b = adviceBasis({ year: 115, wishes: STAR_WISH, references: [], now: NOW });
  const codes = b.gaps.map((g) => g.code);
  assert.ok(codes.includes('NO_THRESHOLD'));
  assert.ok(codes.includes('NO_OWN_PERCENTILE'));
  assert.equal(b.gaps.find((g) => g.code === 'NO_THRESHOLD').lookFor, 'STAR_ROUND1');
});

test('只查到一年 → 建議把前兩年也查一下，而且把年份算出來', () => {
  const b = adviceBasis({
    year: 115,
    officialPercentile: 12,
    wishes: STAR_WISH,
    references: [threshold()],
    now: NOW,
  });
  const gap = b.gaps.find((g) => g.code === 'ONE_YEAR_ONLY');
  assert.ok(gap, '沒有偵測到「只有一年」');
  assert.match(gap.text, /113 與 112/, '要算得出是哪兩年，不要說「前幾年」');
  assert.match(gap.text, /一年看不出趨勢/);
});

test('查到兩年也還要再補一年', () => {
  const b = adviceBasis({
    year: 115,
    officialPercentile: 12,
    wishes: STAR_WISH,
    references: [threshold({ year: 114 }), threshold({ year: 113 })],
    now: NOW,
  });
  assert.ok(b.gaps.some((g) => g.code === 'TWO_YEARS_ONLY'));
  assert.deepEqual(b.yearsWithThreshold, [114, 113]);
});

test('三年都有就不再催了', () => {
  const b = adviceBasis({
    year: 115,
    officialPercentile: 12,
    wishes: STAR_WISH,
    references: [threshold({ year: 114 }), threshold({ year: 113 }), threshold({ year: 112 })],
    now: NOW,
  });
  assert.deepEqual(b.gaps, []);
  assert.equal(b.thresholds.length, 3);
  // 閘門的白名單要含門檻與教務處那個百分比。三年的門檻都是 18，
  // 所以去重之後只有一個。
  assert.deepEqual(b.numbers, ['18', '12']);
});

test('全部只能當線索時要說出來', () => {
  const b = adviceBasis({
    year: 115,
    officialPercentile: 12,
    wishes: STAR_WISH,
    references: [
      threshold({ year: 114, sourceKind: 'HEARSAY' }),
      threshold({ year: 113, sourceKind: 'HEARSAY' }),
      threshold({ year: 112, sourceKind: 'HEARSAY' }),
    ],
    now: NOW,
  });
  assert.ok(b.gaps.some((g) => g.code === 'ALL_WEAK'));
  assert.equal(b.hasOfficialDoc, false);
});

test('兩個百分比分得開：教務處那一份與自己填的', () => {
  // 合成一個欄位的話，遲早有人拿自填的那個去講校內序位——而校內序位
  // 只能由教務處那一份算出來。
  const b = adviceBasis({
    year: 115,
    officialPercentile: 12,
    wishes: STAR_WISH,
    references: [
      threshold(),
      {
        ...threshold(),
        kind: 'MY_PERCENTILE',
        kindLabel: '我自己的在校百分比',
        value: { percentile: 13 },
        describe: '13%',
        sourceKind: 'SCHOOL_OFFICE',
      },
    ],
    now: NOW,
  });
  assert.equal(b.officialPercentile, 12);
  assert.equal(b.selfPercentile, 13);
  // MY_PERCENTILE 不是門檻，不進 thresholds。
  assert.equal(b.thresholds.length, 1);
});

// ═════════════════════════════════════════════════════════════════
// §5 網址：兩種性質，兩種處理方式
// ═════════════════════════════════════════════════════════════════

test('推得出來的那一種：star + 民國年', () => {
  assert.equal(starCircularUrl(115).url, 'https://www.cac.edu.tw/star115/index.php');
  assert.equal(starCircularUrl(116).url, 'https://www.cac.edu.tw/star116/index.php');
  assert.equal(starCircularUrl(114).urlKind, URL_DERIVED);
});

test('推出來的網址一定帶著「打不開就從首頁進去」', () => {
  // 網址會變，而**一個死連結比沒有連結更讓人卡住**：學生點下去看到 404，
  // 他的結論是「這個系統壞了」而不是「我該從首頁進去找」。
  const u = starCircularUrl(115);
  assert.match(u.caution, /依學年度推出來的/);
  assert.match(u.caution, /打不開就從委員會首頁進去找/);
  assert.equal(u.fallback, CAC_PORTAL);
  assert.ok(u.fallbackLabel);
});

test('學年度不是民國年時不組網址，而且說得出原因', () => {
  // 組出 `star2026` 的話，學生點下去是 404，而他不會知道問題出在
  // 系統把西元年填進來了。
  for (const bad of [2026, 0, -1, NaN, 99, 201, '一一五']) {
    const u = starCircularUrl(bad);
    assert.equal(u.url, null, `${bad} 竟然組出了網址`);
    assert.equal(u.urlKind, URL_NONE);
    assert.equal(u.fallback, CAC_PORTAL);
    assert.match(u.caution, /民國學年度/);
  }
});

test('★ 推不出來的那一種絕對不會被組出一個假的深連結', () => {
  // 篩選標準一覽表的路徑是每年重新產生的亂碼（文件 07 §3.5：111 學年度
  // 起無穩定網址）。寫死一個深連結的代價是它在下一個學年度變成 404，
  // 而畫面上仍然有一個看起來完全正常的連結。
  const g = sieveStandardGuide();
  assert.equal(g.url, CAC_PORTAL, '只能給入口');
  assert.equal(g.urlKind, URL_NONE);
  assert.ok(Array.isArray(g.navigation) && g.navigation.length >= 2, '要給導覽步驟');
  assert.match(g.caution, /推不出來/);

  // 整個回傳值裡不可以出現任何路徑片段。這一條擋的是有人日後為了方便
  // 把那串亂碼貼進來。
  const json = JSON.stringify(g);
  for (const fragment of [
    'CacLink',
    'apply114',
    'apply115',
    'collegeList',
    'html_sieve',
    'SieVe',
    'Standard/',
    '.htm',
  ]) {
    assert.ok(!json.includes(fragment), `出現了路徑片段「${fragment}」`);
  }
  // 一覽表的網址不可以看起來像被推導出來的（例如 /apply116/）。
  assert.ok(!/apply\d+/.test(json), '組出了一個依學年度推導的深連結');
});

test('★ 整份清單裡沒有任何依學年度推導的深連結，只有 star{年} 那一個', () => {
  // star{年} 是唯一一個形狀穩定、推得出來的（而且它仍然帶著 caution）。
  // 其他任何 `xxx{年}/...` 的深連結都是猜的。
  for (const y of [114, 115, 116, 117]) {
    for (const step of sourceChecklist(y)) {
      for (const w of step.where) {
        if (!w.url) continue;
        if (w.urlKind === 'DERIVED') {
          assert.equal(w.url, `https://www.cac.edu.tw/star${y}/index.php`);
          continue;
        }
        assert.ok(
          [CAC_PORTAL, CEEC, JBCRC_CALENDAR].includes(w.url),
          `${step.key} 有一個既不是推導也不是查證過的網址：${w.url}`,
        );
        assert.ok(!new RegExp(`${y}`).test(new URL(w.url).pathname), '固定網址裡不該有學年度');
      }
    }
  }
});

test('網路上查不到的那一項要明確說出來，而且 url 是 null', () => {
  // 收在別的地方或乾脆不寫的後果是學生在網路上找一整晚——他不會想到
  // 「這個數字只有教務處有」，因為其他每一項都查得到。
  const o = schoolOfficeOnly();
  assert.equal(o.url, null);
  assert.equal(o.urlKind, URL_NONE);
  assert.match(o.caution, /網路上查不到/);
  assert.match(o.label, /教務處/);

  const step = sourceChecklist(115).find((s) => s.key === 'SCHOOL_RULES');
  assert.ok(step, '校內百分比那一步不見了');
  assert.equal(step.where[0].url, null);
});

// ═════════════════════════════════════════════════════════════════
// §6 清單本身
// ═════════════════════════════════════════════════════════════════

test('清單照繁星的實際時序排，而不是照系統結構排', () => {
  const steps = sourceChecklist(115);
  assert.deepEqual(
    steps.map((s) => s.key),
    ['CIRCULAR', 'SCHOOL_RULES', 'GSAT_STATS', 'STAR_ROUND1', 'STAR_VACANCY', 'SIEVE', 'CALENDAR'],
  );
  // 每一步都要說得出「什麼時候」。學生打開這一頁的理由是不知道現在
  // 該做什麼，而照系統結構排（校系資料／成績資料／校內資料）答不了那件事。
  for (const s of steps) {
    assert.ok(s.when && s.when.length > 2, `${s.key} 沒有時序`);
    assert.ok(s.title && s.what, `${s.key} 沒有說要查什麼`);
    assert.ok(s.where.length >= 1, `${s.key} 沒有說去哪裡查`);
    assert.ok(s.recordHint && s.recordHint.length > 10, `${s.key} 沒有說查到之後要做什麼`);
  }
});

test('每一步都說得出「查到之後輸入到哪裡」', () => {
  // 漏掉這一件的後果是這一頁變成一份書籤清單：學生查完了、記在紙上，
  // 系統這一側什麼都沒有，AI 老師也就沒有東西可以給建議。
  const steps = sourceChecklist(115);
  const recorded = steps.filter((s) => s.recordAs);
  assert.ok(recorded.length >= 5, '太多步驟不必輸入了，這一頁會變成書籤列');
  for (const s of recorded) {
    assert.ok(refKindOf(s.recordAs.kind), `${s.key} 對到一個不存在的 kind：${s.recordAs.kind}`);
  }
  // 行事曆那一步刻意不必輸入——系統不會替他設鬧鐘。
  assert.equal(steps.find((s) => s.key === 'CALENDAR').recordAs, null);
});

test('由 kind 反查得回「這一項去哪裡查」', () => {
  // 沒有這條反查，指引與輸入會變成畫面上兩個不相干的區塊。
  const g = whereToLookFor('STAR_ROUND1', 115);
  assert.ok(g);
  assert.equal(g.key, 'STAR_ROUND1');
  assert.equal(g.where[0].url, 'https://www.cac.edu.tw/star115/index.php');

  const own = whereToLookFor('MY_PERCENTILE', 115);
  assert.equal(own.where[0].url, null, '在校百分比查不到，這一項不能給網址');

  assert.equal(whereToLookFor('NOT_A_KIND', 115), null);
});

test('繁星第一輪那一步要講「最後一名」而不是平均', () => {
  // 這是整個模組最容易被誤讀的一件事，而它決定了建議能不能誠實。
  const step = sourceChecklist(115).find((s) => s.key === 'STAR_ROUND1');
  assert.match(step.what, /最後一名/);
  assert.match(step.what, /1 至 3 名/);
  assert.match(step.what, /極值資料點/);
  assert.match(step.what, /112、113、114|112|113/);
});

// ═════════════════════════════════════════════════════════════════
// §7 兩層競爭放在同一個位置上
//
// 校內排第幾（系統數得出來）＋ 該校系去年門檻（學生查來的）。
// 分開放的話，學生會以為「我的百分比比門檻好」就等於會上，
// 完全沒有意識到校內還有兩個人排在他前面。
// ═════════════════════════════════════════════════════════════════

function myView() {
  const sim = simulate({
    participants: starParticipants({ wishes: WISHES, officialRanks: OFFICIAL }).participants,
    now: NOW,
  });
  return studentView(sim, 'u3'); // u3 是校內第 3 位，推薦名單之外
}

test('兩層都在同一個位置物件上', () => {
  const view = withNationalThresholds(myView(), [
    { institutionName: '臺灣大學', starGroup: 2, year: 114, kind: 'STAR_ROUND1', describe: '18%', value: { percentile: 18 } },
    { institutionName: '臺灣大學', starGroup: 2, year: 113, kind: 'STAR_ROUND1', describe: '15%', value: { percentile: 15 } },
  ]);
  const p = view.positions[0];
  // 第一層：系統算的。
  assert.equal(p.order, 3);
  assert.equal(p.nominated, false);
  // 第二層：學生查的，新的年份排前面。
  assert.deepEqual(
    p.nationalThresholds.map((t) => [t.year, t.percentile]),
    [
      [114, 18],
      [113, 15],
    ],
  );
  assert.equal(p.twoLayerNote, TWO_LAYER_NOTE);
  assert.equal(p.thresholdBasisNote, THRESHOLD_BASIS_NOTE);
});

test('擴充不會動到既有的欄位（那 39 項測試靠它們）', () => {
  const before = myView();
  const after = withNationalThresholds(before, []);
  for (const key of Object.keys(before.positions[0])) {
    assert.deepEqual(after.positions[0][key], before.positions[0][key], `${key} 被改掉了`);
  }
  assert.equal(after.computedAt, before.computedAt);
  assert.equal(after.unranked, before.unranked);
});

test('還沒查的位置是空陣列，而且不假裝有門檻', () => {
  const view = withNationalThresholds(myView(), []);
  assert.deepEqual(view.positions[0].nationalThresholds, []);
  assert.equal(view.positions[0].thresholdBasisNote, null, '沒有數字就不必解釋數字');
  // 但兩層的說明還是要在——他要知道「第二層要自己去查」。
  assert.equal(view.positions[0].twoLayerNote, TWO_LAYER_NOTE);
});

test('臺／台 折得起來，但「台大」不會被猜成「臺灣大學」', () => {
  // 猜對了省一次輸入，猜錯了把甲校的門檻掛到乙校的位置上，
  // 而那個錯誤在畫面上完全看不出來。
  assert.equal(sameInstitution('臺灣大學', '台灣大學'), true);
  assert.equal(sameInstitution('國立臺灣大學', '臺灣大學'), true);
  assert.equal(sameInstitution('臺 灣 大 學', '臺灣大學'), true);
  assert.equal(sameInstitution('台大', '臺灣大學'), false);
  assert.equal(sameInstitution('', '臺灣大學'), false);
  assert.equal(sameInstitution('臺北大學', '臺灣大學'), false);

  const view = withNationalThresholds(myView(), [
    { institutionName: '台灣大學', starGroup: 2, year: 114, kind: 'STAR_ROUND1', value: { percentile: 18 } },
  ]);
  assert.equal(view.positions[0].nationalThresholds.length, 1);
  assert.deepEqual(view.unmatchedThresholds, []);
});

test('沒填學群的門檻照樣掛上去（他查簡章時常常只記了學校）', () => {
  const view = withNationalThresholds(myView(), [
    { institutionName: '臺灣大學', starGroup: null, year: 114, kind: 'STAR_ROUND1', value: { percentile: 18 } },
  ]);
  assert.equal(view.positions[0].nationalThresholds.length, 1);
  assert.equal(view.positions[0].nationalThresholds[0].starGroup, null, '要標出來它沒有學群');
});

test('對不上任何位置的門檻要列出來，不可以靜靜吞掉', () => {
  // 最常見的原因是他查了一個還沒填成志願的校系（那是好事，他在比較），
  // 第二常見的是校名打錯。兩種都需要被看見。
  const stray = {
    institutionName: '成功大學',
    starGroup: 3,
    year: 114,
    kind: 'STAR_ROUND1',
    value: { percentile: 22 },
  };
  const view = withNationalThresholds(myView(), [stray]);
  assert.deepEqual(view.positions[0].nationalThresholds, []);
  assert.deepEqual(view.unmatchedThresholds, [stray]);
});

test('學群不同的同一所大學不會互相掛錯', () => {
  const view = withNationalThresholds(myView(), [
    { institutionName: '臺灣大學', starGroup: 4, year: 114, kind: 'STAR_ROUND1', value: { percentile: 30 } },
  ]);
  assert.deepEqual(view.positions[0].nationalThresholds, []);
  assert.equal(view.unmatchedThresholds.length, 1);
});

test('兩層的說明都說得出「不做機率」', () => {
  // 這兩段文字會被印在畫面上，而規格書 §7.2 明文禁止「有把握」這類措辭。
  assert.match(TWO_LAYER_NOTE, /兩層都要過/);
  assert.match(TWO_LAYER_NOTE, /系統不會去抓/);
  assert.match(THRESHOLD_BASIS_NOTE, /最後一名錄取者/);
  assert.match(THRESHOLD_BASIS_NOTE, /每年只有一個極值資料點/);
  assert.match(THRESHOLD_BASIS_NOTE, /不會把它算成一個機率/);
  for (const banned of ['有把握', '穩上', '機率約', '大約七成']) {
    assert.ok(!TWO_LAYER_NOTE.includes(banned));
    assert.ok(!THRESHOLD_BASIS_NOTE.includes(banned));
  }
});

test('固定入口都是 https，而且不是深連結', () => {
  for (const u of [CAC_PORTAL, CEEC, JBCRC_CALENDAR]) {
    const parsed = new URL(u);
    assert.equal(parsed.protocol, 'https:');
    assert.ok(parsed.pathname.split('/').filter(Boolean).length <= 2, `${u} 太深了`);
  }
  assert.equal(starCircularUrl(115).urlKind, URL_DERIVED);
  assert.equal(sourceChecklist(115).find((s) => s.key === 'GSAT_STATS').where[0].urlKind, URL_FIXED);
});
