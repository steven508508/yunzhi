/**
 * 原稿頁面影像與附圖。
 *
 * # 為什麼要有這一支
 *
 * 校對介面左邊那一欄標著「原稿」，而在這之前它畫的是右邊那一欄的
 * 同一份 AI 輸出——老師以為自己在對照原稿，其實是在對照 AI 自己說的話。
 * 真正的原稿一直都在：第一階段把每一頁渲染成影像存進物件儲存
 * （`import-pipeline.mjs` 的 `stageNormalize`），`figures.py` 還把附圖
 * 裁了出來。缺的只是一支把它送到瀏覽器的路由。
 *
 * 這一項是「50 題 20 分鐘」那筆帳裡最大的一塊：沒有它，每一題都要付
 * 一次「翻紙本、找題號」的稅（2–8 秒），全份 100–400 秒。
 *
 * # 為什麼位元組走這裡，而不是把簽名 URL 丟給瀏覽器
 *
 * MinIO 只掛在 compose 的 `internal` 網路上，Caddy 也沒有代理它
 * （`docker-compose.yml`、`deploy/caddy/Caddyfile`）——**簽名 URL 在
 * 瀏覽器上連不到**。所以這裡由應用層取出位元組再送出去，權限判斷
 * 因此也留在應用層，與 `lib/storage.ts` 檔頭寫的原則一致：
 * 「刻意不讓 MinIO 直接對外——授權判斷在應用層。」
 *
 * # 權利控管
 *
 * 題本原檔是出版社的。三道關卡缺一不可：
 *
 *   1. `scopedRoute` —— 要登入，而且整段查詢跑在該使用者的租戶脈絡下
 *   2. `canEditSubject` —— 要是這一科的授課老師（學生與家長一律進不來）
 *   3. 物件鍵必須落在**這份工作的前綴**底下 —— 不然帶著別人的
 *      storageKey 進來就能把整個 bucket 讀光
 *
 * 快取一律 `private`：這些影像不可以被任何共用快取留下來。
 */
import { NextRequest, NextResponse } from 'next/server';
import { scopedRoute } from '@/lib/route';
import { prisma } from '@/lib/prisma';
import { canEditSubject } from '@/lib/auth';
import { getObject, importPrefix } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** 依副檔名判斷。渲染出來的頁面一律是 PNG，附圖有可能是 JPEG。 */
function contentType(key: string) {
  const ext = key.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

export const GET = scopedRoute<{ jobId: string }>(async (req: NextRequest, { user, params }) => {
  const job = await prisma.importJob.findFirst({
    where: { id: params.jobId, tenantId: user.tenantId },
    select: { id: true, subjectId: true, subject: { select: { name: true } } },
  });
  if (!job) return NextResponse.json({ error: '找不到匯入工作' }, { status: 404 });

  if (!(await canEditSubject(user, job.subjectId))) {
    return NextResponse.json(
      { error: `你不是「${job.subject.name}」的授課老師，無法看這份題本的原稿` },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const pageParam = url.searchParams.get('page');
  const fileId = url.searchParams.get('file');
  const keyParam = url.searchParams.get('key');

  let key: string | null = null;

  if (pageParam) {
    // 頁碼由資料庫換成物件鍵，不讓呼叫端直接指定——少一個可以被亂填的
    // 參數，就少一種要證明它安全的情況。
    const page = Number(pageParam);
    if (!Number.isInteger(page) || page < 1) {
      return NextResponse.json({ error: '頁碼不正確' }, { status: 400 });
    }
    const row = await prisma.importPage.findFirst({
      where: { jobId: job.id, index: page, ...(fileId ? { fileId } : {}) },
      orderBy: { fileId: 'asc' },
      select: { storageKey: true },
    });
    if (!row) return NextResponse.json({ error: '找不到這一頁' }, { status: 404 });
    key = row.storageKey;
  } else if (keyParam) {
    // 附圖的鍵存在候選題的 assets 裡，由前端帶回來。前綴檢查是這裡
    // 唯一的防線：`t/<租戶>/import/<工作>/` 同時綁住租戶與工作，
    // 而兩者上面都驗過了。
    const prefix = importPrefix(user.tenantId, job.id);
    if (!keyParam.startsWith(prefix) || keyParam.includes('..')) {
      return NextResponse.json({ error: '這個物件不屬於這份匯入工作' }, { status: 403 });
    }
    key = keyParam;
  } else {
    return NextResponse.json({ error: '要指定 page 或 key' }, { status: 400 });
  }

  try {
    const buf = await getObject(key);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': contentType(key),
        'Content-Length': String(buf.length),
        // 私有快取：校對時同一頁會被反覆看，重載一次要五秒。
        // 但它是出版社的原稿，不可以進任何共用快取。
        'Cache-Control': 'private, max-age=900',
        'Content-Disposition': 'inline',
      },
    });
  } catch (e) {
    // 物件不見了（保留期限清掉、或第一階段其實沒跑完）不是伺服器
    // 壞掉。說清楚才不會讓老師去按重跑。
    return NextResponse.json(
      {
        error: '這一頁的影像已經不在了',
        hint: `原稿影像可能已被清理，或這份題本的檔案處理階段沒有完成。${
          e instanceof Error ? `（${e.message}）` : ''
        }`,
      },
      { status: 404 },
    );
  }
});
