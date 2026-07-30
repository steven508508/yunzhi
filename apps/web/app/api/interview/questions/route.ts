/**
 * 面試題庫。
 *
 * 第一次有人進到這一頁時，把 `lib/interview.mjs` 的內建範本匯入成
 * `InterviewQuestion`。**匯入而不是寫死**，因為各校系的問法會變，
 * 而寫死的題庫老師改不動；匯入只做一次（以租戶內有沒有題目判斷），
 * 所以老師刪掉的題目不會被還原——他刪掉是因為他不要那一題。
 */
import { NextRequest, NextResponse } from 'next/server';

import { interviewQuestions, portfolioFailure } from '@/lib/portfolioDb';
import { FIELD_TAGS } from '@/lib/interview.mjs';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  try {
    const url = new URL(req.url);
    const fieldTag = url.searchParams.get('fieldTag') ?? undefined;
    return NextResponse.json({
      fieldTags: FIELD_TAGS,
      questions: await interviewQuestions(user, fieldTag),
    });
  } catch (e) {
    const { status, body } = portfolioFailure(e);
    return NextResponse.json(body, { status });
  }
});
