/**
 * 卷子上那幾題的附圖。
 *
 * # 為什麼組卷這一區要自己一支
 *
 * 附圖的位元組本來只有校對介面拿得到（`/api/import/[jobId]/image`），
 * 而那一支綁在「匯入工作」上：它問的是「你教不教這份題本的科目」。
 * 題目入庫之後，圖還在同一個物件鍵上，但已經沒有任何畫面拿得到它——
 * 於是整卷預覽與紙本考卷上，幾何題會是一段沒有圖的敘述。
 * **沒有圖的幾何題印出去，學生寫不了。**
 *
 * # 權限：三道，缺一不可
 *
 *   1. `scopedRoute` —— 要登入，整段查詢跑在該使用者的租戶脈絡下
 *   2. `mayComposeArea` —— 這一區只有老師與管理員進得來（學生看到的
 *      會是還沒考的題目）
 *   3. **物件鍵必須真的出現在這份卷子的某一題上** —— 不是比對前綴，
 *      是比對「這份卷子的題目所引用的那一組鍵」。帶著別份卷子、
 *      甚至別科的鍵進來一律 403。
 *
 * 第三道比前綴檢查嚴：前綴只綁得住「同一份匯入工作」，而同一份工作
 * 匯進來的題目會散在很多份卷子上。
 *
 * 快取一律 `private`：這些圖出自出版社的題本，不可以被任何共用快取留下來。
 */
import { NextRequest, NextResponse } from 'next/server';

import { mayComposeArea } from '@/lib/paper';
import { prisma } from '@/lib/prisma';
import { getObject } from '@/lib/storage';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/** 渲染出來的頁面一律是 PNG，裁出來的附圖有可能是 JPEG。 */
function contentType(key: string) {
  const ext = key.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

/**
 * 從 `contentAssets` / `stimulusAssets` / 選項的 `assets` 裡把鍵挖出來。
 *
 * 這三欄都是 Json，形狀由 `lib/commit.ts` 的 `normalizeAssets` 決定
 * （`{key, page, bbox, alt}[]`）。**這裡不假設它一定是那個形狀**：
 * 舊資料或手動改過的列有可能是別的東西，而一個 `.map` 丟出的
 * TypeError 會讓整張圖變成 500。
 */
function keysOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) =>
      a && typeof a === 'object' && typeof (a as { key?: unknown }).key === 'string'
        ? (a as { key: string }).key
        : null,
    )
    .filter((k): k is string => Boolean(k));
}

export const GET = scopedRoute<{ paperId: string }>(async (req: NextRequest, { user, params }) => {
  if (!mayComposeArea(user.systemRole, '/papers')) {
    return NextResponse.json({ error: '沒有權限' }, { status: 403 });
  }

  const key = new URL(req.url).searchParams.get('key');
  if (!key) return NextResponse.json({ error: '要指定 key' }, { status: 400 });

  const items = await prisma.examPaperItem.findMany({
    where: { paperId: params.paperId },
    select: {
      question: {
        select: {
          contentAssets: true,
          group: { select: { stimulusAssets: true } },
          options: { select: { assets: true } },
        },
      },
    },
  });
  if (items.length === 0) {
    return NextResponse.json({ error: '找不到這份試卷，或它還沒有題目' }, { status: 404 });
  }

  const allowed = new Set<string>();
  for (const it of items) {
    for (const k of keysOf(it.question.contentAssets)) allowed.add(k);
    for (const k of keysOf(it.question.group?.stimulusAssets)) allowed.add(k);
    for (const o of it.question.options) for (const k of keysOf(o.assets)) allowed.add(k);
  }
  if (!allowed.has(key)) {
    return NextResponse.json({ error: '這張圖不屬於這份卷子上的任何一題' }, { status: 403 });
  }

  try {
    const buf = await getObject(key);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': contentType(key),
        'Content-Length': String(buf.length),
        // 私有快取。列印一份 25 題的卷子會把每一張圖再要一次，
        // 而它們是出版社的原稿，不可以進任何共用快取。
        'Cache-Control': 'private, max-age=900',
        'Content-Disposition': 'inline',
      },
    });
  } catch (e) {
    // 物件不見了（保留期限清掉、或匯入的第一階段其實沒跑完）不是
    // 伺服器壞掉。說清楚，老師才知道這一題印出去會缺圖。
    return NextResponse.json(
      {
        error: '這一張附圖已經不在了',
        hint: `原稿影像可能已被清理。這一題印出去會缺圖，請先確認再發給學生。${
          e instanceof Error ? `（${e.message}）` : ''
        }`,
      },
      { status: 404 },
    );
  }
});
