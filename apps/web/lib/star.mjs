/**
 * 繁星推薦的校內賽局模擬（N3）。
 *
 * # 為什麼這是整個升學模組最有價值的一塊
 *
 * 繁星有兩層競爭，而坊間工具只處理得了第二層。
 *
 * **第一層是校內競爭。** 每所高中對同一所大學的同一學群至多推薦 2 名，
 * 每位學生限被推薦至一所大學的一個學群，而第一輪只有推薦序 1 參加。
 * 這代表同校同學之間是**直接的排擠關係**——你想推的那個位置，可能
 * 已經有三位百分比比你好的同學想推。
 *
 * **第二層是全國競爭**，也就是該校系第一輪的錄取標準。
 *
 * 學生真正卡住的往往是第一層，而**校內競爭的資料只有學校自己有**。
 * 一套裝在學校或補習班內部的系統做得到這件事，外部工具做不到。
 *
 * # 這個檔案不做第二層
 *
 * 全國比序需要各校系歷年的第一輪錄取標準，那份資料禁止爬取（規格書
 * §1）。而且就算拿得到，官方公布的只有**最後一名錄取者**的百分比，
 * 繁星校系第一輪名額常常只有 1 至 3 名——每年只有一個極值資料點。
 * 用三年的極值講「有相當把握」，那句話的誤差比它本身還大。
 *
 * 所以這裡輸出的是**位置**（你在校內排第幾）而不是**機率**。
 * 位置是數出來的，機率是編出來的。
 *
 * # 最容易寫錯的一件事：結果端 vs 參賽端
 *
 * 規則說的是「每所高中在每一所大學，第 1 至 3 類**合計錄取** 1 名」。
 * 這是**結果端**的約束，不是參賽端的。同一所高中完全可以在臺大第 1 類
 * 與第 2 類各推薦一位推薦序 1 的學生，**兩人都進第一輪**、都與全國其他
 * 高中的推薦序 1 競爭，只是最終該校在臺大最多只有 1 人上榜。
 *
 * 若把它實作成參賽篩選、在模擬階段就剔除其中一位，系統會對那位學生
 * 給出錯誤的輔導建議（「你不會進第一輪」），而他實際上完全可能就是
 * 錄取的那一個。這個錯誤沒有任何症狀——畫面上一切正常。
 *
 * # 隱私：這個功能能不能上線的關鍵在這一條線劃在哪裡
 *
 * 在校成績百分比是全校最敏感的資料。所以：
 *
 *   · `studentView()` 的輸出裡**沒有任何其他學生的 id、姓名、百分比，
 *     也沒有參與人數**。連自己的百分比都不回——那一項由學生自己那列
 *     `AcademicRank` 另外給，不從賽局結果流出來。
 *   · **推論攻擊的防護**：某個「大學 × 學群」的參與人數少於
 *     `MIN_COHORT` 時，只說「你是不是校內第 1 位」而不給具體名次。
 *     否則排第 2 的人就能推知排第 1 的是誰。
 *   · 結果端的跨學群排擠對學生**只講規則不講事實**——「第 1 至 3 類
 *     合計錄取 1 名」是公開的制度，「校內還有誰是推薦序 1」不是。
 *     承辦人那一側才看得到事實。
 *
 * # 敏感度而非單點
 *
 * 「你排第 4」是一個精確但脆弱的數字：一位同學改志願它就變了。
 * 所以每一個位置都附上「若有一位排在你前面的同學改變志願會怎樣」與
 * 「若有一位百分比更好的同學改推這裡會怎樣」。兩個方向都要說——
 * 只說對自己有利的那一邊，那叫推銷不叫輔導。
 */
// 相對路徑而不是 `@/lib/...`：這個檔案要能被 `node --test` 直接載入。
// 同一個理由見 lib/admissionSources.mjs 檔尾的說明。
import { starVacancySentence } from './admission.mjs';

// ═════════════════════════════════════════════════════════════════
// §1 制度常數
// ═════════════════════════════════════════════════════════════════

/** 每校對同一大學同一學群至多推薦 2 名。 */
export const PER_POSITION_QUOTA = 2;

/** 只有推薦序 1 參加第一輪。 */
export const FIRST_ROUND_ORDER = 1;

/**
 * 第二輪由推薦序 2 至 6 及第一輪未錄取者參加。
 *
 * 校內在 `PER_POSITION_QUOTA = 2` 之下只可能產生推薦序 1 與 2，所以
 * 這個上限實際上用不到——留著是因為它是制度的一部分，而各校的推薦
 * 辦法若把推薦序改成「每所大學跨學群統一排序」，它立刻就有意義了。
 */
export const SECOND_ROUND_MAX_ORDER = 6;

/**
 * 結果端的跨學群排擠：同一高中在同一大學，每一組學群合計只錄取 1 名。
 *
 * **這是結果端。參賽不受影響。** 見檔頭。
 */
export const CROSS_GROUP_SETS = [
  { label: '第 1 至 3 類', groups: [1, 2, 3], admitLimit: 1 },
  { label: '第 4 至 7 類', groups: [4, 5, 6, 7], admitLimit: 1 },
  { label: '第 8 類', groups: [8], admitLimit: 1 },
];

/**
 * 少於這個人數就不給具體名次。
 *
 * 3 不是隨便取的：2 人時排第 2 的人可以直接推知排第 1 的是誰
 * （那個位置只有他們兩個）。3 人時排第 3 的人只知道「有兩個人比我好」，
 * 推不出是哪兩個裡的哪一個排第幾。
 */
export const MIN_COHORT = 3;

/** 位置鍵。用控制字元當分隔，避免大學名稱裡的符號撞在一起。 */
export function positionKey(institutionName, starGroup) {
  return `${institutionName}${starGroup}`;
}

/** 這個學群屬於哪一組結果端排擠。 */
export function crossGroupSetOf(starGroup) {
  return CROSS_GROUP_SETS.find((s) => s.groups.includes(Number(starGroup))) ?? null;
}

// ═════════════════════════════════════════════════════════════════
// §2 四步模擬
// ═════════════════════════════════════════════════════════════════

/**
 * 全校模擬。**輸出含每位學生的 id，只給承辦人**；學生端要走
 * `studentView()` 取自己那一片。
 *
 * @param {{
 *   participants: {userId: string, percentile: number|null,
 *     institutionName: string, starGroup: number, wishRank?: number}[],
 *   quota?: number,
 *   now?: Date,
 * }} input
 */
export function simulate({ participants = [], quota = PER_POSITION_QUOTA, now = new Date() } = {}) {
  // ── 第 0 步：每生限一校一學群 ───────────────────────────────
  //
  // 學生可以在志願清單裡填好幾個繁星志願（系統不阻擋，見
  // lib/admission.mjs §5），但實際成立的只有志願序最前面的那一個。
  // 多填的那幾個不是備選，是不存在——所以要在這裡就拆開，
  // 否則同一個人會出現在兩個位置的排序裡，兩邊都算他佔一個名額。
  const best = new Map();
  const dropped = [];
  for (const p of participants) {
    const rank = Number.isFinite(p.wishRank) ? p.wishRank : Number.MAX_SAFE_INTEGER;
    const cur = best.get(p.userId);
    if (!cur || rank < cur.wishRank) {
      if (cur) dropped.push(cur);
      best.set(p.userId, { ...p, wishRank: rank });
    } else {
      dropped.push({ ...p, wishRank: rank });
    }
  }

  // ── 第 1 步：校內推薦序分配 ─────────────────────────────────
  //
  // 依在校百分比排序（越小越好）。各校的推薦辦法可能有加分項，
  // 那要等 `StarNominationRule` 建起來才做得了——**現在沒有那張表，
  // 所以這裡只做預設辦法，並在畫面上說明用的是哪一條規則**，
  // 而不是假裝支援了自訂規則。
  const byPosition = new Map();
  const unranked = [];
  const noGroup = [];
  for (const p of best.values()) {
    if (!crossGroupSetOf(p.starGroup)) {
      // 繁星志願沒有填學群（或填了 1-8 以外的值）。**不能猜一個**——
      // 繁星的整個競爭結構就是「大學 × 學群」，猜錯學群等於把這位
      // 學生放到別人的隊伍裡排序，而畫面上一切正常。
      noGroup.push({ userId: p.userId, institutionName: p.institutionName });
      continue;
    }
    if (!Number.isFinite(p.percentile)) {
      // 教務處還沒匯這位學生的百分比。**不能當成 100%（最差）處理**——
      // 那會讓他在畫面上看到一個「你排最後」的假結論，而真正的問題
      // 是承辦人少匯了一列。
      unranked.push({ userId: p.userId, institutionName: p.institutionName, starGroup: p.starGroup });
      continue;
    }
    const key = positionKey(p.institutionName, p.starGroup);
    const list = byPosition.get(key) ?? [];
    list.push(p);
    byPosition.set(key, list);
  }

  const positions = [];
  for (const [key, list] of byPosition) {
    // 同分時用 userId 排，只為了讓兩次跑出來一樣。**這是任意的**，
    // 所以同分的人要被標出來——真的同分時是學校用推薦辦法的
    // tiebreak 決定，不是系統決定。
    const sorted = [...list].sort(
      (a, b) => a.percentile - b.percentile || (a.userId < b.userId ? -1 : 1),
    );
    const entries = sorted.map((p, i) => {
      const order = i + 1;
      const tied = sorted.some((q) => q.userId !== p.userId && q.percentile === p.percentile);
      return {
        userId: p.userId,
        percentile: p.percentile,
        order,
        tied,
        nominated: order <= quota,
        // ── 第 2 步：第一輪參賽判定 ──────────────────────────
        // 只有推薦序 1。**這裡不做任何跨學群的剔除**，理由見檔頭。
        firstRound: order === FIRST_ROUND_ORDER,
        // ── 第 4 步：第二輪 ──────────────────────────────────
        // 獲推薦的人都有第二輪的路：推薦序 2 至 6 直接參加，
        // 推薦序 1 若第一輪未錄取也回到第二輪。
        secondRound: order <= quota && order <= SECOND_ROUND_MAX_ORDER,
      };
    });
    positions.push({
      key,
      institutionName: list[0].institutionName,
      starGroup: list[0].starGroup,
      cohort: entries.length,
      quota,
      entries,
      unusedSlots: Math.max(0, quota - entries.length),
    });
  }
  positions.sort(
    (a, b) =>
      b.cohort - a.cohort ||
      (a.institutionName < b.institutionName ? -1 : a.institutionName > b.institutionName ? 1 : 0) ||
      a.starGroup - b.starGroup,
  );

  // ── 第 3 步：第一輪的結果端約束 ─────────────────────────────
  //
  // 「每所高中在每一所大學，第 1 至 3 類合計錄取 1 名」。
  // **兩個人都在第一輪**，只是最多一個上榜。這裡只把這件事**指出來**，
  // 不排掉任何人，也不算誰比較可能上——後者需要全國比序資料，
  // 而那份資料取不到（見檔頭）。
  /**
   * 型別要寫出來：`const squeeze = []` 推導成 `any[]`，於是承辦人那一頁
   * 讀 `s.members` 時 tsc 只會抱怨「隱含 any」而不會告訴你欄位名打錯了。
   *
   * @type {{institutionName: string, set: string, admitLimit: number,
   *   members: {userId: string, starGroup: number}[]}[]}
   */
  const squeeze = [];
  /** @type {Map<string, (typeof squeeze)[number]>} */
  const byInstitution = new Map();
  for (const pos of positions) {
    for (const e of pos.entries) {
      if (!e.firstRound) continue;
      const set = crossGroupSetOf(pos.starGroup);
      if (!set) continue;
      const key = `${pos.institutionName}${set.label}`;
      const g = byInstitution.get(key) ?? {
        institutionName: pos.institutionName,
        set: set.label,
        admitLimit: set.admitLimit,
        members: [],
      };
      g.members.push({ userId: e.userId, starGroup: pos.starGroup });
      byInstitution.set(key, g);
    }
  }
  for (const g of byInstitution.values()) {
    if (g.members.length > g.admitLimit) squeeze.push(g);
  }
  squeeze.sort((a, b) => b.members.length - a.members.length);

  return {
    computedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    quota,
    positions,
    squeeze,
    unranked,
    /** 繁星志願沒填學群，排不進任何位置。要通知學生補填。 */
    noGroup,
    dropped: dropped.map((d) => ({
      userId: d.userId,
      institutionName: d.institutionName,
      starGroup: d.starGroup,
    })),
    totals: {
      students: best.size,
      positions: positions.length,
      nominated: positions.reduce((n, p) => n + p.entries.filter((e) => e.nominated).length, 0),
      firstRound: positions.reduce((n, p) => n + p.entries.filter((e) => e.firstRound).length, 0),
    },
  };
}

// ═════════════════════════════════════════════════════════════════
// §3 學生端：只看得到自己的位置
// ═════════════════════════════════════════════════════════════════

/**
 * 第二輪的說明。**不是零，也不是一個數字。**
 *
 * 缺額取決於全國有多少人放棄或未達標，沒有直接資料。把第二輪當成零
 * 是系統性的悲觀偏誤——它會讓推薦序 2 的學生誤以為自己完全沒機會，
 * 而繁星的缺額多到值得講出一個數字，第二輪一點都不罕見。
 *
 * # 為什麼那個數字要從 `admission.mjs` 拿，而不是寫在這一行
 *
 * 因為它是**逐年公告的統計量**，而這一句話掛在每一位學生的每一個繁星
 * 位置底下。寫死在這裡的後果不是「數字舊了」——是那句話會**把舊數字
 * 掛上新年份**（或者根本不提年份），而讀者分不出來。集中在
 * `STAR_VACANCY_FACT` 之後，每年改一處，全站跟著對。
 *
 * @param {number} [year] 現在在談的學年度。
 */
function secondRoundNoteFor(year) {
  return (
    '若第一輪沒有錄取，或你是推薦序 2，該校系有缺額時還有第二輪，' +
    '第二輪不受「一校一名」限制。**本系統不估第二輪的機率**——' +
    `缺額取決於全國有多少人放棄，沒有這份資料。但它絕對不是零：${starVacancySentence(year)}。`
  );
}

/**
 * 把全校模擬切出一位學生看得到的那一片。
 *
 * **輸出裡不會有任何其他學生的 id、姓名、百分比或人數。**
 * 這不是靠呼叫端記得過濾，是靠這個函式只組得出這些欄位——
 * 它從 `sim` 讀進去的每一項都在下面明確列出來，多一項就要多寫一行。
 *
 * @param {ReturnType<typeof simulate>} sim
 * @param {string} userId
 * @param {number} [year] 現在在談的學年度。只用在第二輪那句說明裡的
 *   缺額數上——沒傳的話那句話會退回那個數字自己的年份，而不是假裝
 *   它是今年的。
 */
export function studentView(sim, userId, year = undefined) {
  const out = [];
  // 一次算好。它與位置無關，而每一個位置都要帶著同一句話。
  const secondRoundNote = secondRoundNoteFor(year);

  for (const pos of sim.positions) {
    const meIndex = pos.entries.findIndex((e) => e.userId === userId);
    if (meIndex < 0) continue;
    const me = pos.entries[meIndex];

    // 推論攻擊的防護：人少的時候只說「是不是第 1 位」。
    const hidden = pos.cohort < MIN_COHORT;
    const set = crossGroupSetOf(pos.starGroup);

    out.push({
      institutionName: pos.institutionName,
      starGroup: pos.starGroup,
      /** 具體名次。人數少於門檻時是 null——**這裡不能填任何替代值**。 */
      order: hidden ? null : me.order,
      hidden,
      isFirst: me.order === FIRST_ROUND_ORDER,
      nominated: me.nominated,
      quota: pos.quota,
      tied: me.tied,
      firstRound: me.firstRound,
      secondRound: me.secondRound,
      secondRoundNote,
      sensitivity: sensitivityOf(me.order, pos.quota, hidden),
      /**
       * 結果端的跨學群限制。**只講制度，不講校內事實。**
       * 「同校還有誰是推薦序 1」是別人的資料，不是他的。
       */
      crossGroupNote:
        me.firstRound && set
          ? `同一所高中在同一所大學，${set.label}學群**合計只錄取 ${set.admitLimit} 名**。` +
            '這是結果端的限制，不影響你參加第一輪——校內同一大學不同學群的推薦序 1 ' +
            '都會進第一輪，只是最後最多一位上榜。'
          : null,
    });
  }

  return {
    computedAt: sim.computedAt,
    positions: out,
    /** 填了繁星志願但教務處還沒匯百分比。這是承辦人要處理的事，不是學生的錯。 */
    unranked: sim.unranked.some((u) => u.userId === userId),
    /** 繁星志願沒填學群，所以排不出位置。這一項學生自己補得起來。 */
    noGroup: (sim.noGroup ?? []).some((u) => u.userId === userId),
    /** 一校一學群之下被拆掉的那幾個志願，只回數量（都是他自己的）。 */
    droppedCount: sim.dropped.filter((d) => d.userId === userId).length,
  };
}

/**
 * 敏感度：這個名次有多脆弱。
 *
 * 「你排第 4」一位同學改志願就變了。與其給一個看起來很精確的數字，
 * 不如同時說出它會往哪兩個方向跑——**兩個方向都要說**。
 */
export function sensitivityOf(order, quota, hidden) {
  if (hidden) {
    // 人數少到不能給名次時，連敏感度都會洩漏——「若一位排在你前面的
    // 同學離開你會變成第 1」等於說明現在有幾個人。
    return null;
  }
  const up = order > 1 ? order - 1 : null;
  const down = order + 1;
  return {
    ifOneAheadLeaves:
      up === null
        ? null
        : {
            order: up,
            nominated: up <= quota,
            text:
              `若有一位排在你前面的同學改推別的位置，你會變成第 ${up} 位` +
              (up <= quota && order > quota ? '，就進得了校內推薦名單' : '') +
              (up === FIRST_ROUND_ORDER ? '，也就是取得第一輪資格' : '') +
              '。',
          },
    ifOneBetterJoins: {
      order: down,
      nominated: down <= quota,
      text:
        `若有一位百分比比你好的同學改推這裡，你會退到第 ${down} 位` +
        (order <= quota && down > quota ? '，就落到校內推薦名單之外' : '') +
        (order === FIRST_ROUND_ORDER ? '，第一輪資格會換人' : '') +
        '。',
    },
  };
}

// ═════════════════════════════════════════════════════════════════
// §4 承辦人端：全校分布
//
// 承辦人真正需要知道的不是「照現在填的會怎樣」，而是**哪裡會出事**：
// 五個人擠在同一個位置、或者一個位置校內沒有人推薦。後者是白白放棄
// 一個機會，而且不會有任何人來反映——沒有人受害，所以沒有人知道。
// ═════════════════════════════════════════════════════════════════

/**
 * @param {ReturnType<typeof simulate>} sim
 * @param {{allGroups?: number[]}} [opts] 要檢查哪些學群有沒有人推薦。
 *   預設是 1 至 8。**只在校內已經有人關注的大學上檢查**——沒有校系
 *   資料庫，列不出全國所有大學，硬列會變成一份沒人看得完的清單。
 */
export function coordinatorReport(sim, { allGroups = [1, 2, 3, 4, 5, 6, 7, 8] } = {}) {
  const crowded = sim.positions
    .filter((p) => p.cohort > p.quota)
    .map((p) => ({
      institutionName: p.institutionName,
      starGroup: p.starGroup,
      cohort: p.cohort,
      quota: p.quota,
      squeezedOut: p.cohort - p.quota,
    }));

  const unused = sim.positions
    .filter((p) => p.unusedSlots > 0)
    .map((p) => ({
      institutionName: p.institutionName,
      starGroup: p.starGroup,
      cohort: p.cohort,
      unusedSlots: p.unusedSlots,
    }));

  // 校內已經有人關注的大學，還有哪些學群一個人都沒有。
  const institutions = [...new Set(sim.positions.map((p) => p.institutionName))].sort();
  const taken = new Set(sim.positions.map((p) => p.key));
  const empty = [];
  for (const inst of institutions) {
    const missing = allGroups.filter((g) => !taken.has(positionKey(inst, g)));
    if (missing.length > 0) empty.push({ institutionName: inst, starGroup: missing });
  }

  return {
    computedAt: sim.computedAt,
    totals: sim.totals,
    /** 競爭過度集中：想推的人多於校內推薦名額。 */
    crowded,
    /** 名額沒有用完。校內沒人推薦等於白白放棄一個機會。 */
    unused,
    /** 有人關注的大學裡，完全沒有人推薦的學群。 */
    empty,
    /** 結果端的跨學群排擠。**這幾位都在第一輪**，只是最後最多 1 人上榜。 */
    squeeze: sim.squeeze,
    /** 填了志願但還沒有在校百分比。承辦人要去補匯入。 */
    unranked: sim.unranked,
    /** 繁星志願沒填學群。要通知學生本人補填。 */
    noGroup: sim.noGroup ?? [],
    /** 一校一學群之下不會成立的那些志願。要通知學生本人。 */
    dropped: sim.dropped,
    positions: sim.positions,
  };
}

// ═════════════════════════════════════════════════════════════════
// §5 把第二層接上來
//
// 這個檔案的檔頭寫著「這個檔案不做第二層」，而那句話仍然成立：**系統
// 不會去取得全國錄取標準**（禁爬，見文件 07 §2.1）。改變的是資料來源
// ——**學生自己去官方網頁查，然後輸入進來**。禁止爬取的是機器不是人，
// 而那本來就是輔導老師會叫他做的事。
//
// 所以這一節不算任何東西，它只做一件事：**把兩層擺在同一個位置上。**
// 校內排第幾（系統數得出來，資料只有學校有）＋ 該校系去年的門檻是多少
// （學生查來的）。規格書 §7.1 說坊間工具只處理得了第二層，而學生真正
// 卡住的往往是第一層——兩層放在一起才是完整的圖，而分開放的話學生會
// 以為「我的百分比比門檻好」就等於會上，完全沒有意識到校內還有兩個人
// 排在他前面。
//
// **這一節仍然不產生任何機率。** 位置是數出來的，門檻是查來的，
// 兩個都是事實；把它們相減再乘一個係數就會變成編的。
// ═════════════════════════════════════════════════════════════════

/**
 * 兩層競爭的說明。**這段文字要跟著資料一起走**，理由與
 * `secondRoundNoteFor()` 相同：它是規則的一部分，不是版面的一部分。
 */
export const TWO_LAYER_NOTE =
  '繁星有兩層競爭，而它們的資料來源完全不同。**第一層是校內**：' +
  '同校同學之間直接排擠，這一層系統算得出來（在校百分比只有學校自己有）。' +
  '**第二層是全國**：該校系第一輪最後一名錄取者的在校百分比，' +
  '這一層要你自己去官方網頁查——系統不會去抓，招聯會全站禁止爬取。' +
  '兩層都要過。校內沒被推薦，全國門檻再寬也沒有用。';

/**
 * 學生查到的門檻要怎麼讀。
 *
 * 這段話不可以省略，也不可以縮短成「僅供參考」。規格書 §7.2 明文
 * 要求這類估計一律標示「基於最後一名錄取者的極值統計，樣本量極小」。
 */
export const THRESHOLD_BASIS_NOTE =
  '這幾個數字是**該校系第一輪最後一名錄取者**的在校百分比，' +
  '不是平均、也不是全體錄取生的分布——官方只公布這一個數字。' +
  '而繁星校系第一輪的名額常常只有 1 至 3 名，' +
  '也就是**每年只有一個極值資料點**，年際波動可能很大。' +
  '所以本系統不會把它算成一個機率，也不會用任何斷定的措辭——' +
  '規格書明文禁止那一類說法，理由就是這個資料基礎。';

/**
 * 大學名稱是不是同一所。
 *
 * 學生輸入志願時打「臺灣大學」，查資料時抄成「台灣大學」——那是同一所
 * 學校，而字串不相等。不處理的話，他查到的門檻對不上他的志願，畫面上
 * 顯示「你還沒有查這個校系的資料」，而他明明剛剛才輸入。
 *
 * 只折**異體字與空白**，不做模糊比對。「台大」與「臺灣大學」刻意**不**
 * 視為同一所：猜對了省一次輸入，猜錯了把甲校的門檻掛到乙校的位置上，
 * 而那個錯誤在畫面上完全看不出來。
 */
export function sameInstitution(a, b) {
  const fold = (s) =>
    String(s ?? '')
      .replace(/[\s　]+/g, '')
      .replace(/臺/g, '台')
      .replace(/國立|私立/g, '');
  return fold(a) === fold(b) && fold(a) !== '';
}

/**
 * 把學生查來的全國錄取標準掛到他自己的校內位置上。
 *
 * @param {ReturnType<typeof studentView>} view
 * @param {{institutionName: string, starGroup?: number|null, year: number,
 *   kind: string, describe?: string,
 *   value?: {percentile?: number}|null}[]} thresholds
 *   學生輸入的門檻資料（`AdmissionReference` 裡 `threshold` 那幾種）。
 *
 * 回傳是 `view` 的**擴充**而不是取代：既有的每一個欄位原樣留著，
 * 所以既有的畫面與那 39 項測試不受影響。
 */
export function withNationalThresholds(view, thresholds = []) {
  const matched = new Set();

  const positions = (view.positions ?? []).map((p) => {
    const mine = thresholds
      .filter((t) => {
        if (!sameInstitution(t.institutionName, p.institutionName)) return false;
        // 學群沒填的門檻資料**照樣掛上去**（學生查簡章時常常只記了學校
        // 與百分比）。掛錯學群的風險由畫面上標「這一筆沒有學群」承擔，
        // 而漏掉的成本是他看不到自己剛剛才輸入的東西。
        return t.starGroup == null || Number(t.starGroup) === Number(p.starGroup);
      })
      .sort((a, b) => b.year - a.year);
    for (const t of mine) matched.add(t);

    return {
      ...p,
      /** 第二層：他查來的全國門檻。**空陣列表示他還沒查**，不是沒有門檻。 */
      nationalThresholds: mine.map((t) => ({
        year: t.year,
        kind: t.kind,
        starGroup: t.starGroup ?? null,
        describe: t.describe ?? '',
        percentile: Number.isFinite(t.value?.percentile) ? t.value.percentile : null,
      })),
      twoLayerNote: TWO_LAYER_NOTE,
      thresholdBasisNote: mine.length > 0 ? THRESHOLD_BASIS_NOTE : null,
    };
  });

  return {
    ...view,
    positions,
    /**
     * 查到了但對不上任何校內位置的門檻。
     *
     * 要列出來而不是丟掉：最常見的原因是**他查了一個還沒填成志願的校系**
     * （那是好事，他在比較），第二常見的是校名打錯。兩種都需要被看見，
     * 而靜靜吞掉的症狀是「我輸入的資料不見了」。
     */
    unmatchedThresholds: thresholds.filter((t) => !matched.has(t)),
  };
}
