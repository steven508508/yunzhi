import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { mayUse } from '@/lib/nav';
import { Denied, Note } from '@/components/Feedback';
import { STANDARD_CODES } from '@/lib/subjects.mjs';
import SubjectEditor from './SubjectEditor';

export const dynamic = 'force-dynamic';

const AREA = '/settings/subjects';

export default async function SubjectsPage() {
  return scopedPage(async (user) => {
    if (!mayUse(user.systemRole, AREA)) {
      return (
        <main className="yz-panel">
          <Denied
            what="科目設定"
            why="科目決定題庫、卷子與成績的分類方式，加一科或停一科會影響全機構每一個科目選單，所以只有校務管理員能改。"
          />
        </main>
      );
    }

    const subjects = await prisma.subject.findMany({
      orderBy: { order: 'asc' },
      include: {
        _count: {
          select: { questions: true, examPapers: true, knowledgePoints: true, classTeachers: true },
        },
      },
    });

    // 合科的名字要跟著使用者改過的名稱走，不能顯示代碼——老師在畫面上
    // 認得的是「自然」，不是 SCIENCE。
    const nameOfCode = new Map(subjects.map((s) => [s.code, s.name]));

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>科目</h1>
          <p className="yz-panel__sub">
            學測的 13 科在系統安裝時就建好了，這一頁是用來<b>改成貴機構的講法</b>
            （「公民」與「公民與社會」）、<b>加上學測以外的科目</b>（作文班、英聽），
            以及<b>停用不開的科目</b>——停用之後它不會再出現在匯入、組卷與知識點的科目選單裡。
          </p>
        </div>

        {subjects.length === 0 && (
          <Note tone="warn">
            一個科目都沒有。正常情況下安裝時就會建好學測的 13 科，
            這裡是空的表示開機的初始化沒有跑完（<code>migrate-and-seed</code>）。
            沒有科目就匯不了題、建不了卷子——請先在下面手動補一科，
            或請維運人員重跑一次初始化。
          </Note>
        )}

        <SubjectEditor
          subjects={subjects.map((s) => ({
            id: s.id,
            code: s.code,
            name: s.name,
            parentCode: s.parentCode,
            parentName: s.parentCode ? (nameOfCode.get(s.parentCode) ?? null) : null,
            gsatFullScore: s.gsatFullScore,
            active: s.active,
            standard: STANDARD_CODES.has(s.code),
            questions: s._count.questions,
            papers: s._count.examPapers,
            knowledgePoints: s._count.knowledgePoints,
            teachers: s._count.classTeachers,
          }))}
          // 只有合科能當上層（見 lib/subjects.mjs 的 checkParentCode），
          // 所以下拉裡先濾掉分科——讓人選得到一個一定會被退回的選項，
          // 是最沒有必要的一種挫折。
          parents={subjects
            .filter((s) => !s.parentCode)
            .map((s) => ({ code: s.code, name: s.name }))}
        />
      </main>
    );
  });
}
