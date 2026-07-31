/**
 * 學生自己的升學管道狀態。
 *
 * # 為什麼沒有 `?student=` 這種參數
 *
 * 因為升學狀態是「我特選上了沒有、我放棄了沒有」這一類的事，而它決定
 * 後面三個管道能不能報名。多一個參數就多一個要自己比對 `userId` 的
 * 地方——RLS 擋得住別家補習班，擋不住隔壁同學。老師要看一個班的狀況
 * 走 `/admission/class/[classId]`，那邊有帶班的判定，而且看得到的東西
 * 完全不同（只有摘要，沒有可寫入的路徑）。
 *
 * # 為什麼放棄不會把繁星類別清成 NONE
 *
 * 因為那正是規格書 §5.2 警告的那個錯誤。學生按下「我放棄繁星」時，
 * 若順手把 `starCategory` 設回 `NONE`，系統就再也分不出他原本是第 3 類
 * （個申永久封鎖）還是第 8 類（可報名但不可登記志願序），而畫面上
 * 一切正常。所以 `saveProfile()` 只寫 `starWaived`，類別留著。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { STAR_CATEGORIES } from '@/lib/admission.mjs';
import { admissionStatus, admissionYearOf, saveProfile } from '@/lib/admissionDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /** 民國學年度。不給就是現在這一個。 */
  year: z.number().int().min(100).max(200).optional(),
  isRepeater: z.boolean().optional(),
  sameSchoolAll: z.boolean().optional(),
  specialAdmitted: z.boolean().optional(),
  specialWaived: z.boolean().optional(),
  starCategory: z.enum(STAR_CATEGORIES as unknown as [string, ...string[]]).optional(),
  starWaived: z.boolean().optional(),
  applyAdmitted: z.boolean().optional(),
  applyWaived: z.boolean().optional(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json(
      { error: '升學狀態由學生本人維護。老師要看班上的狀況：進「班級」點一個班，那一頁上有「升學總覽」。' },
      { status: 403 },
    );
  }

  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  }
  const { year, ...patch } = parsed.data;
  const y = year ?? admissionYearOf();

  await saveProfile(user.id, y, patch);
  // 回的是重算後的完整判定，而不是「ok」。學生按下「我放棄繁星」的
  // 下一秒最想知道的就是「那我現在能報什麼」——讓畫面不必再問一次。
  return NextResponse.json(await admissionStatus(user.id, y));
});
