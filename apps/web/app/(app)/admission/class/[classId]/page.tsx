/**
 * 一個班的升學狀況總覽（老師）。
 *
 * # 為什麼這一頁沒有在校成績百分比
 *
 * 規格書 §3 把「在校成績百分比」給的是**輔導老師**（所帶班級）與
 * **繁星承辦**（全校），而這一階段沒有 `ClassRole.COUNSELOR` 這個職權
 * 可用（新增角色要動 schema，見 `lib/admissionDb.ts` 的檔頭）。
 *
 * 在分不出「一般老師」與「輔導老師」的時候，這一欄往保守的方向倒：
 * **少看到一欄是可以被回報的症狀，全校的相對名次流到不該看的人手上
 * 不是。** 承辦人那一側（`/admission/star`）看得到，而那條路徑寫稽核。
 *
 * # 為什麼排序是「規劃衝突最多的排最前面」
 *
 * 因為老師打開這一頁的目的不是點名，是找出**需要找他談的那幾位**。
 * 照學號排的話，一位六個志願全部注定作廢的學生會排在第 23 個。
 */
import Link from 'next/link';

import { admissionYearOf, classAdmissionOverview } from '@/lib/admissionDb';
import { isHomeroomOf } from '@/lib/auth';
import { mayUse } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { teachesClass } from '@/lib/teaching';
import { Denied, Empty, Note } from '@/components/Feedback';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

export default async function ClassAdmissionPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const { classId } = await params;

  return scopedPage(async (user) => {
    if (!mayUse(user.systemRole, '/classes')) {
      return (
        <main className="yz-panel">
          <Denied
            what="班級的升學總覽"
            why={
              <>
                這一頁是老師看所帶班級的。你自己的升學規劃在
                <Link href="/admission">升學規劃</Link>那一頁。
              </>
            }
          />
        </main>
      );
    }

    const klass = await prisma.class.findFirst({
      where: { id: classId },
      select: { id: true, name: true },
    });
    if (!klass) {
      return (
        <main className="yz-panel">
          <Empty title="找不到這個班級" action={<Link href="/classes">回班級</Link>} />
        </main>
      );
    }

    // 帶班的判定與班級頁一致：管理員全部、老師限自己帶的班。
    const allowed =
      ADMIN.has(user.systemRole) ||
      (await isHomeroomOf(user.id, classId)) ||
      (await teachesClass(user.id, classId));
    if (!allowed) {
      return (
        <main className="yz-panel">
          <Denied
            what={`「${klass.name}」的升學總覽`}
            why="你不是這個班的導師或授課老師。"
          />
        </main>
      );
    }

    const year = admissionYearOf();
    const rows = await classAdmissionOverview(classId, year);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>{klass.name}：升學狀況</h1>
          <p className="yz-panel__sub">
            {year} 學年度 · {rows.length} 位學生 · 規劃衝突多的排在前面
          </p>
        </div>

        <Note tone="info">
          這一頁<strong>不顯示在校成績百分比</strong>。那是全校最敏感的一份資料，
          規格上只給輔導老師與繁星承辦——而系統目前分不出「一般老師」與「輔導老師」，
          所以往保守的方向倒。要看繁星的校內競爭分布請找教務處（繁星承辦）。
        </Note>

        {rows.length === 0 ? (
          <Empty
            title="這個班還沒有學生"
            action={<Link href={`/classes/${classId}`}>去名冊</Link>}
          />
        ) : (
          <table className="yz-table">
            <thead>
              <tr>
                <th scope="col">學生</th>
                <th scope="col" className="yz-table__num">
                  志願
                </th>
                <th scope="col" className="yz-table__num">
                  繁星
                </th>
                <th scope="col" className="yz-table__num">
                  個申
                </th>
                <th scope="col">目前不能報名的管道</th>
                <th scope="col" className="yz-table__num">
                  規劃衝突
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId}>
                  <td>
                    <Link href={`/classes/${classId}/students/${r.userId}`}>{r.displayName}</Link>
                    <span className="yz-adm__count">{r.username}</span>
                  </td>
                  <td className="yz-table__num">{r.wishes}</td>
                  <td className="yz-table__num">{r.starWishes}</td>
                  <td className="yz-table__num">{r.applyWishes}</td>
                  <td>
                    {r.blocked.length === 0 ? (
                      <span className="yz-adm__count">都可以</span>
                    ) : (
                      r.blocked.join('、')
                    )}
                  </td>
                  <td className="yz-table__num">
                    {r.conflicts > 0 ? (
                      <span className="yz-warn">{r.conflicts}</span>
                    ) : (
                      r.conflicts
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="yz-hint" style={{ marginTop: 18 }}>
          「規劃衝突」不是錯誤，是<strong>注定互斥的組合</strong>——例如同時填了繁星第 3 類與
          六個個人申請志願（若繁星錄取，那六個全部失效，而且放棄繁星也無法挽回）。
          系統不阻擋學生這樣規劃，只把後果講清楚。數字大的那幾位值得找來談一次。
        </p>
      </main>
    );
  });
}
