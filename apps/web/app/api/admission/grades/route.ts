/**
 * 級分記錄的輸入與讀取，以及**現算**的六科預測。
 *
 * # 為什麼收的是模考成績單上的級分，而不是從作答記錄反推
 *
 * 因為那是直接觀測值。從我們自己的作答記錄反推級分要跨兩道換算
 * （原始分 → 難度校正 → 級距），每一道都放大誤差，而級距在校內人數
 * 不足時本身就不可靠（文件 A.2）。學生手上那張南模成績單上印的就是
 * 級分，誤差是零。
 *
 * # GET 為什麼順便回預測，而 POST 為什麼不落地
 *
 * 回預測是因為學生輸入一筆之後最想知道的就是「那我現在的區間是多少」，
 * 讓畫面不必再打一次。
 *
 * **不落地**是因為讀一頁不該產生寫入，而且落地的目的是校準——
 * 每次讀都寫一列的話，`GradePrediction` 會塞滿同一個預測的幾百份複本，
 * 於是校準曲線的每一筆權重變成「這位學生重整了幾次頁面」。
 * 落地是 `POST /api/admission/predict` 那一個明確的動作。
 *
 * # 沒有 `?student=` 這種參數
 *
 * 與 `refs`、`profile` 同一個理由：RLS 擋得住別家補習班，擋不住隔壁
 * 同學。而級分是同班同學最想看的東西之一。老師代為輸入的路徑（
 * `enteredBy` 那一欄是為它留的）還沒做，做的時候要走另一支帶班級檢查
 * 的路由，不是在這裡加一個參數。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  GRADE_SOURCES,
  PredictError,
  addGradeRecord,
  predictTargetOf,
  predictionsFor,
} from '@/lib/predictDb';
import { scopedRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

const SOURCES = GRADE_SOURCES.map((s) => s.value) as [string, ...string[]];

const Body = z.object({
  subjectCode: z.string().trim().min(1).max(40),
  examName: z.string().trim().min(1).max(80),
  examDate: z.string().min(4),
  /** 級分 0 至 15。**不是分數**——資料庫也有 CHECK 擋這件事。 */
  grade: z.number().int().min(0).max(15),
  percentile: z.number().min(0).max(100).nullish(),
  source: z.enum(SOURCES),
  note: z.string().trim().max(300).nullish(),
});

const STUDENT_ONLY = '級分記錄由學生本人輸入（成績單在他手上）。';

export const GET = scopedRoute(async (req: NextRequest, { user }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json({ error: STUDENT_ONLY }, { status: 403 });
  }
  const url = new URL(req.url);
  // 預測的目標是**下一場還沒考的學測**（見 lib/predictDb.ts 的
  // predictTargetOf）。用學年度的話，1 月到 7 月之間這一支回的是對著
  // 一場已經考完的考試算出來的區間。
  const year = Number(url.searchParams.get('year')) || predictTargetOf().targetYear;
  const confidence = Number(url.searchParams.get('confidence'));
  return NextResponse.json(
    await predictionsFor(user.id, year, Number.isFinite(confidence) ? confidence : undefined),
  );
});

export const POST = scopedRoute(async (req: NextRequest, { user }) => {
  if (user.systemRole !== 'STUDENT') {
    return NextResponse.json({ error: STUDENT_ONLY }, { status: 403 });
  }

  const parsed = Body.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    // 訊息要說得出缺哪一欄。「參數不正確」在一張有六個欄位的表單上等於
    // 什麼都沒說，而使用者的下一步是把每一欄都重填一次。
    const first = parsed.error.issues[0];
    const where = first?.path.join('.') || '';
    const NAMES: Record<string, string> = {
      subjectCode: '科目',
      examName: '考試名稱',
      examDate: '考試日期',
      grade: '級分',
      source: '這是哪一種考試',
      percentile: '百分位',
    };
    return NextResponse.json(
      {
        error:
          where === 'grade'
            ? '「級分」要是 0 到 15 的整數。這一欄填的是級分不是分數——' +
              '填成百分制的話，整條趨勢與所有下游的落點計算都會失去意義。'
            : where
              ? `「${NAMES[where] ?? where}」這一欄不正確或沒有填。`
              : '參數不正確',
      },
      { status: 400 },
    );
  }

  let backfilled = 0;
  let afterExam = 0;
  try {
    const out = await addGradeRecord(user.id, parsed.data, user);
    backfilled = out.backfilled;
    afterExam = out.afterExam;
  } catch (e) {
    if (e instanceof PredictError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const year = predictTargetOf().targetYear;
  return NextResponse.json({
    ...(await predictionsFor(user.id, year)),
    /**
     * 剛剛回填了幾份預測的實際成績。輸入真正的學測級分時才不是 0，
     * 而畫面要說出來——那一步是校準曲線唯一的資料來源，學生不知道
     * 自己剛剛做了一件對整個機構有用的事。
     */
    backfilled,
    /**
     * 考試之後才存下來的預測有幾份。**這幾份刻意不回填**——它們把正式
     * 成績當成輸入，必然命中，進了校準曲線就等於在自己給自己打分數。
     * 數字要回給畫面，否則學生會以為系統漏掉了幾份。
     */
    afterExam,
  });
});
