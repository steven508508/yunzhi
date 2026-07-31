/**
 * 在校成績百分比的匯入。教務處的動作。
 *
 * # 這是本模組唯一一支「寫入全校最敏感資料」的路由
 *
 * `AcademicRank` 是五學期在校成績的**全校排名百分比**。它是繁星校內
 * 賽局的唯一輸入，也是規格書 §7.5 特別點出來要保護的那一張表。
 * 所以這裡：
 *
 *   · 只有繁星承辦（＝校務管理員，見 `lib/admissionDb.ts` 檔頭）進得來
 *   · 每一次匯入寫一列稽核（在 `importAcademicRanks()` 裡）
 *   · 回應**不含任何一位學生的百分比**——只回「進了幾筆、跳過哪幾列
 *     以及為什麼」。承辦人要核對數字就去看原始的 CSV，那份檔案在他
 *     自己手上。一支匯入 API 把剛寫進去的敏感資料再回吐一次，
 *     等於在瀏覽器的記錄裡留一份全校名單。
 *
 * # 為什麼不是兩段式（先試算再寫入）
 *
 * 名冊匯入是兩段式，因為它會**建帳號**。這一張表是逐年一列、以
 * `[userId, year]` 為唯一鍵的純資料，匯錯了再匯一次就蓋掉。
 * 理由詳見 `lib/admissionDb.ts` 的 `importAcademicRanks()`。
 */
import { NextRequest, NextResponse } from 'next/server';

import { admissionYearOf, importAcademicRanks, isStarCoordinator } from '@/lib/admissionDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/** 300 位學生的百分比是幾 KB。超過這個數字通常代表選錯檔了。 */
const MAX_BYTES = 1024 * 1024;

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (!isStarCoordinator(user)) {
    return NextResponse.json(
      {
        error:
          '在校成績百分比由繁星承辦匯入（校務管理員與系統管理員）。這是全校最敏感的' +
          '一份資料，所以名單很短，而且每一次全校檢視都會寫一筆稽核記錄。',
      },
      { status: 403 },
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: '請選擇一個 CSV 檔' }, { status: 400 });
  }
  if (file.size === 0) return NextResponse.json({ error: '這個檔案是空的' }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `檔案超過 ${MAX_BYTES / 1024 / 1024} MB。這通常代表選錯檔了。` },
      { status: 413 },
    );
  }

  const year = Number(form?.get('year')) || admissionYearOf();
  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    const result = await importAcademicRanks(bytes, year, user);
    return NextResponse.json({ ok: true, year, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
});
