import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { attemptFailure, saveAnswer, type AnswerPayload } from '@/lib/attempt';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/**
 * 儲存答案。
 *
 * 一次收一批，因為前端是防抖存檔：學生在三十秒內改了五題，那是
 * 一個請求而不是五個。熱點網路下每一次往返都要錢（時間與電量）。
 *
 * `answerKeys` 送的是**題庫裡的選項編號**，不是畫面上的第幾個。
 * 隨機選項時兩者不同，而換算在伺服器端做——版面快照在伺服器上，
 * 讓前端做換算等於相信前端的換算。
 */
const Answer = z.object({
  questionId: z.string().min(1),
  answerKeys: z.array(z.number().int().min(1).max(50)).max(50).optional(),
  answerText: z.string().max(20000).nullable().optional(),
  answerSlots: z
    .array(z.object({ slot: z.string().max(40), value: z.string().max(200) }))
    .max(50)
    .nullable()
    .optional(),
  flagged: z.boolean().optional(),
});

const Body = z.object({
  // 上限 200：一份卷子不會超過這個題數，而沒有上限的批次是一個
  // 可以用一個請求打爆資料庫的入口。
  answers: z.array(Answer).min(1).max(200),
});

export const PATCH = scopedRoute<{ attemptId: string }>(
  async (req: NextRequest, { user, params }) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: '請求格式錯誤',
          detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        { status: 400 },
      );
    }

    // 逐題存。一題的內容有問題（例如選項編號不對）時，**前面已經存好的
    // 不退回**——這是學生的作答，能存下來的就要存下來。回傳裡會說出
    // 哪幾題沒存成功，前端把那幾題留在待存佇列裡。
    const saved: string[] = [];
    const failed: { questionId: string; error: string }[] = [];
    let remaining: number | null = null;

    for (const a of parsed.data.answers) {
      const payload: AnswerPayload = {
        answerKeys: a.answerKeys,
        answerText: a.answerText,
        answerSlots: a.answerSlots,
        flagged: a.flagged,
      };
      try {
        const res = await saveAnswer(params.attemptId, a.questionId, payload, user.id);
        remaining = res.remainingSeconds;
        saved.push(a.questionId);
      } catch (e) {
        const { status, body } = attemptFailure(e);
        // 時間到、已交卷、不是你的卷子——這三種對整批都成立，
        // 再試下一題只是多幾次一樣的失敗。整批停下來並把狀態告訴前端，
        // 讓它停止自動存檔而不是每五秒重試一次。
        if (status === 403 || status === 404 || status === 409) {
          return NextResponse.json({ ...body, saved }, { status });
        }
        failed.push({ questionId: a.questionId, error: body.error });
      }
    }

    return NextResponse.json({
      ok: failed.length === 0,
      saved: saved.length,
      failed,
      remainingSeconds: remaining,
    });
  },
);

/**
 * 與 PATCH 同一件事，只是給 `navigator.sendBeacon` 用。
 *
 * **sendBeacon 一定是 POST，沒有選項可以改。** 作答頁在
 * `visibilitychange`／`pagehide` 時用它把還沒送出的答案送掉，而那正是
 * 最需要送出去的一次——學生按了首頁鍵、切了 App、關了分頁。
 * 這個路由若只有 PATCH，那一次就是 405，最後幾題靜靜地不見。
 *
 * （同樣的洞在匯入校對那邊出現過一次，見
 * `app/api/import/[jobId]/candidates/route.ts` 的說明。）
 *
 * 行為必須與 PATCH 完全一致而且可以重複送：瀏覽器不保證 beacon 到得了，
 * 前端在恢復前景時還會再送一次。`saveAnswer` 是 upsert，本來就滿足。
 */
export const POST = PATCH;
