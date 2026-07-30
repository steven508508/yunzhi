/**
 * 級分預測的校準報告（規格書 §6.2）。
 *
 * # 這一支存在的理由
 *
 * 「一個不追蹤自己準確度的預測系統只是在製造好看的數字。」
 *
 * 它回答的是一個很具體的問題：**所有被預測為「信心 70%」的區間裡，
 * 實際落在區間內的比例是不是接近 70%？** 低於太多代表模型過度自信
 * （區間開太窄），而那時畫面上每一個區間都在騙人，卻沒有任何症狀。
 *
 * # 為什麼學生看不到
 *
 * 學生看到「你們的 70% 區間其實只準 45%」的正確反應是不再相信任何一個
 * 區間，而做那個判斷需要的脈絡（樣本數、哪一屆、哪一科、偏離是不是
 * 統計噪音）他沒有。老師與管理員要看得到，因為他們是決定「這個功能
 * 還要不要開著」的人。
 *
 * 學科召集人也在名單裡：偏離往往集中在某一科（例如那一科全班只有校內
 * 模考，級距本身就不可靠），而那是他們處理的事。
 *
 * # 為什麼預設是「全部年度一起看」
 *
 * 因為第一屆的樣本量還不足以下結論。預設成當年度的話，三月之前這一頁
 * 永遠是空的（實際成績還沒公布），而看的人會以為功能壞了。
 */
import { NextRequest, NextResponse } from 'next/server';

import { calibrationReport, canSeeCalibration } from '@/lib/predictDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  if (!canSeeCalibration(user)) {
    return NextResponse.json(
      {
        error:
          '校準報告是機構自己的品質報告，學生看不到——' +
          '「70% 的區間其實只準 45%」這句話需要的脈絡（樣本數、哪一屆、' +
          '偏離是不是統計噪音）不在學生手上，而他的合理反應會是不再相信任何一個區間。',
      },
      { status: 403 },
    );
  }
  const raw = new URL(req.url).searchParams.get('year');
  const year = raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
  return NextResponse.json(await calibrationReport(year));
});
