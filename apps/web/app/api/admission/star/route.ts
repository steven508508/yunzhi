/**
 * 繁星校內賽局的查詢。
 *
 * # 同一支路由，兩種回應，而且形狀完全不同
 *
 * 學生拿到的是**自己的序位**；承辦人拿到的是**全校分布**。
 * 不是同一份資料加一個「唯讀」旗標——那是這一類設計最常見的錯，
 * 而它的失效方式是有人在共用的那一份裡多加一個欄位，然後全校的
 * 在校成績百分比出現在學生的瀏覽器裡。
 *
 * 兩條路徑的分野落在 `lib/admissionDb.ts`：學生走 `myStarPosition()`
 * → `studentView()`，那個純函式的輸出裡**組不出**別人的 id、姓名、
 * 百分比或參與人數（見 `lib/star.mjs` §3，以及 tests/star.test.mjs
 * 裡對序列化字串下斷言的那一組測試）。承辦人走
 * `starCoordinatorReport()`，那一支每次都寫稽核。
 *
 * # 為什麼是 GET
 *
 * 因為它不寫任何業務資料。承辦人那一側會寫一列稽核，而稽核記錄是
 * 「這次讀取發生過」的副作用，不是被讀取的資料本身——把它改成 POST
 * 只會讓「看一眼名單」變成一個需要表單的動作，而承辦人在三月會看
 * 幾十次。
 */
import { NextRequest, NextResponse } from 'next/server';

import {
  admissionYearOf,
  isStarCoordinator,
  myStarPosition,
  starCoordinatorReport,
} from '@/lib/admissionDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  const year = Number(new URL(req.url).searchParams.get('year')) || admissionYearOf();
  const scope = new URL(req.url).searchParams.get('scope');

  if (scope === 'school') {
    if (!isStarCoordinator(user)) {
      // 訊息要說得出原因，而且要與實際的名單一致。這個 403 打到的是
      // 老師與學科召集人——**系統管理員在名單裡**（單一機構自架時，
      // 承辦人就是他；見 lib/admissionDb.ts 的檔頭）。
      return NextResponse.json(
        {
          error:
            '全校繁星檢視只有繁星承辦（校務管理員與系統管理員）看得到——它一次就露出' +
            '全校每一位學生的相對名次，而每一次進入都會寫一筆稽核記錄。' +
            '老師要看所帶班級的升學狀況：進「班級」點一個班，那一頁上有「升學總覽」。',
        },
        { status: 403 },
      );
    }
    const { report, nameOf } = await starCoordinatorReport(year, user);
    return NextResponse.json({ scope: 'school', year, report, nameOf });
  }

  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json(
      { error: '這一支回的是學生自己的校內序位。承辦人要看全校請帶 scope=school。' },
      { status: 403 },
    );
  }
  return NextResponse.json({ scope: 'self', year, position: await myStarPosition(user.id, year) });
});
