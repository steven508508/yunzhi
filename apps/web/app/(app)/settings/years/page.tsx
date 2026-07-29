import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { mayUse } from '@/lib/nav';
import { Denied, Note } from '@/components/Feedback';
import YearEditor from './YearEditor';

export const dynamic = 'force-dynamic';

const AREA = '/settings/years';

export default async function YearsPage() {
  return scopedPage(async (user) => {
    if (!mayUse(user.systemRole, AREA)) {
      return (
        <main className="yz-panel">
          <Denied
            what="學年度設定"
            why="學年度決定全校班級的歸屬與成績統計範圍，只有校務管理員能改。"
          />
        </main>
      );
    }

    const years = await prisma.academicYear.findMany({
      orderBy: { startDate: 'desc' },
      include: { _count: { select: { classes: true } } },
    });

    /**
     * 每一年還有幾個啟用中的班、幾位在籍學生。
     *
     * 結算的確認視窗要說得出「7 個班會被封存、198 位學生會被記上離班
     * 日期」——只寫「確定要結算嗎」的話，看的人沒有任何判斷依據，
     * 而這是這一頁上唯一一個會同時動到兩百列名冊的動作。
     *
     * 一次查完再分組，不是每一年各查一次。
     */
    const liveClasses = await prisma.class.findMany({
      where: { active: true },
      select: {
        academicYearId: true,
        _count: { select: { memberships: { where: { leftAt: null, role: 'STUDENT' } } } },
      },
    });
    const live = new Map<string, { classes: number; members: number }>();
    for (const c of liveClasses) {
      const b = live.get(c.academicYearId) ?? { classes: 0, members: 0 };
      b.classes += 1;
      b.members += c._count.memberships;
      live.set(c.academicYearId, b);
    }

    // 當前學年度已經過期的話要說出來。`endDate` 在此之前只被用來顯示
    // 與驗證前後順序，**沒有任何程式檢查當前學年度是不是已經過去了**
    // ——而整個七月安裝的系統，當前學年度都是一個兩天後就到期的舊年度，
    // 於是接下來開的每一個班都掛錯年。
    const currentYear = years.find((y) => y.isCurrent) ?? null;
    const expired = currentYear !== null && currentYear.endDate < new Date();

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>學年度</h1>
          <p className="yz-panel__sub">
            每個班級都掛在一個學年度底下，所以<b>沒有學年度就開不了班</b>。
            「當前學年度」是開班、成績統計、學生看到哪一年的班這些地方的預設值，
            同一時間只會有一個。
          </p>
        </div>

        {years.length === 0 && (
          <Note tone="warn">
            還沒有任何學年度。先建一個，才走得到下一步（開班 → 匯名冊 → 派任務）。
          </Note>
        )}
        {expired && currentYear && (
          <Note tone="warn">
            目前的當前學年度「{currentYear.name}」已經在 {day(currentYear.endDate)} 結束了。
            現在開的班會掛在它底下，而學生的任務清單、班級列表也還以它為準。
            要開新學年度的班，請先建立下一個學年度並把它<b>設為當前</b>。
            舊的那一年收乾淨請用它那一列的「結算」。
          </Note>
        )}
        {years.length > 0 && !years.some((y) => y.isCurrent) && (
          <Note tone="warn">
            目前沒有任何一個學年度被設為「當前」。開班的表單會不知道該預選哪一年，
            日後的成績統計也沒有預設範圍。請挑一個設為當前。
          </Note>
        )}

        <YearEditor
          years={years.map((y) => ({
            id: y.id,
            name: y.name,
            startDate: day(y.startDate),
            endDate: day(y.endDate),
            isCurrent: y.isCurrent,
            classes: y._count.classes,
            activeClasses: live.get(y.id)?.classes ?? 0,
            activeMembers: live.get(y.id)?.members ?? 0,
          }))}
          suggestion={suggest(years.map((y) => y.name))}
        />
      </main>
    );
  });
}

/**
 * 日期只取到「日」。
 *
 * 用 UTC 切而不是 `toLocaleDateString`：資料是以 UTC 午夜存進去的
 * （見 lib/academicYear.ts），照本地時區換算的話，在 UTC+8 以外的
 * 機器上 8 月 1 日會顯示成 7 月 31 日。
 */
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * 新增表單的預設值。
 *
 * 在**伺服器端**算好再傳給表單，而不是在瀏覽器裡算：client component
 * 會先在伺服器渲染一次，兩邊的「今天」若跨了日界就會 hydration 不一致，
 * 而那個錯誤只在半夜出現一次，然後再也重現不了。
 *
 * 學年度以 8 月為界，7 月起就當成在準備下一個學年度——補習班的
 * 排課實務就是這樣，暑輔已經算新的一年。
 */
function suggest(existing: string[]) {
  const now = new Date();
  const startYear = now.getMonth() + 1 >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const roc = startYear - 1911;
  // 已經有 115學年度 的話就往後推一年，省得建立時才撞到重複。
  const offset = existing.includes(`${roc}學年度`) ? 1 : 0;
  return {
    name: `${roc + offset}學年度`,
    startDate: `${startYear + offset}-08-01`,
    endDate: `${startYear + offset + 1}-07-31`,
  };
}
