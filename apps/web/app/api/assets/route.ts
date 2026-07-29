/**
 * 題目附圖的位元組。
 *
 * # 為什麼不把物件儲存的簽名網址丟給前端
 *
 * 因為那等於發一張**任何人都能用**的通行證：簽名 URL 不帶身分，
 * 誰拿到誰就讀得到，而學生的作答頁在開發者工具裡是全開的。
 * 一份「數學段考」的圖被學生抄走網址貼給隔壁班，系統不但擋不住，
 * 連查都查不到——存取記錄上只有 MinIO 的一次匿名 GET。
 * 過期時間也不受控：15 分鐘對一節考試太短、對外流太長。
 *
 * 另外一個更直接的理由寫在 `lib/storage.ts` 的 `signedGetUrl`：
 * MinIO 只掛在 compose 的 `internal` 網路，瀏覽器根本連不到它。
 *
 * 所以位元組由伺服器代送，授權判斷留在應用層。
 *
 * # 兩種身分，兩條完全不同的問題
 *
 * **老師**問的是「你教不教這一科」。附圖的鍵帶著匯入工作的 id
 * （`t/<租戶>/import/<工作>/…`），而工作有科目，所以一次 `canEditSubject`
 * 就問完了——不必去掃題庫的 Json 欄位找是哪一題用了這張圖。
 *
 * **學生**問的是「這是不是你自己那一份，而且現在該讓你看」。
 * 他沒有科目授課權，永遠走不到上面那條路；他能看到的圖只有兩種：
 * 正在作答的那一份卷子上的，以及已經開放檢討的那一份上的。
 * 交完卷但還沒放行的那一段時間**看不到**——ON_DUE 的整個用意就是
 * 先寫完的人不能把題目帶出考場，而附圖就是題目。
 *
 * 兩條路都不自己列角色：老師那條走 `canEditSubject`，學生那條走
 * `maySeeResult`（與檢討頁同一支純函式，有單元測試）。第三份角色
 * 清單遲早會與前兩份不一致，而不一致的方向若是放行，沒有人會發現。
 *
 * # 快取
 *
 * 同一張圖的位元組永遠不會變（重跑匯入會產生新的鍵），所以給一年的
 * `max-age` 加 `immutable`，讓瀏覽器連 revalidate 都不必發。
 * 一律 `private`：這些圖出自出版社的題本，不可以留在任何共用快取裡。
 * 伺服器端還有一層行程內快取（`getObjectCached`），一個班同時打開
 * 同一題時只會有一次真的 GetObject。
 */
import { NextRequest, NextResponse } from 'next/server';

import { paperCohort } from '@/lib/assignment';
import { readLayout } from '@/lib/attempt';
import { canEditSubject, type SessionUser } from '@/lib/auth';
import { escapeHtml, readAssets } from '@/lib/math.mjs';
import { prisma } from '@/lib/prisma';
import { maySeeResult } from '@/lib/release.mjs';
import { scopedRoute } from '@/lib/route';
import { getObjectCached, parseImportKey } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** 裁出來的附圖一律是 PNG，但舊資料與掃描件可能是別的。 */
function contentType(key: string) {
  const ext = key.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

/**
 * 找不到圖時回一個**看得出來的東西**。
 *
 * 不能讓瀏覽器畫破圖：破圖與「這一題本來就沒有圖」在畫面上長得
 * 一模一樣，學生不會舉手，老師也不會知道這一題發不出去。
 * 回一張說得出話的 SVG，前端的 `<img>` 照樣顯示得出來——
 * 它同時是給人看的訊息，也是一個 200 以外的狀態碼。
 */
function missing(status: number, message: string) {
  // **訊息一定要轉義。** 它裡面有科目名稱，而科目名稱是老師在
  // 設定頁自己打的——一個叫做 `數學"A` 的科目會讓下面那個
  // `aria-label="…"` 就地收尾，整份 SVG 變成剖不開的 XML，
  // 而畫面上出現的是破圖：正是這一支要避免的東西。
  const safe = escapeHtml(message);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" role="img" ` +
    `aria-label="${safe}">` +
    `<rect width="320" height="120" fill="#F7F4EE" stroke="#8C3A2B"/>` +
    `<text x="160" y="56" text-anchor="middle" font-size="13" fill="#8C3A2B">附圖無法顯示</text>` +
    `<text x="160" y="78" text-anchor="middle" font-size="11" fill="#5B564E">${safe}</text>` +
    `</svg>`;
  return new NextResponse(svg, {
    status,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // SVG 由 <img> 載入時瀏覽器不會執行它裡面的 script，但這一行
      // 是給「有人直接開這個網址」那條路的：它是我們自己拼出來的
      // XML，沒有理由讓瀏覽器去猜它是別的東西。
      'X-Content-Type-Options': 'nosniff',
      // 錯誤不快取。權限剛好還沒生效、或匯入還在跑的情況下，
      // 一個被快取一年的「看不到」會跟著這位學生到考試結束。
      'Cache-Control': 'no-store',
    },
  });
}

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  const attemptId = url.searchParams.get('attempt');

  if (!key) return missing(400, '這個網址沒有指定要哪一張圖');

  // 鍵的第一段就是租戶。**先擋這一道**：後面兩條路各自還會再驗一次，
  // 但那兩次都要先查資料庫，而跨租戶的請求連查都不該查。
  const parsed = parseImportKey(key);
  if (!parsed || parsed.tenantId !== user.tenantId) {
    return missing(403, '這張圖不屬於你的機構');
  }

  const allowed = attemptId
    ? await mayStudentSee(attemptId, user.id, key)
    : await mayTeacherSee(user, parsed.jobId);

  if (allowed !== true) return missing(403, allowed);

  try {
    const { buf, etag } = await getObjectCached(key);

    // 瀏覽器帶著上次的 ETag 回來時只回 304。列印一份 25 題的卷子會
    // 把每一張圖再要一次，而它們一個位元組都沒變。
    if (req.headers.get('if-none-match') === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable' },
      });
    }

    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': contentType(key),
        'Content-Length': String(buf.length),
        ETag: etag,
        // immutable：同一個鍵的內容不會被覆寫，重跑匯入產生的是新的鍵。
        // private：出版社的原稿，不可以進任何共用快取。
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Disposition': 'inline',
      },
    });
  } catch {
    // 物件不見了（保留期限清掉、或匯入的第一階段其實沒跑完）。
    // 這不是伺服器壞掉，而且**學生要知道這一題本來有圖**——
    // 否則他會照著一份缺了條件的題目作答。
    return missing(404, '這張圖已經不在了，考試中請舉手告訴監考老師');
  }
});

/**
 * 老師：教這份題本的科目就看得到。
 *
 * 綁在**匯入工作**而不是題目上，是因為鍵裡有工作 id 而沒有題目 id。
 * 兩者的科目是同一個——入庫時 `Question.subjectId` 就是 `job.subjectId`
 * （見 lib/commit.ts），所以這一問與「你教不教這一題的科目」等價，
 * 只是不必為它掃一次整個題庫的 Json 欄位。
 */
async function mayTeacherSee(user: SessionUser, jobId: string): Promise<true | string> {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, tenantId: user.tenantId },
    select: { subjectId: true, subject: { select: { name: true } } },
  });
  if (!job) return '找不到這張圖出自哪一份題本';
  if (!(await canEditSubject(user, job.subjectId))) {
    return `你不是「${job.subject.name}」的授課老師`;
  }
  return true;
}

/**
 * 學生：只有自己那一份，而且只在作答中或已開放檢討的時候。
 *
 * 三道，順序不能換：
 *
 *   1. 這一份是不是你的（`userId` 比對。RLS 擋得住別家補習班，
 *      擋不住同一間補習班的隔壁同學——他的 attempt 與你的同租戶）
 *   2. 現在該不該讓你看（作答中，或 `maySeeResult` 說 FULL）
 *   3. 這張圖在不在**這一份卷子的題目**上（不然帶著別份的鍵就能
 *      在考試中把還沒考的那一份題本翻出來）
 *
 * 第三道拿的是 `Attempt.layout` 快照而不是卷子現在的題目：老師在
 * 考試中換掉一題時，已經開始的人看到的仍然是他手上那一份。
 */
async function mayStudentSee(
  attemptId: string,
  userId: string,
  key: string,
): Promise<true | string> {
  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId, userId },
    select: {
      status: true,
      submittedAt: true,
      layout: true,
      assignment: {
        select: {
          id: true,
          paperId: true,
          dueAt: true,
          releasePolicy: true,
          releasedAt: true,
        },
      },
    },
  });
  if (!attempt) return '這不是你的作答';

  if (attempt.status !== 'IN_PROGRESS') {
    const vis = maySeeResult(
      {
        ...attempt.assignment,
        // 同一份卷子還被別的任務用著時，「截止後開放」指的是最後一班
        // 考完——與檢討頁同一條規則（見 lib/release.mjs 的 cohortGate）。
        // 少了這一句，先考完的班在截止那一刻就拿得到還沒考的班的附圖。
        paperCohort: await paperCohort(attempt.assignment.paperId, attempt.assignment.id),
      },
      attempt,
    );
    if (vis.level !== 'FULL') return '這一份的檢討還沒有開放';
  }

  const ids = readLayout(attempt.layout).map((i) => i.questionId);
  if (ids.length === 0) return '這一份作答沒有題目';

  const questions = await prisma.question.findMany({
    where: { id: { in: ids } },
    select: {
      contentAssets: true,
      group: { select: { stimulusAssets: true } },
      options: { select: { assets: true } },
    },
  });

  for (const q of questions) {
    if (readAssets(q.contentAssets).some((a) => a.key === key)) return true;
    if (readAssets(q.group?.stimulusAssets).some((a) => a.key === key)) return true;
    for (const o of q.options) {
      if (readAssets(o.assets).some((a) => a.key === key)) return true;
    }
  }
  return '這張圖不屬於你這一份卷子上的任何一題';
}
