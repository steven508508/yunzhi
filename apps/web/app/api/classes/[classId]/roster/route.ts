/**
 * 名冊匯入。
 *
 * **兩段式：先 plan 再 apply。**
 *
 * 櫃檯人員在按下確認之前要看得到「會新增 28 位、其中 4 位已經有帳號、
 * 第 7 列有問題」。一次做完的話，錯誤只能在事後補救，而名冊匯入的
 * 事後補救很痛苦——那件事發生在開學前一天，而且錯了的代價是有學生
 * 登不進去。
 *
 * # 家長帳號跟著一起建，但是第二步
 *
 * 名冊上有家長信箱的那幾位，匯入完會一併開好家長帳號與連結
 * （`provisionGuardiansForClass`）。**刻意在 `applyRoster` 的交易之外**
 * ——每一個家長帳號也要算一次 bcrypt，而學生那一批的密碼已經是
 * 「在交易外面先算好」才擠得進 5 秒的交易上限（見 `mintPasswords`）。
 * 把家長那一批塞進同一個交易，等於把它的時間乘上兩倍的人數。
 *
 * 分成兩步安全，因為第二步是冪等的：失敗了在名冊頁按一次
 * 「建立家長帳號」就補回來，不必重匯名冊。而它失敗**不會讓名冊
 * 匯入跟著失敗**——學生已經進去了，那是這一支真正要做的事。
 */
import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { scopedRoute } from '@/lib/route';
import { applyRoster, planRoster } from '@/lib/roster';
import { provisionGuardiansForClass, type GuardianProvision } from '@/lib/guardian';
import { isHomeroomOf } from '@/lib/auth';

export const dynamic = 'force-dynamic';
/**
 * **這個數字是被 bcrypt 決定的，不是被檔案大小決定的。**
 *
 * 名冊本身是幾十 KB 的文字檔，讀完不用一秒。真正花時間的是每一位
 * 新生的初始密碼——bcrypt 12 輪在這個級別的機器上實測約 310 毫秒，
 * 而它是 CPU 密集的純運算，200 人就是 62 秒。
 *
 * 原本設 60 秒，剛好卡在一份全校名冊的正上方：**分班匯入（約 30 人、
 * 10 秒）永遠不會出事，一次匯入 200 人則會在 62 秒時被砍斷**——
 * 而那是開學前一天才會做一次的動作。給 5 倍餘裕。
 *
 * Caddy 那一側的 `write 300s` 對得上（deploy/caddy/Caddyfile）。
 * 兩邊有一邊比較短的話，症狀是瀏覽器收到 502 而伺服器其實做完了。
 */
export const maxDuration = 300;

const MAX_BYTES = 2 * 1024 * 1024;

async function mayEdit(classId: string, user: { id: string; systemRole: string }) {
  if (user.systemRole === 'SYS_ADMIN' || user.systemRole === 'SCHOOL_ADMIN') return true;
  return isHomeroomOf(user.id, classId);
}

export const POST = scopedRoute<{ classId: string }>(
  async (req: NextRequest, { user, params }) => {
    const klass = await prisma.class.findFirst({
      where: { id: params.classId },
      select: { id: true, name: true },
    });
    if (!klass) return NextResponse.json({ error: '找不到這個班級' }, { status: 404 });
    if (!(await mayEdit(params.classId, user))) {
      return NextResponse.json(
        { error: `你不是「${klass.name}」的導師，無法調整名冊` },
        { status: 403 },
      );
    }

    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '請選擇一個 CSV 檔' }, { status: 400 });
    }
    if (file.size === 0) return NextResponse.json({ error: '這個檔案是空的' }, { status: 400 });
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `名冊超過 ${MAX_BYTES / 1024 / 1024} MB。這通常代表選錯檔了。` },
        { status: 413 },
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const plan = await planRoster(bytes);
      // 預設是試算。要真的寫入必須明確帶 apply=1——
      // 少了這一層，一個誤觸就會建出三十個帳號。
      if (form?.get('apply') !== '1') {
        return NextResponse.json({ ok: true, dryRun: true, plan });
      }
      // 姓名不同時要不要跟著改，由畫面上一個明確的勾選決定。
      // **預設不改**：同名同姓不同人而學號打錯的那一次，靜靜地跟著改
      // 會把另一個人的名字覆蓋掉，而畫面上沒有任何痕跡。
      const result = await applyRoster(params.classId, plan, user.id, {
        updateNames: form?.get('updateNames') === '1',
      });

      // 家長那一步失敗**不可以把已經成功的名冊匯入變成一個錯誤**：
      // 學生已經寫進去了，而畫面上一句紅字會讓櫃檯再匯一次
      // （不會產生重複帳號，但初始密碼那一張紙就作廢了）。
      // 所以失敗的訊息跟著結果一起回去，畫面上說「家長帳號沒建成，
      // 到下面按一次」——那顆按鈕本來就在，而且冪等。
      let guardians: GuardianProvision | null = null;
      let guardianError: string | null = null;
      try {
        guardians = await provisionGuardiansForClass(params.classId, user.id);
      } catch (e) {
        guardianError = e instanceof Error ? e.message : String(e);
      }
      return NextResponse.json({
        ok: true,
        dryRun: false,
        plan,
        result,
        guardians,
        guardianError,
      });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  },
);
