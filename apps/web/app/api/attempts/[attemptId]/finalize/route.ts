/**
 * 老師代替學生把一份卡住的作答收掉。
 *
 * # 什麼時候會用到
 *
 * 學生寫到一半筆電沒電、瀏覽器被關掉、網路斷了而且沒有再回來。
 * 時間到之後那一份還掛在「進行中」：伺服器不收他的答案了，但也
 * 沒有人按下交卷，所以它永遠不會被計分。學生的清單上次數已經用完
 * （沒有按鈕），老師的成績頁只查已交卷的（看不到這個人）。
 * **那個學生寫過的東西就停在那裡，沒有任何一條路徑走得到。**
 *
 * 這一支就是那條路徑。
 *
 * # 為什麼與「重新計分」分成兩支
 *
 * 因為它們動的東西不同，而且危險程度差很多。重新計分只寫
 * `earnedScore` 那三欄，重跑幾次結果都一樣；這一支會把作答狀態
 * 從 IN_PROGRESS 改成 SUBMITTED，**而那是不可逆的**——收掉之後
 * 學生就再也寫不進去了（雖然實際上他早就寫不進去了）。
 *
 * 收得掉的條件在 `lib/attemptClock.mjs` 的 `checkFinalizeOnBehalf`，
 * 它只准收「已經寫不進去」的那些。還在計時的作答不准動，否則這一支
 * 就變成「老師可以隨時把學生正在寫的考卷抽走」。
 */
import { NextRequest, NextResponse } from 'next/server';

import { finalizeAttemptOnBehalf } from '@/lib/attempt';
import { scopedRoute } from '@/lib/route';
import { attemptTarget, mayGrade } from '@/lib/scoring';

export const dynamic = 'force-dynamic';

export const POST = scopedRoute<{ attemptId: string }>(
  async (_req: NextRequest, { user, params }) => {
    const target = await attemptTarget(params.attemptId);
    // 查不到有兩種可能：不存在，或不是這個租戶的（RLS 直接讓它消失）。
    // 兩種都回 404——回 403 等於告訴對方「這個 id 存在」。
    if (!target) return NextResponse.json({ error: '找不到這一份作答' }, { status: 404 });

    // 與重新計分同一條權限規則。代為結算的後果是「這位學生立刻有了
    // 一個分數」，那與改分數是同一個層級的事，不該比它寬。
    if (!(await mayGrade(user, target.subjectId))) {
      return NextResponse.json(
        { error: '只有這一科的授課老師與管理員可以代為結算' },
        { status: 403 },
      );
    }

    try {
      const result = await finalizeAttemptOnBehalf(params.attemptId, user.id);
      return NextResponse.json({ ok: true, result });
    } catch (e) {
      // 「還在作答時間內」「已經交卷了」都是說得出原因的狀況，
      // 訊息本身就是要顯示給老師看的東西。
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 409 },
      );
    }
  },
);
