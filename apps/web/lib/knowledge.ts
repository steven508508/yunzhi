/**
 * 知識點與前置圖譜。
 *
 * # 為什麼這一塊在關鍵路徑上
 *
 * 開發路線圖（文件 05）說知識點圖譜是「唯一一個不能延後的前置項」，
 * 因為匯入、能力分析、智慧老師三個模組都依賴它。
 *
 * 實際狀況是：`KnowledgePoint` 在程式裡**只被讀、從來沒被寫**，
 * 唯一的資料來源是種子檔裡的 10 筆示範資料。後果現在就看得到——
 * 匯入管線的標註階段會去 `knowledge_points` 做相似度比對，
 * 而那張表幾乎是空的，所以**標註階段實際上是失效的**，
 * 它只會回報「找不到合適的候選知識點」。
 *
 * 這個檔案補上寫入路徑。
 *
 * # 建置成本要先講清楚
 *
 * 這不只是寫程式。文件 05 估**每科 4 到 8 小時的老師工時，
 * 11 個學科合計 44 到 88 小時**。這筆時間要排進專案，不能假設
 * 「系統做好之後老師自然會去填」——那是這類專案最常見的死法。
 *
 * 建議先只做數學 A（結構最清晰），驗證價值後再擴充。
 */
import { prisma } from '@/lib/prisma';
import { requireTenant } from '@/lib/tenant';
import { allCycles, findCycle, topoSort } from '@/lib/graph.mjs';

export type KpInput = {
  subjectId: string;
  name: string;
  description?: string | null;
  /** 遺忘衰減率。愈大代表愈容易忘。 */
  decayRate?: number;
  /** 學測權重。用於推薦時的優先度。 */
  gsatWeight?: number;
};

export async function createKnowledgePoint(input: KpInput, actorId: string) {
  const tenantId = requireTenant();
  const name = input.name.trim();
  if (!name) throw new Error('請填寫知識點名稱');
  if (name.length > 80) throw new Error('知識點名稱太長。它會出現在學生的能力分析上。');

  const subject = await prisma.subject.findFirst({
    where: { id: input.subjectId },
    select: { id: true, name: true },
  });
  if (!subject) throw new Error('找不到這個科目');

  const dup = await prisma.knowledgePoint.findFirst({
    where: { subjectId: subject.id, name },
    select: { id: true },
  });
  if (dup) {
    // 同名知識點會讓能力分析分裂成兩份，而症狀是「明明練了很多，
    // 掌握度卻上不去」。擋在這裡比事後合併容易得多。
    throw new Error(`「${subject.name}」已經有一個「${name}」了`);
  }

  const kp = await prisma.knowledgePoint.create({
    data: {
      tenantId,
      subjectId: subject.id,
      name,
      description: input.description?.trim() || null,
      decayRate: clamp(input.decayRate ?? 0.05, 0, 1),
      gsatWeight: clamp(input.gsatWeight ?? 1, 0, 10),
    },
  });
  await audit(tenantId, actorId, 'kp.create', kp.id, { subject: subject.name, name });
  return kp;
}

export async function updateKnowledgePoint(
  kpId: string,
  patch: Partial<KpInput>,
  actorId: string,
) {
  const tenantId = requireTenant();
  const before = await prisma.knowledgePoint.findFirst({
    where: { id: kpId },
    select: { id: true, name: true, subjectId: true },
  });
  if (!before) throw new Error('找不到這個知識點');

  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('請填寫知識點名稱');
    if (name !== before.name) {
      const dup = await prisma.knowledgePoint.findFirst({
        where: { subjectId: before.subjectId, name },
        select: { id: true },
      });
      if (dup) throw new Error(`這一科已經有一個「${name}」了`);
      data.name = name;
    }
  }
  if (patch.description !== undefined) data.description = patch.description?.trim() || null;
  if (patch.decayRate !== undefined) data.decayRate = clamp(patch.decayRate, 0, 1);
  if (patch.gsatWeight !== undefined) data.gsatWeight = clamp(patch.gsatWeight, 0, 10);
  if (Object.keys(data).length === 0) return before;

  const after = await prisma.knowledgePoint.update({ where: { id: kpId }, data });
  await audit(tenantId, actorId, 'kp.update', kpId, { before: before.name, patch: data });
  return after;
}

/**
 * 刪除知識點。
 *
 * 已經有題目掛上去的不給刪——那些題目的能力分析會整個斷掉，
 * 而且不會有任何錯誤訊息，只是那幾題從此不計入任何知識點。
 * 要刪就先把題目改掛到別的知識點。
 */
export async function deleteKnowledgePoint(kpId: string, actorId: string) {
  const tenantId = requireTenant();
  const kp = await prisma.knowledgePoint.findFirst({
    where: { id: kpId },
    select: { id: true, name: true, _count: { select: { questions: true } } },
  });
  if (!kp) throw new Error('找不到這個知識點');
  if (kp._count.questions > 0) {
    throw new Error(
      `「${kp.name}」有 ${kp._count.questions} 題掛在上面。` +
        `直接刪掉的話那幾題不會有任何錯誤，只是從此不計入任何知識點——` +
        `請先把它們改掛到別的知識點。`,
    );
  }
  await prisma.knowledgePoint.delete({ where: { id: kpId } });
  await audit(tenantId, actorId, 'kp.delete', kpId, { name: kp.name });
  return kp;
}

// ─────────────────────────────────────────────────────────────────
// 前置關係
// ─────────────────────────────────────────────────────────────────

/** 讀出某一科的整張前置圖。 */
async function loadEdges(subjectId: string): Promise<Map<string, string[]>> {
  const rows = await prisma.kpPrerequisite.findMany({
    where: { kp: { subjectId } },
    select: { kpId: true, prereqKpId: true },
  });
  const edges = new Map<string, string[]>();
  for (const r of rows) {
    edges.set(r.kpId, [...(edges.get(r.kpId) ?? []), r.prereqKpId]);
  }
  return edges;
}

/**
 * 加一條前置關係：`kpId` 需要先學會 `prereqKpId`。
 *
 * **環路必須在加邊的當下擋下來。** 環不是有人故意加的，是三位老師
 * 各自加了一條邊之後湊出來的——而第三位看不到前兩條的組合效果。
 *
 * 有環的話，智慧老師往回找前置觀念、以及能力分析往下傳學分，
 * 兩者都會無限迴圈。
 */
export async function addPrerequisite(
  kpId: string,
  prereqKpId: string,
  actorId: string,
  strength = 1,
) {
  const tenantId = requireTenant();
  if (kpId === prereqKpId) throw new Error('一個知識點不能是自己的前置');

  const [kp, prereq] = await Promise.all([
    prisma.knowledgePoint.findFirst({
      where: { id: kpId },
      select: { id: true, name: true, subjectId: true },
    }),
    prisma.knowledgePoint.findFirst({
      where: { id: prereqKpId },
      select: { id: true, name: true, subjectId: true },
    }),
  ]);
  if (!kp || !prereq) throw new Error('找不到指定的知識點');
  if (kp.subjectId !== prereq.subjectId) {
    // 跨科前置在教學上存在（物理需要數學），但那要另一種資料結構
    // 與另一套走訪規則。現在擋住，比事後發現分析結果混了兩科好。
    throw new Error('目前只支援同一科目內的前置關係');
  }

  const edges = await loadEdges(kp.subjectId);
  const cycle = findCycle(edges, kpId, prereqKpId);
  if (cycle) {
    const names = await namesOf(cycle);
    throw new Error(
      `這條關係會形成循環：${names.join(' → ')}。\n` +
        `循環會讓智慧老師往回找前置觀念時無限繞圈。` +
        `請先移除路徑上的其中一條關係。`,
    );
  }

  const link = await prisma.kpPrerequisite.upsert({
    where: { kpId_prereqKpId: { kpId, prereqKpId } },
    create: { kpId, prereqKpId, strength: clamp(strength, 0, 1), verifiedBy: actorId },
    update: { strength: clamp(strength, 0, 1), verifiedBy: actorId },
  });
  await audit(tenantId, actorId, 'kp.prereq.add', kpId, {
    kp: kp.name,
    prereq: prereq.name,
  });
  return link;
}

export async function removePrerequisite(kpId: string, prereqKpId: string, actorId: string) {
  const tenantId = requireTenant();
  const { count } = await prisma.kpPrerequisite.deleteMany({ where: { kpId, prereqKpId } });
  if (count === 0) throw new Error('這條前置關係不存在');
  await audit(tenantId, actorId, 'kp.prereq.remove', kpId, { prereqKpId });
  return count;
}

/**
 * 整張圖的健康檢查。
 *
 * 環路偵測是這一批才加的，在那之前建的資料可能已經有環——而那些環
 * 會在智慧老師第一次往回走時變成無限迴圈。與其等它發生，先掃一遍。
 */
export async function inspectGraph(subjectId: string) {
  requireTenant();
  const [points, edges] = await Promise.all([
    prisma.knowledgePoint.findMany({
      where: { subjectId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    loadEdges(subjectId),
  ]);

  const ids = points.map((p) => p.id);
  const cycles = allCycles(edges);
  const order = topoSort(ids, edges);
  const byId = new Map(points.map((p) => [p.id, p.name]));

  return {
    total: points.length,
    /** 沒有任何前置、也不是任何人的前置——孤立的知識點。 */
    isolated: points
      .filter((p) => !edges.has(p.id) && ![...edges.values()].flat().includes(p.id))
      .map((p) => p.name),
    cycles: cycles.map((c: string[]) => c.map((id: string) => byId.get(id) ?? id)),
    /** 從最基礎到最進階。有環時是 null。 */
    teachingOrder: order?.map((id: string) => byId.get(id) ?? id) ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────

async function namesOf(ids: string[]): Promise<string[]> {
  const rows = await prisma.knowledgePoint.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return ids.map((id) => byId.get(id) ?? id);
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

async function audit(
  tenantId: string,
  actorId: string,
  action: string,
  targetId: string,
  after: Record<string, unknown>,
) {
  await prisma.auditLog.create({
    data: {
      tenantId,
      category: 'QUESTION',
      action,
      actorId,
      targetType: 'KnowledgePoint',
      targetId,
      after: after as never,
    },
  });
}
