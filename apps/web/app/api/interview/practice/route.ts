/**
 * 面試練習：回答一題，拿到**結構面**的回饋與一致性檢查。
 *
 * # 回饋不評內容，而且這一條是靠「不呼叫模型」守住的
 *
 * 「這個答案好不好」是招生委員的判斷。系統給了會發生兩件事：它會是
 * 錯的（各校系的評分重點差異極大，系統手上沒有任何一份評分表可以對），
 * 而且**學生會照著改**——改成他以為的「正確答案」，然後在面試現場
 * 講一段不是自己的話。面試最常見的失分本來就是講稿感。
 *
 * 所以結構回饋是**確定性的**（`lib/interview.mjs`，純函式有測試），
 * 而不是「叫模型只評結構」。模型被要求只評結構時，第三輪就會寫出
 * 「你的例子很具體，展現了良好的團隊合作能力」，而後半句是內容評價，
 * 混在結構觀察裡送出去。
 *
 * # 練習紀錄只有學生自己看得到
 *
 * 回答裡會有他還沒想清楚的話、講砸的版本、以及對自己志向的猶豫。
 * 那與學習歷程的內容是同一類的東西，所以走同一條線：這個檔案與
 * `lib/portfolioDb.ts` 裡沒有任何一支函式讓老師查別人的練習。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { myPractices, portfolioFailure, practiceInterview } from '@/lib/portfolioDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const Body = z.object({
  questionId: z.string().min(1),
  answerText: z.string().min(1).max(8000),
});

export const GET = scopedRoute(async (_req: NextRequest, { user }) => {
  try {
    return NextResponse.json({ practices: await myPractices(user) });
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: '參數不正確' }, { status: 400 });
  try {
    const result = await practiceInterview(user, parsed.data.questionId, parsed.data.answerText);
    return NextResponse.json({ ...result, practices: await myPractices(user) });
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});
