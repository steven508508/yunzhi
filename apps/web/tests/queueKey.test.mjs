/**
 * BullMQ 自訂 job id 的格式。
 *
 * 這一支測試存在的理由：`jobId: \`import:${jobId}\`` 讓匯入功能
 * 在 v0.27.5 之前**從來沒有成功過**，而症狀完全指向別的地方——
 * 資料庫的匯入工作已經建好、畫面顯示「已排隊」，入列卻拋錯，
 * 於是 worker 永遠等不到東西。使用者與維護者看到的是
 * 「排隊超過兩分鐘還沒開始，多半是背景工作者沒在跑」。
 *
 * BullMQ 的 Redis key 以 `:` 分段，所以它拒絕含冒號的自訂 id
 * （bullmq 5.x：`throw new Error('Custom Id cannot contain :')`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importJobKey } from '../lib/queueKey.mjs';

test('importJobKey 不含冒號（BullMQ 會拒絕）', () => {
  assert.ok(!importJobKey('abc123').includes(':'));
  assert.ok(!importJobKey('550e8400-e29b-41d4-a716-446655440000').includes(':'));
});

test('importJobKey 對不同的匯入工作產生不同的 id', () => {
  assert.notEqual(importJobKey('a'), importJobKey('b'));
});

test('importJobKey 保留原始 jobId，續跑查得回同一筆', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  assert.ok(importJobKey(id).endsWith(id));
});
