/**
 * 重建這個班的能力快照。
 *
 * # 為什麼這顆按鈕要在畫面上，而不是只留一支腳本
 *
 * 因為需要它的那一刻，正是「這一頁看起來壞掉了」的那一刻：老師剛把
 * 題目標上知識點，回到這一頁，看到的還是「還沒有資料」——因為快照
 * 是在計分時算的，而那些學生近期不會再被計分一次。
 *
 * 沒有這顆按鈕的話，唯一的解法是找得到伺服器、找得到租戶 id、
 * 而且會用指令列的人。那個人在補習班裡通常不存在。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';

export default function Rebuild({
  classId,
  className,
  students,
}: {
  classId: string;
  className: string;
  students: number;
}) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [done, setDone] = useState<{ users: number; points: number } | null>(null);

  return (
    <div className="yz-ability__rebuild">
      {error && <Note tone="error">{error}</Note>}
      <Button
        variant="quiet"
        busy={busy}
        busyLabel={`重算中（${students} 位學生）…`}
        onClick={() =>
          run(async () => {
            const r = await submitJson<{ users: number; points: number }>(
              '/api/ability/rebuild',
              { json: { classId } },
            );
            setDone({ users: r.users, points: r.points });
            router.refresh();
          })
        }
      >
        重建快照
      </Button>
      <span className="yz-hint">
        {done
          ? `重算完成：${done.users} 位學生、${done.points} 個知識點。`
          : `從「${className}」每一位學生的既有作答重算一次。` +
            `剛把題目標上知識點、或剛升級完的時候要按一次；平常計分完會自動更新。`}
      </span>
    </div>
  );
}
