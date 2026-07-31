/**
 * 一份題本：刪除。
 *
 * 規則全部在 `lib/importDelete.ts`，這一層只把錯誤翻成狀態碼。
 *
 * `?withQuestions=1` 才會連帶刪除這份題本產出、且**還沒被用過**的
 * 題目。預設不動它們——題目入庫之後是獨立的題庫條目，把「清掉匯入
 * 紀錄」跟「炸掉題庫」綁在一起是很容易後悔的預設值。
 */
import { NextResponse } from 'next/server';

import { ImportDeleteError, deleteImportJob } from '@/lib/importDelete';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

export const DELETE = scopedRoute<{ jobId: string }>(async (req, { user, params }) => {
  const withQuestions = new URL(req.url).searchParams.get('withQuestions') === '1';
  try {
    const result = await deleteImportJob(params.jobId, user, { withQuestions });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ImportDeleteError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
});
