/**
 * 一個班在一個科目上的弱點。
 *
 * # 這一頁回答的是段考後班務會議的第一個問題
 *
 * 「這一次哪一題全班最不會」在單份任務的成績頁上早就答得出來，但那
 * 回答不了「**下一堂課要重講哪一個章節**」——一題是一題，章節是
 * 跨越好幾份卷子的東西。班級成績頁與學生頁上原本各有一句話寫著
 * 「還給不出章節分析」，這一頁就是那兩句話的補救。
 *
 * # 兩個維度分開看，因為它們是兩件事
 *
 *   **知識點**（章節）→ 讀能力快照。時間加權過，回答的是「現在」，
 *   不是「這學期的平均」。一個班九月不會、十月補起來了，這裡要看得出來。
 *
 *   **題型** → 讀作答記錄。業主明講要「題目類型」的分析，而它與知識點
 *   互相獨立：一個班可能每個章節都還好，但多選題全班都在扣分——
 *   那是作答策略的問題（不敢猜、不會用部分給分），不是內容的問題。
 *
 * # 空的時候要說得出為什麼
 *
 * **這一頁最可能的狀態就是空的。** 知識點圖譜要老師自己建（文件 05
 * 估每科 4 到 8 小時），而在建完之前，題目上沒有知識點標註，
 * 快照就沒有東西可以算。一片空白會被讀成「這個班沒有弱點」，
 * 所以卡在哪一關就要說哪一關：沒有知識點、有知識點但題目沒標、
 * 都有但還沒重建過、都有但還沒考試。四種的下一步完全不同。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { classAbility, MIN_CLASS_SAMPLE, SOLID, WEAK } from '@/lib/abilityDb';
import { isHomeroomOf } from '@/lib/auth';
import { mayUse } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { scopedPage } from '@/lib/page';
import { TYPE_LABELS } from '@/lib/questionEdit.mjs';
import { teachesClass } from '@/lib/teaching';
import { Denied, Empty, Note } from '@/components/Feedback';
import { Table } from '@/components/Table';
import Rebuild from './Rebuild';

export const dynamic = 'force-dynamic';

const ADMIN = new Set(['SYS_ADMIN', 'SCHOOL_ADMIN']);

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * 掌握度的長條。純 CSS，與各題答對率那一條同一個做法——這是要部署在
 * 補習班機房（封閉網段）的自架系統，為了一條 3px 的線引入一個圖表
 * 套件，是把一個離線安裝的問題加進來換一個裝飾。
 */
function Bar({ value, low }: { value: number; low: boolean }) {
  return (
    <span className={`yz-rate ${low ? 'yz-rate--low' : ''}`}>
      <span className="yz-rate__num">{pct(value)}</span>
      <span className="yz-rate__bar">
        <span className="yz-rate__fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
    </span>
  );
}

export default async function ClassAbilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ classId: string }>;
  searchParams: Promise<{ subject?: string }>;
}) {
  const { classId } = await params;
  const sp = await searchParams;

  return scopedPage(async (user) => {
    if (!mayUse(user.systemRole, '/classes')) {
      return (
        <main className="yz-panel">
          <Denied
            what="班級的能力分析"
            why="這一頁是全班每一位學生的弱點，屬於老師與管理員的工作區。學生看的是自己的分析。"
          />
        </main>
      );
    }

    const klass = await prisma.class.findFirst({
      where: { id: classId },
      select: { id: true, name: true, academicYear: { select: { name: true } } },
    });
    if (!klass) notFound();

    // 存取判定與班級頁、成績頁完全相同。三處各寫一套的話，最可能分岐的
    // 方向是這一頁比較寬——而它列的是全班每一位學生的弱項。
    const isAdmin = ADMIN.has(user.systemRole);
    const [membership, teaching] = await Promise.all([
      prisma.classMembership.findFirst({
        where: { classId, userId: user.id, leftAt: null },
        select: { id: true },
      }),
      teachesClass(user.id, classId),
    ]);
    if (!isAdmin && !membership && !teaching) {
      return (
        <main className="yz-panel">
          <Denied
            what={`「${klass.name}」的能力分析`}
            why="你不在這個班的名冊裡，也沒有被指派教這個班。"
          />
        </main>
      );
    }
    const isHomeroom = !isAdmin && (await isHomeroomOf(user.id, classId));

    // 科任老師只看得到自己教的那一科，與班級成績頁同一條規則：
    // 導師的職權是班務，科任老師的職權是科目。
    const mine =
      isAdmin || isHomeroom
        ? null
        : (
            await prisma.classSubjectTeacher.findMany({
              where: { userId: user.id, classId },
              select: { subjectId: true },
              distinct: ['subjectId'],
            })
          ).map((r) => r.subjectId);

    const subjects = await prisma.subject.findMany({
      where: { active: true, ...(mine === null ? {} : { id: { in: mine } }) },
      orderBy: { order: 'asc' },
      select: { id: true, name: true },
    });

    if (subjects.length === 0) {
      return (
        <main className="yz-panel">
          <Empty
            title="你沒有這個班任何一科的授課指派"
            hint="能力分析是依科目分開的。請管理員把你加進這個班的授課老師名單。"
            action={<Link href={`/classes/${classId}`}>回到名冊</Link>}
          />
        </main>
      );
    }

    const current = subjects.find((s) => s.id === sp.subject) ?? subjects[0];
    const data = await classAbility(classId, current.id);

    const here = `/classes/${classId}/ability`;
    type Weak = (typeof data.weak)[number];
    type Type = (typeof data.types)[number];

    /**
     * 章節那一塊為什麼是空的——**卡在哪一關就講哪一關**。
     * 五種情況的下一步完全不同，都寫「沒有資料」等於什麼都沒說。
     *
     * **這一段只管章節那一塊。** 題型分析不需要知識點（它讀的是作答
     * 記錄與 `Question.type`），所以圖譜還沒建的時候它照樣要顯示——
     * 而業主明講要的正是「各章節**及題目類型**」兩件事。把整頁一起
     * 關掉的話，一家還沒建知識點的補習班會以為這一頁完全不能用。
     */
    const why = (() => {
      if (data.students === 0) {
        return {
          title: '這個班還沒有學生',
          hint: '先匯入名冊，學生考過之後這裡才會有東西。',
          action: <Link href={`/classes/${classId}`}>回到名冊</Link>,
        };
      }
      if (data.knowledgePoints === 0) {
        return {
          title: `「${current.name}」還沒有建立任何知識點`,
          hint:
            '章節分析的座標系就是知識點：沒有它，逐題對錯對不到任何一個單元。' +
            '建知識點是老師的工時（一科大約 4 到 8 小時），但它是這一頁、' +
            '智慧老師的前置補救、以及匯入時自動標註三件事共同的前提。' +
            '建議先做一科，看到效果再擴充。',
          action: <Link href={`/knowledge?subject=${current.id}`}>去建立知識點</Link>,
        };
      }
      if (data.questionsSeen === 0) {
        return {
          title: `這個班還沒有考過「${current.name}」`,
          hint: '派一份這一科的任務，學生交卷計分之後這裡就會有東西。',
          action: <Link href="/assignments">去派卷</Link>,
        };
      }
      if (data.questionsTagged === 0) {
        return {
          title: '考過的題目一題都沒有標知識點',
          hint:
            `這個班考過 ${data.questionsSeen} 題，但沒有一題掛在知識點上，` +
            '所以對不到任何章節。匯入題本時的自動標註會從知識點表挑候選，' +
            '而那張表如果是後來才建的，之前入庫的題目不會回頭補標——' +
            '請到題庫逐題補上，或重新匯入。',
          action: <Link href="/bank">去題庫補標註</Link>,
        };
      }
      if (data.weak.length === 0) {
        return {
          title: '還沒有算出任何快照',
          hint:
            '題目有標知識點、學生也考過了，但快照是空的。快照在計分完成時更新，' +
            '所以「先考試、後標註」或「剛升級」的情況會缺這一段。' +
            '按下面的「重建快照」從既有作答補算一次。',
          action: null,
        };
      }
      return null;
    })();

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>{klass.name}　能力分析</h1>
          <p className="yz-panel__sub">
            {klass.academicYear.name}　·　{data.students} 位在籍　·
            <Link href={`/classes/${classId}`}>名冊</Link>
            {' '}·{' '}
            <Link href={`/classes/${classId}/grades`}>整學期的成績</Link>
          </p>
        </div>

        {/* 科目切換。班級成績頁用的是下拉篩選（它同時要篩日期），
            這一頁只有一個維度，用連結列比較快——老師會來回切兩三科。 */}
        <nav className="yz-ability__tabs">
          {subjects.map((s) => (
            <Link
              key={s.id}
              href={`${here}?subject=${s.id}`}
              className={s.id === current.id ? 'yz-ability__tab yz-ability__tab--on' : 'yz-ability__tab'}
            >
              {s.name}
            </Link>
          ))}
        </nav>

        <h2 className="yz-card__title" style={{ marginTop: 6, marginBottom: 6 }}>
          哪一個章節全班都不會
        </h2>

        {why ? (
          <Empty title={why.title} hint={why.hint} action={why.action} />
        ) : (
          <>
            <Table
              caption={`${klass.name}在${current.name}各知識點的掌握度`}
              columns={[
                { key: 'n', head: '知識點', cell: (w: Weak) => w.name },
                {
                  key: 'w',
                  head: '弱的人數',
                  numeric: true,
                  cell: (w: Weak) =>
                    w.enough ? (
                      <span className={w.weakStudents > 0 ? 'yz-warn' : undefined}>
                        {w.weakStudents} / {w.reliableStudents}
                      </span>
                    ) : (
                      // 樣本不夠不是「沒問題」。給一個 0 會被讀成全班都會。
                      <span className="yz-muted" title={`只有 ${w.reliableStudents} 位有足夠的作答`}>
                        資料不足
                      </span>
                    ),
                },
                {
                  key: 'm',
                  head: '平均掌握度',
                  numeric: true,
                  cell: (w: Weak) =>
                    w.enough && w.meanMastery !== null ? (
                      <Bar value={w.meanMastery} low={w.meanMastery < WEAK} />
                    ) : (
                      <span className="yz-muted">—</span>
                    ),
                },
                {
                  key: 'r',
                  head: '全班答對',
                  numeric: true,
                  // 掌握度是算出來的，這一欄是數出來的。老師問「這個 0.35
                  // 怎麼來的」時，這是他當場驗證得了的東西。
                  cell: (w: Weak) => (
                    <span title="全班在這個知識點上答對的題數 / 作答題數">
                      {w.correct} / {w.total}
                    </span>
                  ),
                },
              ]}
              rows={data.weak}
              rowKey={(w) => w.id}
              empty={<Empty title="還沒有算出任何知識點" hint="按下面的「重建快照」試一次。" />}
            />
            <p className="yz-hint" style={{ marginTop: 10 }}>
              掌握度<strong>不是答對率</strong>：它把每一題依作答時間加權（愈久以前的愈輕，
              各知識點的衰減速度不同），並依題目難度調整，所以它回答的是「
              <strong>現在</strong>會不會」而不是「這學期平均考幾分」。
              低於 {pct(WEAK)} 算弱、{pct(SOLID)} 以上算穩；一位學生要有
              至少 5 題、而且不是太久以前的作答才算得出可靠的掌握度，
              一個知識點要有 {MIN_CLASS_SAMPLE} 位以上這樣的學生才下得了「全班都不會」的結論。
            </p>
          </>
        )}

        {/* 題型分析**不需要知識點**：它讀的是作答記錄與 `Question.type`。
            所以圖譜還沒建的補習班在這一頁上仍然拿得到一半的東西，
            而業主要的正是「各章節及題目類型」兩件事。 */}
        <h2 className="yz-card__title" style={{ marginTop: 30, marginBottom: 6 }}>
          依題型
        </h2>
        <Table
          caption={`${klass.name}在${current.name}各題型的表現`}
          columns={[
            {
              key: 't',
              head: '題型',
              cell: (t: Type) => TYPE_LABELS[t.type] ?? t.type,
            },
            {
              key: 'r',
              head: '答對率',
              numeric: true,
              cell: (t: Type) =>
                t.rate === null ? (
                  <span className="yz-muted">還沒改完</span>
                ) : (
                  <Bar value={t.rate} low={t.rate < WEAK} />
                ),
            },
            {
              key: 'c',
              head: '答對 / 作答',
              numeric: true,
              cell: (t: Type) => `${t.correct} / ${t.answered}`,
            },
            {
              key: 'p',
              head: '待評分',
              numeric: true,
              cell: (t: Type) => (t.pending ? <span className="yz-warn">{t.pending}</span> : ''),
            },
          ]}
          rows={data.types}
          rowKey={(t) => t.type}
          empty={
            <Empty
              title="這個班還沒有這一科的作答"
              hint="派一份這一科的任務，學生交卷之後這裡就會有東西。"
            />
          }
        />
        {data.types.length > 0 && (
          <p className="yz-hint" style={{ marginTop: 10 }}>
            取最近 {data.assignments} 份這一科的任務。
            <strong>分母只算有作答的題目</strong>——空白題在作答記錄裡沒有列，
            從這裡看不到，所以「多選題答對率 71%」不等於「全班多選很好」，
            有可能是一半的人直接跳過。單份的完整統計（含未作答）在那一份的成績頁上。
          </p>
        )}

        <Rebuild classId={classId} className={klass.name} students={data.students} />

        {data.knowledgePoints > 0 && data.questionsSeen > 0 && (
          <p className="yz-hint">
            這一科有 {data.knowledgePoints} 個知識點；這個班考過的 {data.questionsSeen} 題裡，
            有 {data.questionsTagged} 題掛在知識點上。
            {data.questionsTagged < data.questionsSeen && (
              <>
                {' '}沒掛上的那 {data.questionsSeen - data.questionsTagged} 題不會出現在上面的章節分析裡
                （它們仍然算進成績與題型）。要補標註請到
                <Link href="/bank">題庫</Link>，或到
                <Link href={`/knowledge?subject=${current.id}`}>知識點</Link>看整張圖譜的狀況。
              </>
            )}
          </p>
        )}
      </main>
    );
  });
}
