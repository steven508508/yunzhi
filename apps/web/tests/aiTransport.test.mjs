/**
 * 與 AI 服務的 HTTP 傳輸。
 *
 * **實地故障：** 一份數學講義跑到自答階段，畫面顯示
 *
 *     AI 自答失敗：無法連線 AI 服務（http://ai:8000）：fetch failed
 *
 * 網路是好的。是 Node 的 global fetch 走 undici，而 undici 的
 * `headersTimeout` 預設 300 秒——import-pipeline.mjs 的 STAGE_TIMEOUT_MS
 * 給 SOLVING 開了 30 分鐘，undici 卻在第 5 分鐘把連線砍掉。50 題各投
 * 3 票、用 HIGH 模型跑，五分鐘內送不出回應標頭是常態。
 *
 * 實測（node v22）：fetch 在第 301 秒拋 `fetch failed`，
 * `e.cause.code === 'UND_ERR_HEADERS_TIMEOUT'`。
 *
 * 這裡不重跑那個 5 分鐘的實驗——CI 不該為此等五分鐘。改為固定住
 * 兩件會讓故障重演的事：管線不得使用 global fetch 打 AI 服務，
 * 以及連線錯誤必須帶出 `e.cause`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'import-pipeline.mjs'),
  'utf8',
);

test('不用 global fetch 打 AI 服務（undici 的 5 分鐘標頭逾時會砍掉長階段）', () => {
  const callAI = SRC.slice(SRC.indexOf('async function callAI'), SRC.indexOf('// 成本'));
  assert.ok(
    !/\bawait fetch\(|\bfetch\(`/.test(callAI),
    'callAI 又改回 fetch 了：undici 會在第 300 秒放棄，而 SOLVING 有 30 分鐘的預算',
  );
});

test('用 node:http，且明確關掉傳輸層逾時', () => {
  assert.ok(SRC.includes("from 'node:http'"), '應該用 node:http');
  assert.ok(/timeout:\s*0/.test(SRC), 'timeout 要明確設 0，交給 AbortSignal 統一負責');
});

test('連線失敗時帶出 e.cause', () => {
  assert.ok(
    SRC.includes('e.cause?.code'),
    'ECONNREFUSED（沒起來）、ECONNRESET（被 OOM 砍）、EAI_AGAIN（DNS）' +
      '的處置完全不同，只印 e.message 會讓三者長成同一句話',
  );
});

test('AbortSignal 仍然是唯一的逾時來源', () => {
  assert.ok(SRC.includes('controller.abort()'), '階段逾時要留著');
  assert.ok(SRC.includes("e.name === 'AbortError'"), '逾時要能被辨認成階段逾時而非連線失敗');
});
