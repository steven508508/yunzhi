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
 * 而 115 學年度繁星的缺額有 922 名，第二輪一點都不罕見。
 */
const SECOND_ROUND_NOTE =
  '若第一輪沒有錄取，或你是推薦序 2，該校系有缺額時還有第二輪，' +
  '第二輪不受「一校一名」限制。**本系統不估第二輪的機率**——' +
  '缺額取決於全國有多少人放棄，沒有這份資料。但它絕對不是零：' +
  '115 學年度繁星全國缺額 922 名。';

/**
 * 把全校模擬切出一位學生看得到的那一片。
 *
 * **輸出裡不會有任何其他學生的 id、姓名、百分比或人數。**
 * 這不是靠呼叫端記得過濾，是靠這個函式只組得出這些欄位——
 * 它從 `sim` 讀進去的每一項都在下面明確列出來，多一項就要多寫一行。
 */
export function studentView(sim, userId) {
  const out = [];

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
      secondRoundNote: SECOND_ROUND_NOTE,
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
