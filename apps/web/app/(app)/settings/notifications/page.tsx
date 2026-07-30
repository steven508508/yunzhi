/**
 * 通知設定。每一個角色都有，路徑與「更換密碼」並列——那一區放的是
 * 「每一種身分都有、而且只關於自己」的東西。
 *
 * # 為什麼有些通知關不掉
 *
 * 規則說得出來，不是一份任意的清單：**凡是「別人動了你的成績」的
 * 事件都不可關閉；「提醒你自己去做某件事」的都可以。**
 *
 *   關不掉  作答被作廢、作廢被撤銷、老師代為結算
 *   關得掉  作業快到期、逾期未交、成績開放、匯入完成、有卷子等你閱卷
 *
 * 前者關掉之後，學生會在成績單上看到一個他無法解釋的數字或空缺，
 * 而系統裡沒有任何一條路徑讓他知道發生了什麼——他甚至不知道
 * 「有事發生過」。後者關掉的後果只是少一個提醒，而該做的事仍然在
 * 任務清單與首頁待辦上，看得見也做得到。
 *
 * 完整的理由與清單在 `lib/notifyTemplates.mjs` 的 `MANDATORY`，
 * 而**強制的判斷在伺服器端**（`buildChannels`）：畫面上停用一個核取
 * 方塊不是保護，直接打 API 一樣送得進來。
 *
 * # 為什麼只有站內通知一欄
 *
 * 因為只有它是真的。`NotifyChannel` 的 enum 有四個，而電子郵件、
 * LINE、簡訊在這套部署裡都送不出去——機房是封閉網段，對外的 SMTP 是
 * `ERR_TUNNEL_CONNECTION_FAILED`（同一個現實讓這個專案刻意不做
 * 寄信重設密碼、也不做寄信驗證家長）。
 *
 * 所以這一頁**把它們寫出來並且標成未接**，而不是假裝沒有這些選項：
 * 老師會問「為什麼家長沒收到成績通知」，而那個答案必須在他找得到的
 * 地方。系統內部的處置是「建立、立刻標成 SUPPRESSED、把原因寫進
 * failReason」——絕不留在佇列裡假裝在排隊（見 `lib/notify.mjs` 的
 * `enqueueMany`）。
 */
import Link from 'next/link';

import { loadPreference } from '@/lib/notifyDb';
import { MANDATORY, TEMPLATES, TEMPLATE_KEYS } from '@/lib/notifyTemplates.mjs';
import { READY_CHANNELS, UNREADY_REASON } from '@/lib/notify.mjs';
import { scopedPage } from '@/lib/page';

import Preferences from './Preferences';

export const dynamic = 'force-dynamic';

/**
 * 這個角色看得到哪幾則的開關。
 *
 * 只列他真的收得到的：學生看到「有卷子等你閱卷」的開關會以為系統
 * 把他當成老師，而一個關掉之後什麼都不會改變的開關比沒有更糟。
 *
 * 判斷用樣板自己宣告的 `audience`，不是在這裡再列一份對照表——
 * 兩份清單遲早會分歧，而分歧的症狀是某一則通知沒有人關得掉。
 */
function audienceOf(systemRole: string): string {
  if (systemRole === 'STUDENT') return 'STUDENT';
  if (systemRole === 'GUARDIAN') return 'GUARDIAN';
  return 'STAFF';
}

export default async function NotificationSettingsPage() {
  return scopedPage(async (user) => {
    const pref = await loadPreference(user.id);
    const mine = audienceOf(user.systemRole);
    const keys = TEMPLATE_KEYS.filter((k) => TEMPLATES[k].audience === mine);

    const items = keys.map((k) => ({
      key: k,
      label: TEMPLATES[k].label,
      why: TEMPLATES[k].why,
      mandatory: MANDATORY.includes(k),
      // 沒有記錄就是收得到。預設值必須往「收得到」倒：一張空的偏好
      // 表（每個新帳號都是）若被讀成「全部關閉」，症狀是通知功能整個
      // 不存在，而畫面上完全正常。
      wanted: pref.wanted[k] !== false,
    }));

    return (
      <main className="yz-panel">
        <div className="yz-panel__head">
          <h1>通知設定</h1>
          <p className="yz-panel__sub">
            {user.displayName}　·　<Link href="/inbox">看通知</Link>　·
            <Link href="/">回到首頁</Link>
          </p>
        </div>

        <Preferences
          items={items}
          quietHours={pref.quietHours}
          channels={CHANNELS.map((c) => ({
            ...c,
            ready: READY_CHANNELS.includes(c.id),
            why: UNREADY_REASON[c.id] ?? '',
          }))}
        />
      </main>
    );
  });
}

/**
 * 四個渠道，照 `NotifyChannel` 的順序。
 *
 * **未接的也列出來。** 藏起來的話，「為什麼家長沒收到」這個問題在
 * 系統裡沒有任何答案，而老師會假設有寄出去。
 */
const CHANNELS: { id: string; label: string }[] = [
  { id: 'IN_APP', label: '站內通知' },
  { id: 'EMAIL', label: '電子郵件' },
  { id: 'LINE', label: 'LINE' },
  { id: 'SMS', label: '簡訊' },
];
