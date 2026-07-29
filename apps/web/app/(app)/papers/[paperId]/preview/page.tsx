/**
 * 整卷預覽與紙本考卷。
 *
 * # 為什麼這一頁是這條動線上最該先做的一件事
 *
 * 在這之前，**這份卷子第一個從頭到尾看過它的人是考試當天的學生**：
 * 挑題與卷面兩欄的題幹都被夾成兩行、選項與答案一個字都查不出來，
 * 而老師也不能拿自己的帳號試考（非學生帳號不能當派發對象）。
 * 「第 12 題印錯了」這種事之所以會發生，正是因為中間沒有一次檢查。
 *
 * 同一頁也是紙本唯一的出路。globals.css 早就寫著「要紙本考卷請用組卷
 * 那邊的輸出」，而那個輸出在此之前不存在——補習班一定有沒帶平板的
 * 學生，也一定有要留檔的紙本卷。
 *
 * # 為什麼查詢在這裡、版面在 Sheet.tsx
 *
 * 因為版面要能離線渲染來驗分頁（見 Sheet.tsx 的檔頭）。這一頁負責的是
 * **哪些欄位查得出來、哪些欄位不可以出現在學生版上**。
 *
 * # 答案的邊界
 *
 * `?ans=1` 才是教師版。學生版不是「查出來但不畫」——`answer` 對映在
 * 這裡就是 `null`，Sheet 連可以印的東西都沒有。理由是這份 HTML 會被
 * 印出來、也會被截圖轉傳，而 `display: none` 的答案仍然在原始碼裡。
 */
import { notFound } from 'next/navigation';

import { Denied, Empty, Note } from '@/components/Feedback';
import { canEditSubject } from '@/lib/auth';
import { slotList } from '@/lib/grading.mjs';
import { mayComposeArea } from '@/lib/paper';
import { scopedPage } from '@/lib/page';
import { prisma } from '@/lib/prisma';
import PrintBar from './PrintBar';
import { Sheet, type SheetRow } from './Sheet';

export const dynamic = 'force-dynamic';

const TYPE: Record<string, string> = {
  SINGLE_CHOICE: '單選',
  MULTI_CHOICE: '多選',
  FILL_SLOT: '選填',
  FILL_TEXT: '填空',
  SHORT_ANSWER: '簡答',
  ESSAY: '作文',
  TRANSLATION: '翻譯',
  TRUE_FALSE: '是非',
};

export default async function PreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ paperId: string }>;
  searchParams: Promise<{ ans?: string }>;
}) {
  const { paperId } = await params;
  const sp = await searchParams;

  return scopedPage(async (user) => {
    if (!mayComposeArea(user.systemRole, '/papers')) {
      return (
        <main className="yz-panel">
          <Denied what="試卷" why="卷子上的題目是還沒考的，只有老師與管理員看得到。" />
        </main>
      );
    }

    const paper = await prisma.examPaper.findFirst({
      where: { id: paperId },
      include: { subject: { select: { id: true, name: true } } },
    });
    if (!paper) notFound();

    // 教師版要授課權。這一頁是全系統唯一一個把整份標準答案排在一張紙上
    // 的地方，而「所有職員都看得到題庫」與「所有職員都拿得到一份印好的
    // 答案卷」不是同一件事。
    const mayEdit = await canEditSubject(user, paper.subjectId);
    const withAnswers = sp.ans === '1' && mayEdit;
    const askedForAnswers = sp.ans === '1';

    const items = await prisma.examPaperItem.findMany({
      where: { paperId },
      orderBy: { order: 'asc' },
      select: {
        id: true,
        score: true,
        question: {
          select: {
            id: true,
            type: true,
            content: true,
            contentAssets: true,
            subLabel: true,
            answerKeys: true,
            answerSlots: true,
            answerText: true,
            group: {
              select: { id: true, label: true, stimulus: true, stimulusAssets: true },
            },
            options: {
              orderBy: { order: 'asc' },
              select: { order: true, label: true, content: true, assets: true },
            },
          },
        },
      },
    });

    const rows: SheetRow[] = [];
    let seenGroup: string | null = null;

    items.forEach((it, i) => {
      const q = it.question;
      const no = i + 1;

      // 題組素材排在該組**第一題之前**。同一組的第二題以後不再重印——
      // 一段閱讀素材印三次，一份卷子會多出兩頁。
      if (q.group && q.group.id !== seenGroup) {
        rows.push({
          kind: 'group',
          id: q.group.id,
          label: q.group.label,
          stimulus: q.group.stimulus,
          assets: q.group.stimulusAssets,
        });
      }
      seenGroup = q.group?.id ?? null;

      const slots = q.type === 'FILL_SLOT' ? slotList(q.answerSlots) : [];

      rows.push({
        kind: 'q',
        q: {
          no,
          score: it.score,
          typeLabel: TYPE[q.type] ?? q.type,
          type: q.type,
          subLabel: q.subLabel,
          content: q.content,
          assets: q.contentAssets,
          options: q.options,
          // 選填題的格數本身**不是答案**——答案卡上印幾格是題目的一部分，
          // 學生要知道答案有幾位。格子裡填什麼才是答案。
          slotCount: slots.length,
          answer: withAnswers ? answerOf(q, slots) : null,
        },
      });
    });

    return (
      <main className="yz-panel yz-paper__page">
        <PrintBar paperId={paper.id} withAnswers={withAnswers} />

        {askedForAnswers && !mayEdit && (
          <Note tone="warn">
            你不是{paper.subject.name}的授課老師，看得到卷子但看不到答案。
            這一份是學生版。
          </Note>
        )}
        {paper.status === 'DRAFT' && (
          <Note>
            這份卷子還是草稿，派不出去。印出來的紙本可以先用，
            但線上要考的話記得回到挑題頁標記為可派發。
          </Note>
        )}

        {items.length === 0 ? (
          <Empty
            title="這份卷子還沒有題目"
            hint="回到挑題頁從題庫挑幾題，這一頁就會把整份卷子攤開來。"
          />
        ) : (
          <Sheet
            title={paper.title}
            subjectName={paper.subject.name}
            instructions={paper.instructions}
            totalScore={paper.totalScore}
            count={items.length}
            withAnswers={withAnswers}
            imageBase={`/api/papers/${paper.id}/image?key=`}
            rows={rows}
          />
        )}
      </main>
    );
  });
}

/**
 * 一題的標準答案，排成一行看得懂的字。
 *
 * 選擇題回傳的是**選項標籤**而不是 `answerKeys` 裡的數字：那一欄存的是
 * 選項的 `order`，而卷面上印的是 `label`（「(1)」「(A)」「甲」都有）。
 * 印數字的話，改卷的人要自己在腦裡換一次，而換錯不會有任何提示。
 */
function answerOf(
  q: {
    type: string;
    answerKeys: number[];
    answerText: string | null;
    options: { order: number; label: string }[];
  },
  slots: string[],
): string | null {
  if (q.type === 'FILL_SLOT') {
    const filled = slots.filter((s) => s !== '');
    return filled.length ? filled.join('　') : null;
  }
  if (q.answerKeys.length > 0) {
    return q.answerKeys
      .map((k) => q.options.find((o) => o.order === k)?.label ?? `(${k})`)
      .join('　');
  }
  const text = q.answerText?.trim();
  if (text) return text;
  // 非選題本來就沒有標準答案（作文、翻譯）。說出來，改卷的人才不會
  // 以為是資料掉了然後回去找。
  return '（無標準答案，人工評閱）';
}
