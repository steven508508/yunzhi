import Link from 'next/link';

import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { mayUse } from '@/lib/nav';
import { inspectGraph } from '@/lib/knowledge';
import { Denied, Empty, Note } from '@/components/Feedback';
import KpEditor from './KpEditor';

export const dynamic = 'force-dynamic';

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string }>;
}) {
  const sp = await searchParams;
  return scopedPage(async (user) => {
    // 知識點圖譜是能力分析的座標系，改它會影響整科所有學生的分析結果——
    // 學生與家長連讀都不該讀到（那等於一份教學進度表）。
    if (!mayUse(user.systemRole, '/knowledge')) {
      return (
        <main className="yz-panel">
          <Denied what="知識點圖譜" why="這是老師規劃教學與能力分析用的結構。" />
        </main>
      );
    }

    const subjects = await prisma.subject.findMany({
      where: { active: true },
      orderBy: { order: 'asc' },
      select: { id: true, name: true, code: true },
    });
    if (subjects.length === 0) {
      return (
        <main className="yz-panel">
          <Empty title="還沒有科目" hint="請先由管理員建立科目。" />
        </main>
      );
    }

    const current = subjects.find((s) => s.id === sp.subject) ?? subjects[0];
    const [points, health] = await Promise.all([
      prisma.knowledgePoint.findMany({
        where: { subjectId: current.id },
        orderBy: { name: 'asc' },
        include: {
          prerequisites: { select: { prereqKpId: true } },
          _count: { select: { questions: true } },
        },
      }),
      inspectGraph(current.id),
    ]);

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>知識點圖譜</h1>
          <p className="yz-panel__sub">
            知識點是能力分析的座標系，也是智慧老師往回補前置觀念時走的路。
            匯入題本時的自動標註也是從這裡挑候選——
            <b>這張表是空的話，標註階段等於沒有作用</b>。
          </p>
        </div>

        <nav style={{ display: 'flex', gap: 14, marginBottom: 18, fontSize: 12.5 }}>
          {subjects.map((s) => (
            <Link
              key={s.id}
              href={`/knowledge?subject=${s.id}`}
              style={{
                fontWeight: s.id === current.id ? 600 : 400,
                borderBottom: s.id === current.id ? '2px solid var(--ink)' : 'none',
                paddingBottom: 2,
              }}
            >
              {s.name}
            </Link>
          ))}
        </nav>

        {health.cycles.length > 0 && (
          <Note tone="error">
            這一科的前置關係有 {health.cycles.length} 個循環：
            {health.cycles.map((c) => c.join(' → ')).join('；')}。
            循環會讓智慧老師往回找前置觀念時無限繞圈，請移除路徑上的其中一條關係。
          </Note>
        )}
        {points.length > 0 && points.length < 8 && (
          <Note tone="warn">
            「{current.name}」目前只有 {points.length} 個知識點。
            一科通常需要 30 到 60 個才有分析價值——文件 05 估每科要 4 到 8 小時的
            老師工時，這筆時間要排進去。建議先做完一科再擴充。
          </Note>
        )}

        <KpEditor
          subjectId={current.id}
          subjectName={current.name}
          points={points.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            questions: p._count.questions,
            prereqs: p.prerequisites.map((x) => x.prereqKpId),
          }))}
          teachingOrder={health.teachingOrder}
        />
      </main>
    );
  });
}
