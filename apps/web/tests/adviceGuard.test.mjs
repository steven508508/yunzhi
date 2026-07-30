/**
 * 升學建議的閘門：擋的是「製造假的精確度」。
 *
 * # 這一支測的錯誤與智慧老師那一支完全不同
 *
 * `tutorGuard.test.mjs` 測的是洩漏答案——那種錯誤看得見，學生看完就
 * 知道答案。這裡測的是另一種：一段讀起來專業、令人安心、而且**完全沒有
 * 症狀**的輸出。「你通過的機率大約 68%」沒有人會回報，因為它看起來就是
 * 這個功能該給的東西。
 *
 * 而那個 68% 建立在什麼上面？官方公布的只有各校系第一輪**最後一名
 * 錄取者**的在校百分比，而繁星校系第一輪的名額常常只有 1 至 3 名——
 * **每年只有一個極值資料點**。三個點推不出機率，推出來的誤差比數字本身
 * 還大。學生會照著它決定要不要填那個志願，而個申的放棄期限只有四天。
 *
 * # 為什麼要測「二十幾種寫法」而不是三種
 *
 * 因為模型被擋掉之後會換寫法，而換出來的每一種在字串上都完全不同：
 *
 *     68%  →  大概七成  →  十之八九  →  應該沒問題  →  很穩  →  機會不小
 *
 * 在正規表達式上這是六條不同的規則，在學生眼裡是同一句話。少寫一條，
 * 模型就會找到那一條——它確實會，這與 tutorGuard 的排除法那一條是同一
 * 種現象。所以下面每一種都是一個獨立的案例。
 *
 * # 反例比正例重要
 *
 * 誤擋的代價是把一段**帶著資料基礎與不確定性的好建議**丟掉，然後退回
 * 罐頭。所以檔案後半段有一整組必須通過的輸出，包含規格書 §7.2 那個
 * 範例的口吻——那一段裡有百分比、有年份、有「機率」這個詞、有「沒有
 * 把握」，每一個都長得像違規。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INSTITUTION_NUMBERS,
  adviceFacts,
  checkAdvice,
  describeAdviceViolations,
  normalizeForAdvice,
  safeAdvice,
} from '../lib/adviceGuard.mjs';
import { adviceBasis } from '../lib/admissionRef.mjs';

// ─────────────────────────────────────────────────────────────────
// 事實：一位學生查到三年的門檻（18%、15%、16%），自己是 12%
// ─────────────────────────────────────────────────────────────────

const ref = (over = {}) => ({
  year: 114,
  kind: 'STAR_ROUND1',
  kindLabel: '繁星第一輪錄取標準',
  institutionName: '臺灣大學',
  programName: null,
  starGroup: 2,
  value: { percentile: 18 },
  sourceKind: 'OFFICIAL_DOC',
  sourceRef: 'https://example.invalid/星-114.pdf',
  lookedUpAt: '2026-03-05T00:00:00.000Z',
  staleAfterYear: 114,
  describe: '18%',
  ...over,
});

/** 三年的資料 + 教務處匯入的 12%。這是「資料最完整」的情形。 */
function richFacts() {
  const basis = adviceBasis({
    year: 115,
    officialPercentile: 12,
    wishes: [{ channel: 'STAR', institutionName: '臺灣大學', starGroup: 2, rank: 1 }],
    references: [
      ref({ year: 114, value: { percentile: 18 }, describe: '18%', staleAfterYear: 115 }),
      ref({ year: 113, value: { percentile: 15 }, describe: '15%', staleAfterYear: 115 }),
      ref({ year: 112, value: { percentile: 16 }, describe: '16%', staleAfterYear: 115 }),
    ],
    now: new Date('2026-03-10T00:00:00.000Z'),
  });
  return { basis, facts: adviceFacts(basis) };
}

/** 只查到一年、而且是聽同學說的。這是「資料很薄」的情形。 */
function thinFacts() {
  const basis = adviceBasis({
    year: 115,
    officialPercentile: null,
    wishes: [{ channel: 'STAR', institutionName: '臺灣大學', starGroup: 2, rank: 1 }],
    references: [
      ref({
        year: 114,
        sourceKind: 'HEARSAY',
        sourceRef: '同班的小明說的',
        value: { percentile: 18 },
        describe: '18%',
        staleAfterYear: 115,
      }),
    ],
    now: new Date('2026-03-10T00:00:00.000Z'),
  });
  return { basis, facts: adviceFacts(basis) };
}

/** 什麼都還沒查。 */
function emptyFacts() {
  const basis = adviceBasis({
    year: 115,
    wishes: [{ channel: 'STAR', institutionName: '臺灣大學', starGroup: 2, rank: 1 }],
    references: [],
  });
  return { basis, facts: adviceFacts(basis) };
}

/** 每一段違規的輸出都要能通過「資料基礎」那一條，否則測不出真正的原因。 */
const BASIS_TAIL =
  '這是根據每年僅一個極值資料點的估計，年際波動可能很大。';

function blocked(text, facts) {
  const r = checkAdvice(text, facts);
  assert.equal(r.ok, false, `這一段應該被擋下來：${text}`);
  return r;
}

// ═════════════════════════════════════════════════════════════════
// §1 二十六種「製造假精確度」的寫法，每一種都要被擋
// ═════════════════════════════════════════════════════════════════

/**
 * 每一項是 `[名字, 那一段輸出, 期望命中的違規碼]`。
 *
 * 期望碼寫出來，是為了不讓一條規則替另一條擋掉——「近三年門檻是
 * 15%、18%、16%」在只有一年資料時同時命中兩條，若只斷言「被擋下來」，
 * 刪掉其中一條規則測試還是綠的。
 */
const FAKE_PRECISION = [
  // ── 明說百分比或數字機率 ──────────────────────────────
  ['通過機率', `你的通過機率大約 68%。${BASIS_TAIL}`, 'ODDS_PREDICTION'],
  ['錄取機率', `依你的百分比，錄取機率有 7 成以上。${BASIS_TAIL}`, 'ODDS_PREDICTION'],
  ['成功率', `這個志願的成功率大概 60%。${BASIS_TAIL}`, 'ODDS_PREDICTION'],
  ['勝算', `你的勝算超過一半。${BASIS_TAIL}`, 'ODDS_PREDICTION'],
  ['機會很大', `你上這個校系的機會很大。${BASIS_TAIL}`, 'ODDS_PREDICTION'],
  ['機會不小', `這個位置你的機會不小。${BASIS_TAIL}`, 'ODDS_PREDICTION'],
  ['可能性偏高', `錄取的可能性偏高。${BASIS_TAIL}`, 'ODDS_PREDICTION'],
  ['英文的 probability', `The probability of admission is about 70%. ${BASIS_TAIL}`, 'ODDS_PREDICTION'],
  ['LaTeX 包起來的百分比', `你的錄取機率是 $68\\%$。${BASIS_TAIL}`, 'ODDS_PREDICTION'],
  ['全形數字與百分號', `錄取機率大約 ６８％。${BASIS_TAIL}`, 'ODDS_PREDICTION'],

  // ── 換成中文的成數與俗語 ──────────────────────────────
  ['大概七成', `這個志願大概七成會上。${BASIS_TAIL}`, 'ODDS_IN_WORDS'],
  ['差不多八成', `差不多八成沒有問題。${BASIS_TAIL}`, 'ODDS_IN_WORDS'],
  ['十之八九', `你十之八九上得了。${BASIS_TAIL}`, 'ODDS_IN_WORDS'],
  ['八九不離十', `八九不離十啦。${BASIS_TAIL}`, 'ODDS_IN_WORDS'],
  ['九成九', `九成九會錄取。${BASIS_TAIL}`, 'ODDS_IN_WORDS'],

  // ── 斷定語氣 ──────────────────────────────────────────
  ['一定會上', `照這個門檻看，你一定會上。${BASIS_TAIL}`, 'CERTAINTY'],
  ['穩上', `這個志願你穩上。${BASIS_TAIL}`, 'CERTAINTY'],
  ['很穩', `這個位置很穩，可以填。${BASIS_TAIL}`, 'CERTAINTY'],
  ['有相當把握', `你可以有相當把握。${BASIS_TAIL}`, 'CERTAINTY'],
  ['應該沒問題', `你的百分比比門檻好，應該沒問題。${BASIS_TAIL}`, 'CERTAINTY'],
  ['保證', `我保證這個志願會上。${BASIS_TAIL}`, 'CERTAINTY'],
  ['鐵定', `鐵定上，不用擔心。${BASIS_TAIL}`, 'CERTAINTY'],
  ['篤定', `你已經篤定錄取了。${BASIS_TAIL}`, 'CERTAINTY'],
  ['十拿九穩', `這個志願十拿九穩。${BASIS_TAIL}`, 'ODDS_IN_WORDS'],
  ['可以放心', `你可以放心填這一個。${BASIS_TAIL}`, 'CERTAINTY'],
  ['沒有懸念', `以你的百分比，沒有懸念。${BASIS_TAIL}`, 'CERTAINTY'],
  ['輕鬆過', `這個門檻你輕鬆過。${BASIS_TAIL}`, 'CERTAINTY'],

  // ── 把極值當平均 ──────────────────────────────────────
  ['平均錄取百分比', `這個校系平均錄取百分比是 16%。${BASIS_TAIL}`, 'EXTREME_AS_AVERAGE'],
  ['中位數', `近三年門檻的中位數是 16%。${BASIS_TAIL}`, 'EXTREME_AS_AVERAGE'],
  ['全體錄取者的分布', `全體錄取者的在校百分比都落在 15% 到 18% 之間。${BASIS_TAIL}`, 'EXTREME_AS_AVERAGE'],
];

for (const [name, text, code] of FAKE_PRECISION) {
  test(`擋得住：${name}`, () => {
    const { facts } = richFacts();
    const r = blocked(text, facts);
    assert.ok(
      r.violations.some((v) => v.code === code),
      `期望命中 ${code}，實際是 ${r.violations.map((v) => v.code).join('、')}`,
    );
    assert.equal(r.fabricated, true, '這一類一定要標成假精確度（一定重新生成）');
  });
}

test('二十六種以上的假精確度樣式都在清單裡', () => {
  // 這一條是防止有人為了讓某一段輸出過關而刪掉案例。
  assert.ok(FAKE_PRECISION.length >= 26, `只有 ${FAKE_PRECISION.length} 種`);
  assert.ok(new Set(FAKE_PRECISION.map((x) => x[0])).size === FAKE_PRECISION.length, '案例名稱重複');
});

// ═════════════════════════════════════════════════════════════════
// §2 沒有來源的數字
// ═════════════════════════════════════════════════════════════════

test('引用一個不存在的門檻數字會被擋', () => {
  const { facts } = richFacts();
  // 這位學生查到的是 18、15、16。21% 是模型自己編的。
  const r = blocked(`近三年的門檻分別是 18%、15%、21%。${BASIS_TAIL}`, facts);
  assert.ok(r.violations.some((v) => v.code === 'UNSOURCED_NUMBER'));
  assert.match(describeAdviceViolations(r.violations), /21%/);
});

test('引用一個不存在的級分會被擋', () => {
  const { facts } = richFacts();
  const r = blocked(`這個校系的篩選門檻是數學 A 14 級分。${BASIS_TAIL}`, facts);
  assert.ok(r.violations.some((v) => v.code === 'UNSOURCED_NUMBER'));
});

test('引用一個不存在的缺額數會被擋', () => {
  const { facts } = richFacts();
  const r = blocked(`該校系去年缺額 47 名，第二輪還有路。${BASIS_TAIL}`, facts);
  assert.ok(r.violations.some((v) => v.code === 'UNSOURCED_NUMBER'));
});

test('學生查到的數字可以出現', () => {
  const { facts } = richFacts();
  const ok = checkAdvice(
    `你查到 114 學年度最後一名錄取者是 18%，而你自己是 12%。${BASIS_TAIL}`,
    facts,
  );
  assert.equal(ok.ok, true, describeAdviceViolations(ok.violations));
});

test('制度常數不必對回參考資料，但白名單很小而且逐項說得出理由', () => {
  const { facts } = richFacts();
  // 「第一輪名額常常只有 1 至 3 名」是公開的制度事實，系統自己的說明
  // 文字裡就有它——見 lib/star.mjs。
  const ok = checkAdvice(
    `繁星校系第一輪名額常常只有 1 至 3 名，所以每年只有一個極值資料點。`,
    facts,
  );
  assert.equal(ok.ok, true, describeAdviceViolations(ok.violations));
  assert.deepEqual(INSTITUTION_NUMBERS, ['1', '2', '3', '4', '5', '6', '7', '8', '922']);
});

test('自己編的來源會被擋，但「去哪裡查」的建議不會', () => {
  const { facts } = thinFacts(); // 只有一筆，來源是聽同學說的
  assert.equal(facts.hasOfficialDoc, false);

  const bad = blocked(`根據官方公布的資料，這個校系的門檻是 18%。${BASIS_TAIL}`, facts);
  assert.ok(bad.violations.some((v) => v.code === 'FAKE_SOURCE'));

  // 這一句是這個功能最該講的話。它含著「大考中心」，但它是建議不是引用。
  const good = checkAdvice(
    '你這一筆是聽同學說的，只能當線索。去大考中心查一下當年度的統計，' +
      '再去委員會的簡章頁把 113 學年度的門檻補上——目前只有一年的資料，' +
      '看不出趨勢，這是根據每年僅一個極值資料點的估計。',
    facts,
  );
  assert.equal(good.ok, true, describeAdviceViolations(good.violations));
});

test('只有一年資料卻說「近三年」會被擋', () => {
  const { facts } = thinFacts();
  assert.equal(facts.yearCount, 1);
  const r = blocked(`近三年的門檻都很穩定。${BASIS_TAIL}`, facts);
  assert.ok(r.violations.some((v) => v.code === 'FAKE_YEAR_SPAN'));
});

test('只有一年資料卻說「歷年趨勢」也會被擋', () => {
  const { facts } = thinFacts();
  const r = blocked(`從歷年的資料看，這個門檻逐年往下。${BASIS_TAIL}`, facts);
  assert.ok(r.violations.some((v) => v.code === 'FAKE_YEAR_SPAN'));
});

test('真的有三年資料時，「近三年」是可以說的', () => {
  const { facts } = richFacts();
  assert.equal(facts.yearCount, 3);
  const ok = checkAdvice(
    `你查到近三年的門檻是 18%、15%、16%，你自己是 12%，落在這三年的門檻之上。${BASIS_TAIL}`,
    facts,
  );
  assert.equal(ok.ok, true, describeAdviceViolations(ok.violations));
});

// ═════════════════════════════════════════════════════════════════
// §3 反例：好的建議不可以被誤擋
//
// **這一組比上面那二十六種重要。** 誤擋的結果是把一段帶著資料基礎與
// 不確定性的建議丟掉，然後退回罐頭——而學生看到的就是一段罐頭。
// ═════════════════════════════════════════════════════════════════

const MUST_PASS = [
  [
    '規格書 §7.2 的口吻',
    () => richFacts().facts,
    '你查到臺灣大學第 2 類學群近三年第一輪最後一名錄取者的在校百分比是 18%、15%、16%，' +
      '來源是官方文件，你在 3 月 5 日查的。你自己的在校百分比是 12%，落在這三年的門檻之上。' +
      '但要知道這個判斷的資料基礎有多薄：官方公布的只有最後一名錄取者的百分比，' +
      '而繁星校系第一輪名額常常只有 1 至 3 名，也就是每年只有一個極值資料點，' +
      '年際波動可能很大。',
  ],
  [
    '明說系統不估機率',
    () => richFacts().facts,
    '第二輪不受一校一名的限制，但本系統不估第二輪的機率——缺額取決於全國有多少人放棄，' +
      '而那份資料不存在。它也絕對不是零。這是根據每年僅一個極值資料點的估計。',
  ],
  [
    '誠實地說沒有把握',
    () => richFacts().facts,
    '這件事我沒有把握，也不會給你一個數字。你查到的 18% 是最後一名錄取者的百分比，' +
      '不是平均，年際波動可能很大。',
  ],
  [
    '否定形的斷定詞',
    () => richFacts().facts,
    '這不保證你會錄取，也不一定會上——沒有人算得出那件事。你手上有的是三年的極值，' +
      '而每年只有一個資料點。',
  ],
  [
    '講機率但是說算不出來',
    () => richFacts().facts,
    '你想知道的那個機率算不出來。可用的資料是每年一個極值，樣本量極小。',
  ],
  [
    '資料缺口＋去哪裡查（沒有任何數字）',
    () => emptyFacts().facts,
    '你填了繁星志願，但還沒有輸入任何一筆該校系的錄取標準，所以現在沒有辦法說你落在哪裡。' +
      '先去委員會的簡章頁把去年的門檻查出來，一年一筆輸入進來。' +
      '順便問教務處你的在校百分比是多少——那個數字網路上查不到。',
  ],
  [
    '只有一年，講的是去補資料',
    () => thinFacts().facts,
    '你只查到 114 學年度一年的資料，而且是聽同學說的，只能當線索。' +
      '一年看不出趨勢，先把 113 與 112 學年度也查一下，三年放在一起才看得出' +
      '這個校系的門檻是穩定的還是每年在跳。',
  ],
  [
    '提到成功大學（不可以被成數規則誤擋）',
    () => richFacts().facts,
    '如果你改推成功大學那個位置，校內第 1 位是你——這是校內那一層，' +
      '全國那一層要看你查到的門檻。這是根據每年僅一個極值資料點的估計。',
  ],
  [
    '提到校內第 4 位（序位是數出來的，不是機率）',
    () => richFacts().facts,
    '你在這個位置是校內第 4 位，而校內每個位置至多推薦 2 名，所以第一輪的資格' +
      '目前不在你手上。第二輪還有路。這是根據每年僅一個極值資料點的估計。',
  ],
];

for (const [name, mk, text] of MUST_PASS) {
  test(`不可以誤擋：${name}`, () => {
    const r = checkAdvice(text, mk());
    assert.equal(r.ok, true, describeAdviceViolations(r.violations));
    assert.equal(r.fabricated, false);
  });
}

// ═════════════════════════════════════════════════════════════════
// §4 體例：那兩條是 STYLE 而不是 FAKE
// ═════════════════════════════════════════════════════════════════

test('拿門檻比了卻不交代資料基礎，是 STYLE 而不是 FAKE', () => {
  const { facts } = richFacts();
  const r = checkAdvice('你查到的門檻是 18%，你自己是 12%，比門檻好。', facts);
  assert.equal(r.ok, false);
  assert.equal(r.fabricated, false, '體例問題重來一次還這樣就收下，不是假精確度');
  assert.deepEqual(
    r.violations.map((v) => v.code),
    ['NO_UNCERTAINTY'],
  );
});

test('沒有門檻資料時不要求交代資料基礎', () => {
  const { facts } = emptyFacts();
  const r = checkAdvice('你還沒有輸入任何錄取標準，先去查一年回來。', facts);
  assert.equal(r.ok, true, describeAdviceViolations(r.violations));
});

test('太長是 STYLE', () => {
  const { facts } = emptyFacts();
  const r = checkAdvice('一'.repeat(800), facts);
  assert.equal(r.fabricated, false);
  assert.ok(r.violations.some((v) => v.code === 'TOO_LONG'));
});

// ═════════════════════════════════════════════════════════════════
// §5 退路本身要通得過自己的閘門
//
// 這一條不是形式。`safeAdvice()` 會把學生查到的數字印出來，而它印出來的
// 每一個數字都必須在白名單裡——若它自己被閘門擋下來，那條路徑就沒有
// 出口了，而那時畫面上會是一片空白。
// ═════════════════════════════════════════════════════════════════

test('退路通得過閘門（資料完整）', () => {
  const { basis, facts } = richFacts();
  const text = safeAdvice(basis);
  const r = checkAdvice(text, facts);
  assert.equal(r.ok, true, `${describeAdviceViolations(r.violations)}\n---\n${text}`);
  assert.match(text, /18%/);
  assert.match(text, /極值/, '退路一定要說出資料基礎有多薄');
  assert.match(text, /官方文件/, '來源要跟著數字一起出現');
  assert.match(text, /2026-03-05/, '查詢日期也要');
});

test('退路通得過閘門（只有一年、聽說的）', () => {
  const { basis, facts } = thinFacts();
  const text = safeAdvice(basis);
  const r = checkAdvice(text, facts);
  assert.equal(r.ok, true, `${describeAdviceViolations(r.violations)}\n---\n${text}`);
  assert.match(text, /只查到 114 學年度一年/);
});

test('退路通得過閘門（什麼都還沒查）', () => {
  const { basis, facts } = emptyFacts();
  const text = safeAdvice(basis);
  const r = checkAdvice(text, facts);
  assert.equal(r.ok, true, describeAdviceViolations(r.violations));
});

test('退路不是「AI 暫時無法回應」', () => {
  const { basis } = richFacts();
  const text = safeAdvice(basis);
  for (const banned of ['稍後再試', '暫時無法', '系統忙碌', '請重新整理']) {
    assert.ok(!text.includes(banned), `退路出現了「${banned}」——那對學生等於功能壞了`);
  }
});

test('退路有長度上限：塞很多筆資料進去也不會超過', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    ref({
      year: 114 - (i % 3),
      value: { percentile: 20 + i },
      describe: `${20 + i}%`,
      institutionName: `很長的大學名稱${i}`,
      programName: `一個名字也很長的學系${i}`,
      staleAfterYear: 115,
    }),
  );
  const basis = adviceBasis({ year: 115, officialPercentile: 12, references: many, wishes: [] });
  const r = checkAdvice(safeAdvice(basis), adviceFacts(basis));
  assert.ok(
    !r.violations.some((v) => v.code === 'TOO_LONG'),
    '退路超過長度上限了——列出的筆數要有上限',
  );
});

// ═════════════════════════════════════════════════════════════════
// §6 正規化
// ═════════════════════════════════════════════════════════════════

test('全形折半形，但中文數字刻意不折', () => {
  assert.equal(normalizeForAdvice('６８％'), '68%');
  // 「七成」折成「7成」之後就對不上成數那一條規則，而那是這一層最該
  // 擋的一種寫法。共用 tutorGuard 的正規化就會發生這件事。
  assert.match(normalizeForAdvice('大概七成'), /七成/);
});

test('LaTeX 的百分號躲不過去', () => {
  assert.match(normalizeForAdvice('$68\\%$'), /68%/);
});
