/**
 * AI 老師看一次學生自己查來的升學資料。
 *
 * # 為什麼是 POST 而不是 GET
 *
 * 因為它會呼叫模型、花錢、而且**寫一列 `AiUsageLog`**。那一列同時是
 * 成本歸因與 AI 使用揭露的證據（規格書 §2.3 與教育部 113 年 12 月 13 日
 * 函文要求學生在學習歷程中標註 AI 使用）。做成 GET 的話，瀏覽器的預先
 * 連線、預載、與任何一次重新整理都會產生一次「AI 互動」記錄——而那份
 * 記錄是要拿去產生揭露聲明的，多算的每一次都讓那份聲明變成不實陳述。
 *
 * # 這一支不判斷輸出可不可以送出去
 *
 * 那道閘門在 `lib/adviceGuard.mjs`（純函式，58 項測試），編排在
 * `lib/admissionRefDb.ts` 的 `adviceFor()`：生成 → 檢查 → 不過就重來，
 * 三次都不過就退回一段由程式組出來的、只陳述事實的版本。
 *
 * 這裡回應裡的 `fellBack` 與 `blockedDrafts` **要送給前端**，因為畫面上
 * 要說得出「這一段不是 AI 寫的，是系統整理的」。不說的話，學生會把一段
 * 罐頭當成 AI 的判斷。
 *
 * # 為什麼 `blockedReasons` 也回去
 *
 * 因為它是這個功能有沒有在做事的唯一證據。老師問「這個 AI 到底有沒有
 * 亂講」時，答案是「它三次都想給機率，都被擋掉了」——那句話要說得出來。
 * 內容是規則碼與說明，不含被擋掉的草稿本身（那一段正是因為製造了假的
 * 精確度才被擋的，沒有理由送到瀏覽器上）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  ReferenceError as RefError,
  admissionYearOf,
  adviceFor,
} from '@/lib/admissionRefDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  year: z.number().int().min(100).max(200).optional(),
  /** 學生想問的一句話。空的也可以——那時 AI 就看資料本身。 */
  question: z.string().trim().max(500).optional(),
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json(
      { error: '這一段是學生看自己查來的資料。老師要看班上的狀況：進「班級」點一個班，那一頁上有「升學總覽」。' },
      { status: 403 },
    );
  }

  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  const year = parsed.data.year ?? admissionYearOf();

  try {
    const out = await adviceFor({ userId: user.id, year, question: parsed.data.question });
    return NextResponse.json({
      year,
      text: out.text,
      /** true 代表這一段是系統整理的，不是 AI 寫的。畫面要說出來。 */
      fellBack: out.fellBack,
      blockedDrafts: out.blockedDrafts,
      blockedReasons: out.blockedReasons,
      promptVersion: out.promptVersion,
      gaps: out.basis.gaps,
    });
  } catch (e) {
    if (e instanceof RefError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error('[advice] 未預期的錯誤', e);
    return NextResponse.json(
      { error: 'AI 老師出了點問題。你查到的資料都還在，稍後再試一次。' },
      { status: 500 },
    );
  }
});
