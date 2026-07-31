/**
 * 附圖該寫進哪一欄。
 *
 * 這一支守的是一個**沒有錯誤訊息的失敗**：入庫時 `QuestionOption.assets`
 * 與 `QuestionGroup.stimulusAssets` 從來沒有被寫過，而五個畫面都在讀它。
 * 症狀是物理題四個選項各印一行「這裡有一張附圖，但系統找不到它」，
 * 而那四張圖被堆到題幹後面——四張沒有標號的圖配四個沒有圖的選項。
 * 資料庫裡每一欄都有值、每一次入庫都回報成功。
 *
 * `partitionAssets` 同時被 `lib/commit.ts`（寫資料庫）與校對頁
 * （畫預覽）呼叫，所以這裡釘住的行為就是「校對畫面等於學生畫面」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { referencedAssets } from '../lib/math.mjs';
import {
  missingAssetRefs,
  normalizeAssets,
  partitionAssets,
  referencedAssetIds,
} from '../lib/questionShape.mjs';

const fig = (id, extra = {}) => ({ id, key: `k/${id}.png`, width: 100, height: 80, ...extra });

// ── 標記的規則 ───────────────────────────────────────────────────

test('附圖標記的寬窄與 lib/math.mjs 一致', () => {
  // 三份 ASSET_REF（這裡、lib/math.mjs、apps/ai/pipeline/canonical.py）
  // 寬窄不同的症狀是：管線那邊驗過說「這一題的圖都對得起來」，畫面上
  // 卻印出一串 ![[a:...]]，而那串東西看起來就像 AI 抽壞了字。
  const cases = [
    '![[a:fig1]] 如圖',
    '前 ![[a:a-b_C9]] 後',
    '![[a:]] 空的 id',
    '![[a:' + 'x'.repeat(33) + ']] 太長',
    '![[a:有中文]]',
    '!\\[[a:fig1]]',
    '![[a:f1]] 與 ![[a:f2]]',
  ];
  for (const src of cases) {
    assert.deepEqual(referencedAssetIds(src), referencedAssets(src), src);
  }
});

test('唯一一處與 lib/math.mjs 不同：數學式裡面的標記', () => {
  // math.mjs 是先切數學式再找標記（`splitMath`），所以 `$x![[a:f1]]y$`
  // 裡的那一個算 TeX 的一部分，不是附圖；這裡是純正規表示式，會抓到。
  //
  // **刻意留著這個差異**，換掉的話這個檔案就得把 splitMath 整份搬過來
  // （或匯入 katex），而檔頭寫了為什麼不能有相依。差異的後果只有一種：
  // 一個寫在 `$…$` 裡面、又指不到任何一張圖的標記會被判成「附圖不見了」
  // 而擋住入庫。那個組合本身就是壞掉的內容——KaTeX 會把它排成一串紅字
  // ——所以擋下來的方向是對的。
  //
  // 反過來（math.mjs 比較寬）才危險：那會變成「入庫檢查說沒問題，
  // 學生畫面上少一張圖」。這個測試就是釘住方向的。
  const src = '$x![[a:f1]]y$ 與 ![[a:f2]]';
  assert.deepEqual(referencedAssets(src), ['f2']);
  assert.deepEqual(referencedAssetIds(src), ['f1', 'f2']);
});

test('同一個標記出現兩次只算一次', () => {
  assert.deepEqual(referencedAssetIds('![[a:f1]] 又 ![[a:f1]] 又 ![[a:f2]]'), ['f1', 'f2']);
});

// ── 分派 ─────────────────────────────────────────────────────────

test('選項裡的圖跟著選項走，不留在題幹', () => {
  // 物理的「下列何者為合力」：四個選項是四張力圖。
  const r = partitionAssets({
    assets: [fig('o1'), fig('o2'), fig('o3'), fig('o4')],
    content: '下列何者為 $\\vec{F_1}$ 與 $\\vec{F_2}$ 的合力？',
    options: [
      { order: 1, label: '1', content: '![[a:o1]]' },
      { order: 2, label: '2', content: '![[a:o2]]' },
      { order: 3, label: '3', content: '![[a:o3]]' },
      { order: 4, label: '4', content: '![[a:o4]]' },
    ],
  });

  assert.deepEqual(r.optionAssets.map((o) => o.assets.map((a) => a.id)), [
    ['o1'], ['o2'], ['o3'], ['o4'],
  ]);
  // **題幹一張都不留。** 留著的話 MathText 會把四張沒有標號的圖
  // 一起排在題幹後面（那是 `rest` 的行為，見 components/MathText.tsx）。
  assert.deepEqual(r.contentAssets, []);
  assert.deepEqual(r.missing, []);
});

test('題組共用的圖歸題組，子題的圖歸題幹', () => {
  const r = partitionAssets({
    assets: [fig('tbl1'), fig('fig2')],
    stimulus: '下表為各都市死亡人數：![[a:tbl1]]',
    content: '根據上表與 ![[a:fig2]]，下列敘述何者正確？',
    options: [{ order: 1, label: '1', content: '甲' }],
  });
  assert.deepEqual(r.stimulusAssets.map((a) => a.id), ['tbl1']);
  assert.deepEqual(r.contentAssets.map((a) => a.id), ['fig2']);
  assert.deepEqual(r.optionAssets[0].assets, []);
});

test('沒有 id 的圖跟著題幹——講義那條路產出的就是這種', () => {
  // 切分階段用垂直重疊把圖分派給題目，那些圖沒有 id、題幹裡也沒有標記。
  // MathText 會把它們排在題幹後面，那是主要路徑不是補漏。
  const r = partitionAssets({
    assets: [{ key: 'k/loose.png' }, fig('f1')],
    content: '如右圖，![[a:f1]] 中的角 A 為何？',
    options: [],
  });
  assert.deepEqual(r.contentAssets.map((a) => a.id ?? '(無)'), ['f1', '(無)']);
});

test('同一張圖被題幹與選項同時引用時，兩邊都拿得到', () => {
  const r = partitionAssets({
    assets: [fig('f1')],
    content: '參考 ![[a:f1]]',
    options: [{ order: 1, label: '1', content: '與 ![[a:f1]] 相同' }],
  });
  assert.deepEqual(r.contentAssets.map((a) => a.id), ['f1']);
  assert.deepEqual(r.optionAssets[0].assets.map((a) => a.id), ['f1']);
});

test('標記指向不存在的圖時說得出是哪一段的哪一個 id', () => {
  // 這是入庫要擋的那一條：學生會在那個位置看到一行
  // 「這裡有一張附圖，但系統找不到它」，而題目寫著「如右圖」。
  const r = partitionAssets({
    assets: [fig('f1')],
    stimulus: '![[a:t9]]',
    content: '如右圖 ![[a:f1]] 與 ![[a:f8]]',
    options: [{ order: 1, label: 'A', content: '![[a:o7]]' }],
  });
  assert.deepEqual(r.missing, [
    { where: '題組前導敘述', id: 't9' },
    { where: '題幹', id: 'f8' },
    { where: '選項 (A)', id: 'o7' },
  ]);
});

test('什麼都沒有時不會爆，回空的四份', () => {
  const r = partitionAssets();
  assert.deepEqual(r, {
    stimulusAssets: [], contentAssets: [], optionAssets: [], missing: [],
  });
  // 壞掉的項目（null、字串、數字）略過而不是丟例外——這一欄是 Json，
  // 舊資料與手改過的列什麼都可能塞。
  const bad = partitionAssets({ assets: [null, 'x', 3, fig('f1')], content: '![[a:f1]]' });
  assert.deepEqual(bad.contentAssets.map((a) => a.id), ['f1']);
});

// ── 入庫形狀 ─────────────────────────────────────────────────────

test('分出來的每一份都還是 normalizeAssets 收得下的形狀', () => {
  // 分派完直接餵給 normalizeAssets 寫進資料庫。分派時若不小心把
  // 物件換了形狀（例如只留 id），入庫的那一欄就會是空的。
  const r = partitionAssets({
    assets: [fig('o1', { alt: '向右的力' })],
    content: '題幹',
    options: [{ order: 1, label: '1', content: '![[a:o1]]' }],
  });
  const written = normalizeAssets(r.optionAssets[0].assets);
  assert.equal(written?.length, 1);
  assert.equal(written[0].id, 'o1');
  assert.equal(written[0].key, 'k/o1.png');
  assert.equal(written[0].alt, '向右的力');
  assert.equal(written[0].width, 100);
});

// ── 已經分好欄位的那一側 ─────────────────────────────────────────

test('missingAssetRefs 用在題庫裡的題目（三個欄位各存各的）', () => {
  assert.deepEqual(missingAssetRefs('![[a:f1]] 與 ![[a:f2]]', [fig('f1')]), ['f2']);
  assert.deepEqual(missingAssetRefs('![[a:f1]]', [fig('f1')]), []);
  // 這一欄是 Json，可能是 null 或別的東西。
  assert.deepEqual(missingAssetRefs('![[a:f1]]', null), ['f1']);
  assert.deepEqual(missingAssetRefs(null, [fig('f1')]), []);
});
