/**
 * 判讀結果 → 候選題。
 *
 * 這一層守兩個**沒有錯誤訊息的失敗**：
 *
 *   · 題組共用的圖掛在題組素材上，而候選題只帶 `q.asset_ids`——
 *     於是 `stimulus` 被複製進來，裡面的 `![[a:fig1]]` 對不到任何一張圖。
 *     圖表題的「根據上表回答」，那個上表永遠是空的。
 *   · 表格沒裁成圖就被整包丟掉，而題幹裡的 `![[a:t1]]` 原封不動。
 *     `table_markdown` 明明抽到了，全 repo 卻沒有任何持久化。
 *
 * 兩個的共同點是**入庫回報成功、每一欄都有值**，錯誤只出現在學生的
 * 畫面上，而那時候沒有人在看。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fromReading, inlineTableAssets } from '../scripts/import-pipeline.mjs';

const MD = '| 都市 | 死亡人數 |\n|---|---|\n| 費城 | 7024 |';

/** 一份最小的判讀結果。 */
function reading({ questions, groups = [], assets = [] }) {
  return { document: { document: {}, questions, groups, assets, issues: [] } };
}

const question = (extra) => ({
  id: 'q1',
  number: '1',
  kind: 'SINGLE_CHOICE',
  stem: '下列何者正確？',
  options: [
    { order: 1, label: '(1)', content: '甲' },
    { order: 2, label: '(2)', content: '乙' },
  ],
  answer: { source: 'PRINTED', keys: [1] },
  scoring: { score: 2 },
  confidence: { score: 0.9, reasons: [] },
  placement: { page: 1 },
  asset_ids: [],
  ...extra,
});

const figure = (id) => ({
  id,
  kind: 'FIGURE',
  storage_key: `k/${id}.png`,
  placement: { page: 1, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
  alt: `${id} 的替代文字`,
  width: 120,
  height: 90,
});

// ── 題組共用的圖 ─────────────────────────────────────────────────

test('題組素材引用的圖會跟著子題帶進候選題', () => {
  const out = fromReading('job1', reading({
    groups: [{ id: 'g1', stimulus: '下表為各都市死亡人數：![[a:tbl]]' }],
    assets: [figure('tbl')],
    questions: [question({ group_id: 'g1', asset_ids: [] })],
  }), 0);

  const row = out.rows[0];
  assert.equal(row.groupKey, 'g1');
  assert.deepEqual(
    row.assets?.map((a) => a.id),
    ['tbl'],
    '題組的圖沒有帶進來，入庫後 stimulus 裡的標記會指不到任何東西',
  );
  assert.equal(row.assets[0].key, 'k/tbl.png');
});

test('題組的圖與子題自己的圖都在，而且不重複', () => {
  const out = fromReading('job1', reading({
    groups: [{ id: 'g1', stimulus: '![[a:tbl]] 與 ![[a:tbl]]' }],
    assets: [figure('tbl'), figure('f2')],
    questions: [question({ group_id: 'g1', asset_ids: ['f2', 'tbl'] })],
  }), 0);
  assert.deepEqual(out.rows[0].assets.map((a) => a.id).sort(), ['f2', 'tbl']);
});

// ── 表格 ─────────────────────────────────────────────────────────

test('沒裁成圖的表格，內容直接排進題幹而不是被丟掉', () => {
  // `apps/ai/pipeline/canonical.py` 明文允許表格只有 table_markdown
  // 而沒有裁出來的影像（表格常常沒有 bbox，裁圖那一步就 continue 過去）。
  const out = fromReading('job1', reading({
    assets: [{
      id: 't1', kind: 'TABLE', storage_key: null,
      table_markdown: MD, placement: { page: 3 }, alt: '死亡人數表',
    }],
    questions: [question({ stem: '根據 ![[a:t1]]，下列何者正確？', asset_ids: ['t1'] })],
  }), 0);

  const row = out.rows[0];
  assert.ok(!row.content.includes('![[a:t1]]'), `標記應該已經被表格取代：${row.content}`);
  assert.ok(row.content.includes('| 費城 | 7024 |'), row.content);
  // 前後補換行，否則第一列會黏在「根據」後面。
  assert.ok(row.content.includes('根據 \n|'), JSON.stringify(row.content));
  // 沒有物件鍵的資產不能留在 assets 裡：渲染端的 readAssets 會丟掉它，
  // 留著只會在畫面上變成一個破圖。
  assert.equal(row.assets, null);
  // 而且要說一聲，讓老師去對照原稿確認欄列沒有跑掉。
  assert.ok(
    row.confidenceReasons.some((r) => r.code === 'table_inlined'),
    JSON.stringify(row.confidenceReasons),
  );
});

test('題組素材與選項裡的表格一樣排得進去', () => {
  const out = fromReading('job1', reading({
    groups: [{ id: 'g1', stimulus: '下表：![[a:t1]]' }],
    assets: [{
      id: 't1', kind: 'TABLE', storage_key: null,
      table_markdown: MD, placement: { page: 3 },
    }, {
      id: 't2', kind: 'TABLE', storage_key: null,
      table_markdown: '| 甲 |\n|---|\n| 1 |', placement: { page: 3 },
    }],
    questions: [question({
      group_id: 'g1',
      options: [
        { order: 1, label: '(1)', content: '![[a:t2]]' },
        { order: 2, label: '(2)', content: '乙' },
      ],
      asset_ids: ['t2'],
    })],
  }), 0);

  const row = out.rows[0];
  assert.ok(row.stimulus.includes('| 費城 | 7024 |'), row.stimulus);
  assert.ok(row.options[0].content.includes('| 甲 |'), row.options[0].content);
  assert.equal(row.options[1].content, '乙');
});

test('什麼都沒有的圖不會被靜默丟掉——留著標記並標成 error', () => {
  // 這一種是真的不見了（裁圖失敗、沒有 bbox 又不是表格）。
  // 留著標記是刻意的：入庫那一關會擋下來並說出是哪一個，而校對頁
  // 上這一條 error 不會被信心分數蓋掉。刪掉標記等於刪掉唯一的線索。
  const out = fromReading('job1', reading({
    assets: [{
      id: 'f9', kind: 'FIGURE', storage_key: null,
      placement: { page: 7 }, alt: '電路圖',
    }],
    questions: [question({ stem: '如圖 ![[a:f9]]', asset_ids: ['f9'] })],
  }), 0);

  const row = out.rows[0];
  assert.ok(row.content.includes('![[a:f9]]'), '標記要留著，那是唯一的線索');
  assert.equal(row.assets, null);
  const bad = row.confidenceReasons.find((r) => r.code === 'asset_not_cropped');
  assert.ok(bad, JSON.stringify(row.confidenceReasons));
  assert.equal(bad.severity, 'error', 'warn 會被信心 0.9 的題目吃掉');
  assert.ok(bad.detail.includes('第 7 頁'), bad.detail);
  assert.ok(bad.detail.includes('電路圖'), bad.detail);
});

test('有裁出影像的圖照舊，一個欄位都不能少', () => {
  const out = fromReading('job1', reading({
    assets: [figure('f1')],
    questions: [question({ stem: '如右圖 ![[a:f1]]', asset_ids: ['f1'] })],
  }), 0);
  const a = out.rows[0].assets[0];
  assert.equal(a.id, 'f1');
  assert.equal(a.key, 'k/f1.png');
  assert.equal(a.page, 1);
  assert.equal(a.width, 120);
  assert.equal(a.height, 90);
  assert.equal(a.alt, 'f1 的替代文字');
});

// ── 取代本身 ─────────────────────────────────────────────────────

test('inlineTableAssets：沒有 id 或沒有內容的一律不動', () => {
  assert.equal(inlineTableAssets('![[a:t1]]', [{ table_markdown: MD }]), '![[a:t1]]');
  assert.equal(inlineTableAssets('![[a:t1]]', [{ id: 't1', table_markdown: '  ' }]), '![[a:t1]]');
  assert.equal(inlineTableAssets(null, [{ id: 't1', table_markdown: MD }]), null);
  assert.equal(inlineTableAssets('沒有標記', [{ id: 't1', table_markdown: MD }]), '沒有標記');
});

test('inlineTableAssets：同一個表格出現兩次都要換掉', () => {
  const out = inlineTableAssets('![[a:t1]] 中略 ![[a:t1]]', [{ id: 't1', table_markdown: '| 甲 |' }]);
  assert.equal(out.split('| 甲 |').length - 1, 2);
  assert.ok(!out.includes('![[a:t1]]'));
});
