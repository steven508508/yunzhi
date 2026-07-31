/**
 * 學生把自己查到的升學資料輸入進來。
 *
 * # 為什麼沒有 `?student=` 這種參數
 *
 * 與 `app/api/admission/profile/route.ts` 同一個理由：RLS 擋得住別家
 * 補習班，擋不住隔壁同學。而這張表裡有一種資料是同班同學最想看的
 * ——`MY_PERCENTILE`，他自己的在校成績百分比。多一個參數就多一個要
 * 自己比對 `userId` 的地方。
 *
 * # 這一支不驗證那個數字對不對
 *
 * 學生可能查錯、抄錯、或聽同學說的。系統**沒有辦法驗**——那份資料本來
 * 就只有官方網站有，而系統不去抓（招聯會全站 robots.txt 禁止爬取，
 * 文件 07 §2.1，這是專案的硬規則）。
 *
 * 系統能做的是另一件事：**把來源與查詢日期記下來，讓那筆資料自己說明
 * 它值多少信任。** 所以這裡唯一會回 4xx 的是「來源沒選」「日期沒填」
 * 與「`value` 的形狀對不上 `kind`」，而不是「這個百分比看起來不對」。
 *
 * # 來源類型的選項裡一定要有「聽同學說的」
 *
 * 不給那個選項的話，學生會選「官方文件」——他手上就是有一個數字，
 * 而選單裡沒有一個選項描述得出它的來歷。那筆資料從此帶著一個假的
 * 可信度，而且再也分不出來。選項清單在 `lib/admissionRef.mjs` 的
 * `SOURCE_KINDS`，有測試釘著 `HEARSAY` 不能被拿掉。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { REF_KINDS, SOURCE_KINDS } from '@/lib/admissionRef.mjs';
import {
  ReferenceError as RefError,
  addReference,
  admissionYearOf,
  referenceBasis,
} from '@/lib/admissionRefDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const KINDS = REF_KINDS.map((k) => k.value) as [string, ...string[]];
const SOURCES = SOURCE_KINDS.map((s) => s.value) as [string, ...string[]];

const Body = z.object({
  /** 民國學年度。**這一筆資料屬於哪一年**，不是今年。 */
  year: z.number().int().min(100).max(200),
  channel: z.enum(['SPECIAL', 'STAR', 'APPLY', 'PLACEMENT']),
  kind: z.enum(KINDS),
  institutionName: z.string().trim().min(1).max(60),
  programName: z.string().trim().max(80).nullish(),
  starGroup: z.number().int().min(1).max(8).nullish(),
  /** 依 `kind` 的形狀填。驗證與正規化在 `buildRefValue()`。 */
  raw: z.record(z.unknown()).default({}),
  /** 來源。**必填**，理由見檔頭。 */
  sourceKind: z.enum(SOURCES),
  sourceRef: z.string().trim().min(1).max(300),
  /** 查到的日期。**必填。** */
  lookedUpAt: z.string().min(4),
  /** 超過這個學年度就標成過期。預設等於 `year`。 */
  staleAfterYear: z.number().int().min(100).max(200).nullish(),
  note: z.string().trim().max(500).nullish(),
});

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json(
      { error: '這一支回的是學生自己查來的資料。老師要看班上的狀況：進「班級」點一個班，那一頁上有「升學總覽」。' },
      { status: 403 },
    );
  }
  const year = Number(new URL(req.url).searchParams.get('year')) || admissionYearOf();
  // `referenceBasis()` 的回傳裡本來就帶 `year`，不要再疊一個上去。
  return NextResponse.json(await referenceBasis(user.id, year));
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json({ error: '這些資料由學生本人輸入' }, { status: 403 });
  }

  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    // 訊息要說得出缺哪一欄。「參數不正確」在一張有九個欄位的表單上
    // 等於什麼都沒說，而使用者的下一步是把每一欄都重填一次。
    const first = parsed.error.issues[0];
    const where = first?.path.join('.') || '';
    const NAMES: Record<string, string> = {
      sourceKind: '來源類型',
      sourceRef: '從哪裡查到的',
      lookedUpAt: '查到的日期',
      kind: '資料種類',
      institutionName: '大學',
      year: '學年度',
    };
    return NextResponse.json(
      {
        error: where
          ? `「${NAMES[where] ?? where}」這一欄不正確或沒有填。`
          : '參數不正確',
      },
      { status: 400 },
    );
  }

  try {
    await addReference(user.id, parsed.data);
  } catch (e) {
    if (e instanceof RefError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // 回的是重算後的完整基礎（含缺口與信任度），而不是「ok」。學生輸入
  // 一筆之後最想知道的就是「那我還缺什麼」——讓畫面不必再問一次。
  return NextResponse.json(await referenceBasis(user.id, parsed.data.year));
});
