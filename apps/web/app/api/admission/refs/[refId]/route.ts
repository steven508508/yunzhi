/**
 * 改一筆、或刪掉一筆自己查來的資料。
 *
 * 「不是他的」與「不存在」回一模一樣的 404。分開回的話，這一支就變成
 * 一個查詢別人有沒有輸入某筆資料的工具——攻擊者拿一串 cuid 試過去，
 * 403 與 404 的差別就是答案。`deleteReference()` 與 `updateReference()`
 * 都用 `[id, userId]` 一起查，所以它們連「存在但不是你的」都分不出來。
 *
 * 與 `wishes/[wishId]` 完全相同的處理。這一支存在的理由是它的資料更敏感
 * ——那張表裡有 `MY_PERCENTILE`，也就是這位學生的在校成績百分比。
 *
 * PATCH 能改的是**數字、來源、查詢日期與備註**；校名、學年度與資料種類
 * 不能改（理由見 `updateReference()`：改掉它們是把這一列搬到另一條趨勢
 * 裡去，而畫面上看起來只是改了一個欄位）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { SOURCE_KINDS } from '@/lib/admissionRef.mjs';
import {
  ReferenceError as RefError,
  admissionYearOf,
  deleteReference,
  referenceBasis,
  updateReference,
} from '@/lib/admissionRefDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const SOURCES = SOURCE_KINDS.map((s: { value: string }) => s.value) as [string, ...string[]];

const Patch = z.object({
  /** 依這一筆的 `kind` 的形狀填。驗證與正規化在 `buildRefValue()`。 */
  raw: z.record(z.unknown()).optional(),
  sourceKind: z.enum(SOURCES).optional(),
  sourceRef: z.string().trim().min(1).max(300).optional(),
  lookedUpAt: z.string().min(4).optional(),
  note: z.string().trim().max(500).nullish(),
});

export const PATCH = scopedRoute<{ refId: string }>(async (req: NextRequest, { user, params }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json({ error: '這些資料由學生本人維護' }, { status: 403 });
  }

  const parsed = Patch.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: `「${first?.path.join('.') || '參數'}」這一欄不正確。` },
      { status: 400 },
    );
  }

  try {
    const out = await updateReference(user.id, params.refId, parsed.data);
    if (!out) return NextResponse.json({ error: '找不到這一筆資料' }, { status: 404 });
  } catch (e) {
    if (e instanceof RefError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // 回重算後的完整基礎（含缺口與信任度）。改一個數字之後最想知道的
  // 就是「那我現在的判斷變成什麼」——與新增那一支同一個理由。
  const year = Number(new URL(req.url).searchParams.get('year')) || admissionYearOf();
  return NextResponse.json(await referenceBasis(user.id, year));
});

export const DELETE = scopedRoute<{ refId: string }>(async (req: NextRequest, { user, params }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json({ error: '這些資料由學生本人維護' }, { status: 403 });
  }
  const ok = await deleteReference(user.id, params.refId);
  if (!ok) return NextResponse.json({ error: '找不到這一筆資料' }, { status: 404 });

  const year = Number(new URL(req.url).searchParams.get('year')) || admissionYearOf();
  return NextResponse.json(await referenceBasis(user.id, year));
});
