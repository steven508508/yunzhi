/**
 * 面試準備：結構回饋與一致性檢查。
 *
 * # 這一支要釘住的第一件事：回饋裡不可以出現內容評價
 *
 * 規格書 §10 說回饋只評結構。理由不是潔癖——「這個答案好不好」是招生
 * 委員的判斷，系統給了會發生兩件事，兩件都壞：它會是錯的（各校系的
 * 評分重點差異極大，系統手上沒有任何一份評分表可以對），而且
 * **學生會照著改**——改成他以為的「正確答案」，然後在面試現場講一段
 * 不是自己的話。面試最常見的失分本來就是講稿感。
 *
 * 所以下面有一條測試掃過所有輸出的字串，確認它們裡面沒有「好」「不錯」
 * 「優秀」「展現了」這一類的評價詞。
 *
 * # 第二件：這一層要誠實地說出它判斷不了什麼
 *
 * 第一版用字面比對去判「題目問的那四件事講到幾件」，結果每一個好回答
 * 都被判成四項全缺——而學生會學到「這個檢查是壞的」然後忽略整頁，
 * 連那些真的判得出來的項目一起忽略。
 *
 * 現在 `focusPoints` 是一份**要他自己對**的清單（`selfCheck`），
 * 而系統判的是**問句的形式**：「為什麼」要一個理由、「怎麼」要一段
 * 過程、「哪一個」要一個具體的東西。這是句型對句型，不是語意判斷。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FIELD_TAGS,
  QUESTION_TEMPLATES,
  consistencyCheck,
  structureFeedback,
  templatesFor,
} from '../lib/interview.mjs';

const GOOD_ANSWER =
  '是高二上的校內科展。我們那組三個人，卡最久的是感測器的雜訊，讀值一直跳。' +
  '後來我把取樣改成平均十次，花了兩個禮拜才穩定下來，最後在機器人社的成果展上拿到第三名。';

const VAGUE_ANSWER = '那次經驗讓我學到很多，收穫良多，也讓我成長很多。';

const Q_PROCESS = QUESTION_TEMPLATES.find((q) => q.question.includes('哪一步最卡'));
const Q_WHY = QUESTION_TEMPLATES.find((q) => q.question.includes('為什麼想讀醫學系'));

// ═════════════════════════════════════════════════════════════════
// 一、題庫
// ═════════════════════════════════════════════════════════════════

test('每一種校系類型都有題目，而且通用題永遠附在後面', () => {
  for (const f of FIELD_TAGS) {
    const rows = templatesFor(f.tag);
    assert.ok(rows.length > 0, `${f.label} 一題都沒有`);
    assert.ok(rows.some((q) => q.fieldTag === 'GENERAL'), `${f.label} 沒有附上通用題`);
  }
});

test('每一題都有結構要素，而且問法是綁在一件具體的事情上', () => {
  for (const q of QUESTION_TEMPLATES) {
    assert.ok(q.focusPoints.length >= 2, `這一題沒有列結構要素：${q.question}`);
    assert.ok(q.question.length >= 12, `這一題問得太短，會得到抽象的回答：${q.question}`);
    // 抽象的問題只會得到抽象的回答，練了等於沒練。
    assert.ok(
      !/請談談你的優缺點|自我介紹一下$/.test(q.question),
      `這一題太抽象：${q.question}`,
    );
  }
});

test('沒有重複的題目', () => {
  const seen = new Set(QUESTION_TEMPLATES.map((q) => q.question));
  assert.equal(seen.size, QUESTION_TEMPLATES.length);
});

// ═════════════════════════════════════════════════════════════════
// 二、只評結構，不評內容
// ═════════════════════════════════════════════════════════════════

/** 內容評價的字眼。出現任何一個就是越界。 */
const JUDGEMENT =
  /很好|不錯|優秀|出色|精彩|完美|糟|差勁|不佳|展現了|表現(?:出|得)(?:很|不)|值得肯定|令人印象深刻|加分|扣分|[0-9]+\s*分/;

test('回饋的每一句話都不含內容評價', () => {
  for (const answer of [GOOD_ANSWER, VAGUE_ANSWER, '', '嗯。']) {
    for (const q of [Q_PROCESS, Q_WHY]) {
      const fb = structureFeedback(answer, q);
      const all = [
        fb.addressed.note,
        fb.examples.note,
        fb.contradictions.note,
        fb.length.note,
        ...fb.questions,
      ].join(' ');
      assert.ok(!JUDGEMENT.test(all), `回饋裡出現了內容評價：${all.match(JUDGEMENT)?.[0]}`);
    }
  }
});

test('回饋裡沒有分數、等第、或任何可以排序的數字', () => {
  const fb = structureFeedback(GOOD_ANSWER, Q_PROCESS);
  assert.equal('score' in fb, false);
  assert.equal('grade' in fb, false);
  assert.equal('rating' in fb, false);
  // 唯一的數字是字數，而它是一個事實不是一個評價。
  assert.equal(typeof fb.length.chars, 'number');
});

test('追問全部是問句——回饋的形狀是問題，不是結論', () => {
  for (const answer of [GOOD_ANSWER, VAGUE_ANSWER]) {
    for (const q of structureFeedback(answer, Q_PROCESS).questions) {
      assert.ok(/[？?]/.test(q), `這一句不是問句：${q}`);
    }
  }
});

// ═════════════════════════════════════════════════════════════════
// 三、有沒有回答到問題（句型對句型）
// ═════════════════════════════════════════════════════════════════

test('「為什麼」要一個理由', () => {
  const none = structureFeedback('我想讀醫學系，這是我的夢想。', Q_WHY);
  assert.equal(none.addressed.ok, false);
  assert.ok(none.addressed.forms.some((f) => f.want === '一個理由' && !f.ok));

  const with_ = structureFeedback(
    '因為我阿公在高二那年住院，我在病房看了三個月，那是我第一次知道照顧一個人有多難。',
    Q_WHY,
  );
  assert.ok(with_.addressed.forms.every((f) => f.ok));
});

test('「哪一個」要一個具體指名的東西', () => {
  const off = structureFeedback('嗯，我覺得爵士樂很好聽，尤其是薩克斯風。', Q_PROCESS);
  assert.equal(off.addressed.ok, false);
  assert.ok(off.addressed.forms.some((f) => f.want === '一個具體指名的東西' && !f.ok));
});

test('「怎麼做」要一段有先後的過程', () => {
  const ok = structureFeedback(GOOD_ANSWER, Q_PROCESS);
  assert.ok(ok.addressed.forms.find((f) => f.want === '一段過程').ok);
  assert.equal(ok.addressed.ok, true);
});

test('結構要素是要學生自己對的，而且要說出系統判斷不了', () => {
  // 這一條在防的是回到第一版：用字面比對去判它，好回答會被判成全缺。
  const fb = structureFeedback(GOOD_ANSWER, Q_PROCESS);
  assert.deepEqual(fb.addressed.selfCheck, Q_PROCESS.focusPoints);
  assert.ok(fb.addressed.note.includes('判斷不了'));
  assert.equal('missing' in fb.addressed, false, '不叫 missing——那個字會被讀成「系統判了」');
});

// ═════════════════════════════════════════════════════════════════
// 四、有沒有具體例子
// ═════════════════════════════════════════════════════════════════

test('具體＝落在時間、數量、或一個有名字的東西上', () => {
  const fb = structureFeedback(GOOD_ANSWER, Q_PROCESS);
  assert.deepEqual(fb.examples.found.sort(), ['具名', '數量', '時間']);
  assert.equal(fb.examples.ok, true);
});

test('整段都是空話時，要指出來而且要問他那件事是什麼', () => {
  const fb = structureFeedback(VAGUE_ANSWER, Q_PROCESS);
  assert.equal(fb.examples.ok, false);
  assert.ok(fb.questions.some((q) => q.includes('學到很多')));
});

test('完全沒有落點的回答，回饋要說出這是最常見的失分', () => {
  const fb = structureFeedback('我覺得還可以吧。', Q_PROCESS);
  assert.deepEqual(fb.examples.found, []);
  assert.ok(fb.examples.note.includes('最常見的失分'));
});

// ═════════════════════════════════════════════════════════════════
// 五、有沒有前後矛盾
// ═════════════════════════════════════════════════════════════════

test('同一段話裡自己打自己的，抓得出來', () => {
  const fb = structureFeedback('我沒有參加過社團，但是在社團裡我學到很多。', Q_PROCESS);
  assert.equal(fb.contradictions.ok, false);
  assert.equal(fb.contradictions.hits.length, 1);
});

test('沒有矛盾的長回答不會被誤判', () => {
  assert.equal(structureFeedback(GOOD_ANSWER, Q_PROCESS).contradictions.ok, true);
});

test('「第一次做」加上「做過很多次」是矛盾', () => {
  const fb = structureFeedback(
    '那是我第一次接觸這個領域，不過類似的事情我做過很多次了。',
    Q_PROCESS,
  );
  assert.equal(fb.contradictions.ok, false);
});

// ═════════════════════════════════════════════════════════════════
// 六、與學習歷程的一致性
// ═════════════════════════════════════════════════════════════════

test('講了檔案裡沒有的東西，要提醒', () => {
  // 面試最貴的一種失分：委員手上就拿著那份檔案。
  const c = consistencyCheck(GOOD_ANSWER, [{ body: '我對物理有興趣。' }], []);
  assert.equal(c.ok, false);
  assert.ok(c.unmatched.includes('機器人社'));
  assert.ok(c.unmatched.includes('校內科展'));
});

test('檔案裡找得到就不提醒', () => {
  const c = consistencyCheck(
    GOOD_ANSWER,
    [{ body: '高二上我參加了校內科展，也在機器人社做過自走車。' }],
    [],
  );
  assert.equal(c.ok, true);
});

test('素材的標題也算檔案的一部分', () => {
  const c = consistencyCheck(
    GOOD_ANSWER,
    [{ body: '' }],
    [{ title: '校內科展成果報告', note: '機器人社的自走車' }],
  );
  assert.equal(c.ok, true);
});

test('抓到的名字要是名字，不是一整句話', () => {
  // 貪婪的抓法會把「是高二上的校內科展」整串當成一個名字，然後每一次
  // 練習都跳出一個對不上的「名詞」——那種提醒出現兩次之後就沒有人看了。
  const c = consistencyCheck(GOOD_ANSWER, [{ body: '' }], []);
  for (const t of c.unmatched) {
    assert.ok(Array.from(t).length <= 8, `這不是一個名字，是一句話：${t}`);
    assert.ok(!/^[是的了在和與]/.test(t), `名字的開頭是助詞：${t}`);
  }
});

test('檔案是空的時候，這一項要說「沒有比對」而不是報一堆對不上', () => {
  // 資料不足時要承認，不要補值。
  const c = consistencyCheck(GOOD_ANSWER, [], []);
  assert.ok(c.note.includes('沒有比對'));
});

test('只查一個方向：檔案裡有而回答沒提，不算矛盾', () => {
  // 那是取捨不是矛盾——檔案有篇幅限制，本來就寫不完。
  const c = consistencyCheck('是校內科展那一件。', [
    { body: '我參加過校內科展、辯論社、還有兩次志工服務。' },
  ]);
  assert.equal(c.ok, true);
});

test('提醒的措辭是「要接得起來」而不是「你說謊」', () => {
  const c = consistencyCheck(GOOD_ANSWER, [{ body: '我對物理有興趣。' }], []);
  assert.ok(c.note.includes('不一定有問題'));
  assert.ok(!/說謊|不實|造假|矛盾/.test(c.note));
});

// ═════════════════════════════════════════════════════════════════
// 七、長度
// ═════════════════════════════════════════════════════════════════

test('太短與太長各有一句可執行的話', () => {
  const short = structureFeedback('對。', Q_PROCESS);
  assert.ok(short.questions.some((q) => q.includes('三十秒')));

  const long = structureFeedback('我'.repeat(700), Q_PROCESS);
  assert.ok(long.questions.some((q) => q.includes('留哪一半')));
});
