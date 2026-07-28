/**
 * 知識點前置圖譜的純圖論部分。**沒有任何相依，所以測得動。**
 *
 * # 為什麼環路偵測是這一批的重點
 *
 * 前置關係是一張有向圖：「解一元二次方程式」的前置是「因式分解」，
 * 「因式分解」的前置是「乘法公式」。系統有兩個地方會沿著這張圖走：
 *
 *   · 智慧老師在學生卡住時**往回走**，找出該補的前置觀念
 *   · 能力分析把高階題的學分**往下傳**給前置知識點（文件 09 §5）
 *
 * 兩者都是遞迴。圖裡有環的話，**它們會無限迴圈**——而環不是有人
 * 故意加的，是三位老師各自加了一條邊之後湊出來的：
 *
 *     甲老師：三角函數 ← 需要 → 弧度
 *     乙老師：弧度     ← 需要 → 圓的方程式
 *     丙老師：圓的方程式 ← 需要 → 三角函數     ← 這一條把環閉合了
 *
 * 丙老師看不到前兩條的組合效果。所以偵測必須在**加邊的當下**做，
 * 而且訊息要指出整條環路——只說「不能加」的話，他只會覺得系統壞了。
 */

/**
 * 加一條「kp 需要 prereq」的邊會不會產生環路？
 *
 * 回傳 null 代表可以加；有環的話回傳整條路徑（從 prereq 走回 kp），
 * 讓呼叫端可以把它印給人看。
 *
 * @param {Map<string, string[]>} edges kpId → 它的前置 kpId 陣列
 */
export function findCycle(edges, kpId, prereqKpId) {
  if (kpId === prereqKpId) return [kpId, kpId];

  // 從 prereq 出發往前置方向走，看走不走得回 kp。
  // 走得回去，代表「kp 需要 prereq」會讓 kp 間接需要自己。
  const path = [];
  const seen = new Set();

  const walk = (node) => {
    if (node === kpId) {
      path.push(node);
      return true;
    }
    if (seen.has(node)) return false;
    seen.add(node);
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      if (walk(next)) return true;
    }
    path.pop();
    return false;
  };

  return walk(prereqKpId) ? [kpId, ...path] : null;
}

/**
 * 拓樸排序。回傳從「最基礎」到「最進階」的順序。
 *
 * 用途是教學順序的建議與課程檢查：一個班若還沒教「因式分解」就派了
 * 「一元二次方程式」的練習，系統該提醒。
 *
 * 圖裡有環時回傳 null——**呼叫端必須處理這個情況**，因為既有資料
 * 可能是在環路偵測上線之前建的。
 */
export function topoSort(nodes, edges) {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  const out = new Map(nodes.map((n) => [n, []]));
  for (const [kp, prereqs] of edges) {
    for (const p of prereqs) {
      if (!indeg.has(kp) || !indeg.has(p)) continue;
      // 邊的方向：前置 → 依賴它的
      out.get(p).push(kp);
      indeg.set(kp, indeg.get(kp) + 1);
    }
  }
  const queue = nodes.filter((n) => indeg.get(n) === 0).sort();
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const m of out.get(n) ?? []) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
    queue.sort();
  }
  return order.length === nodes.length ? order : null;
}

/**
 * 找出圖裡既有的所有環路。
 *
 * 給「上線之前先檢查一次」用：環路偵測是這一批才加的，在那之前
 * 建的資料可能已經有環，而那些環會在智慧老師第一次往回走時
 * 變成無限迴圈。與其等它發生，不如先掃一遍。
 */
export function allCycles(edges) {
  const cycles = [];
  const state = new Map(); // 0 未訪 / 1 訪問中 / 2 完成
  const stack = [];

  const visit = (node) => {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) {
      const at = stack.indexOf(node);
      if (at >= 0) cycles.push([...stack.slice(at), node]);
      return;
    }
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) visit(next);
    stack.pop();
    state.set(node, 2);
  };

  for (const node of edges.keys()) visit(node);
  return cycles;
}
