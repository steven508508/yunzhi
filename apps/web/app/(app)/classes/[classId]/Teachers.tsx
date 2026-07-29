/**
 * 班級頁的「授課老師與導師」區塊。
 *
 * # 為什麼取消指派要用確認視窗，而指派不用
 *
 * 指派錯了畫面上立刻看得到（多了一列不該在的人），移除就好。
 *
 * 取消不是：那位老師從此看不到這個班這一科的成績、派不了卷、
 * 也改不了分數——而**他不會收到任何通知**。他下次打開成績頁看到的是
 * 一份空清單，而那與「還沒有人交卷」長得一模一樣。所以按下去之前
 * 要把後果講完整，不是問一句「確定嗎」。
 *
 * # 為什麼導師與科任老師分成兩塊而不是一張表
 *
 * 因為它們是兩種職權（見 lib/teaching.ts 的檔頭），而放在同一張表裡
 * 就一定要用一個欄位標示「這一列是哪一種」——而那個欄位會被讀成
 * 「導師是一種特別的科任老師」。實際上導師沒有任何一科的成績權，
 * 科任老師也改不了名冊。畫成兩塊，這件事不必解釋。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { SelectField } from '@/components/Field';
import { Empty, Note } from '@/components/Feedback';
import { submitJson, useAction } from '@/components/Form';
import { Table } from '@/components/Table';

export type TeacherRow = {
  id: string;
  subjectId: string;
  subjectName: string;
  subjectActive: boolean;
  userId: string;
  teacherName: string;
  teacherUsername: string;
  teacherActive: boolean;
  isPrimary: boolean;
};

export type HomeroomRow = {
  id: string;
  userId: string;
  teacherName: string;
  teacherUsername: string;
  teacherActive: boolean;
};

export type Candidate = { id: string; displayName: string; username: string };
export type SubjectOption = { id: string; name: string };

export default function Teachers({
  classId,
  className,
  subjects,
  candidates,
  teachers,
  homerooms,
}: {
  classId: string;
  className: string;
  subjects: SubjectOption[];
  candidates: Candidate[];
  teachers: TeacherRow[];
  homerooms: HomeroomRow[];
}) {
  const router = useRouter();
  const [subjectId, setSubjectId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [homeroomId, setHomeroomId] = useState('');
  const [dropping, setDropping] = useState<TeacherRow | null>(null);
  const [droppingHomeroom, setDroppingHomeroom] = useState<HomeroomRow | null>(null);
  const add = useAction();
  const drop = useAction();

  const noStaff = candidates.length === 0;

  async function assign() {
    if (!subjectId || !teacherId) return;
    const ok = await add.run(async () => {
      await submitJson(`/api/classes/${classId}/teachers`, {
        json: { subjectId, userId: teacherId },
      });
    });
    if (ok) {
      setTeacherId('');
      router.refresh();
    }
  }

  async function assignHomeroom() {
    if (!homeroomId) return;
    const ok = await add.run(async () => {
      await submitJson(`/api/classes/${classId}/homeroom`, { json: { userId: homeroomId } });
    });
    if (ok) {
      setHomeroomId('');
      router.refresh();
    }
  }

  async function removeTeacher(row: TeacherRow) {
    const ok = await drop.run(async () => {
      const res = await fetch(
        `/api/classes/${classId}/teachers` +
          `?subject=${encodeURIComponent(row.subjectId)}&user=${encodeURIComponent(row.userId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error ?? '取消失敗');
      }
    });
    if (ok) {
      setDropping(null);
      router.refresh();
    }
  }

  async function removeHomeroom(row: HomeroomRow) {
    const ok = await drop.run(async () => {
      const res = await fetch(
        `/api/classes/${classId}/homeroom?user=${encodeURIComponent(row.userId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        throw new Error((await res.json().catch(() => null))?.error ?? '取消失敗');
      }
    });
    if (ok) {
      setDroppingHomeroom(null);
      router.refresh();
    }
  }

  return (
    <div className="yz-card" style={{ marginTop: 34, marginBottom: 22 }}>
      <h2 className="yz-card__title">授課老師與導師</h2>
      <p className="yz-hint" style={{ marginBottom: 14 }}>
        <b>沒有被指派的老師，這個班的每一頁對他都是空的</b>——
        成績查不到、卷子派不了、分數也改不動。而空畫面與「還沒有資料」看起來一樣，
        所以他多半不會來說自己沒有權限。
      </p>

      {noStaff && (
        <Note tone="warn">
          目前一個可以登入的教職員帳號都沒有，所以指派不了任何人。
          請先到「教職員」建立老師帳號。
        </Note>
      )}
      {add.error && <Note tone="error">{add.error}</Note>}
      {drop.error && !dropping && !droppingHomeroom && <Note tone="error">{drop.error}</Note>}

      {/* ── 科任老師 ───────────────────────────────────────── */}
      <Table
        caption={`${className}的授課老師`}
        columns={[
          {
            key: 's',
            head: '科目',
            cell: (t: TeacherRow) => (
              <>
                {t.subjectName}
                {!t.subjectActive && <span className="yz-warn">（科目已停用）</span>}
              </>
            ),
          },
          {
            key: 't',
            head: '老師',
            cell: (t: TeacherRow) => (
              <>
                {t.teacherName}
                <span className="yz-muted">{t.teacherUsername}</span>
                {!t.teacherActive && <span className="yz-warn">（帳號已停用）</span>}
              </>
            ),
          },
          {
            key: 'p',
            head: '職責',
            cell: (t: TeacherRow) =>
              t.isPrimary ? '主授' : <span className="yz-muted">協同</span>,
          },
          {
            key: 'x',
            head: <span className="yz-sr">操作</span>,
            cell: (t: TeacherRow) => (
              <span className="yz-rowacts" style={{ justifyContent: 'flex-end' }}>
                <Button variant="quiet" onClick={() => setDropping(t)} disabled={drop.busy}>
                  取消指派
                </Button>
              </span>
            ),
          },
        ]}
        rows={teachers}
        rowKey={(t) => t.id}
        empty={
          <Empty
            title="這個班還沒有授課老師"
            hint="一科可以有好幾位（主授與協同）。沒有指派的話，只有管理員看得到這個班的成績。"
          />
        }
      />

      <div className="yz-assign">
        <SelectField
          label="科目"
          value={subjectId}
          onChange={(e) => setSubjectId(e.currentTarget.value)}
          disabled={add.busy || noStaff}
        >
          <option value="">選擇科目…</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="老師"
          value={teacherId}
          onChange={(e) => setTeacherId(e.currentTarget.value)}
          disabled={add.busy || noStaff}
        >
          <option value="">選擇老師…</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName}（{c.username}）
            </option>
          ))}
        </SelectField>
        <Button
          onClick={() => void assign()}
          busy={add.busy}
          busyLabel="指派中…"
          disabled={!subjectId || !teacherId}
        >
          指派授課老師
        </Button>
      </div>

      {/* ── 導師 ───────────────────────────────────────────── */}
      <h3 className="yz-legend" style={{ marginTop: 26 }}>
        導師
      </h3>
      <p className="yz-hint" style={{ marginBottom: 12 }}>
        導師管的是班務，跨科目：<b>改名冊、匯入名冊、重設全班密碼、催繳</b>。
        他不會因此看得到各科的成績——那要另外指派授課老師。
      </p>

      <Table
        caption={`${className}的導師`}
        columns={[
          {
            key: 't',
            head: '導師',
            cell: (h: HomeroomRow) => (
              <>
                {h.teacherName}
                <span className="yz-muted">{h.teacherUsername}</span>
                {!h.teacherActive && <span className="yz-warn">（帳號已停用）</span>}
              </>
            ),
          },
          {
            key: 'x',
            head: <span className="yz-sr">操作</span>,
            cell: (h: HomeroomRow) => (
              <span className="yz-rowacts" style={{ justifyContent: 'flex-end' }}>
                <Button
                  variant="quiet"
                  onClick={() => setDroppingHomeroom(h)}
                  disabled={drop.busy}
                >
                  取消導師
                </Button>
              </span>
            ),
          },
        ]}
        rows={homerooms}
        rowKey={(h) => h.id}
        empty={
          <Empty
            title="這個班還沒有導師"
            hint="沒有導師的話，只有管理員改得動名冊、匯得了名冊、重設得了全班密碼。"
          />
        }
      />

      <div className="yz-assign">
        <SelectField
          label="要指派誰當導師"
          value={homeroomId}
          onChange={(e) => setHomeroomId(e.currentTarget.value)}
          disabled={add.busy || noStaff}
        >
          <option value="">選擇老師…</option>
          {/* 已經是導師的不再列出來——選了只會得到一句「他已經是了」。 */}
          {candidates
            .filter((c) => !homerooms.some((h) => h.userId === c.id))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}（{c.username}）
              </option>
            ))}
        </SelectField>
        <Button
          onClick={() => void assignHomeroom()}
          busy={add.busy}
          busyLabel="指派中…"
          disabled={!homeroomId}
        >
          指派為導師
        </Button>
      </div>

      {/* ── 取消的確認 ─────────────────────────────────────── */}
      <ConfirmDialog
        open={dropping !== null}
        onClose={() => {
          if (drop.busy) return;
          drop.clearError();
          setDropping(null);
        }}
        busy={drop.busy}
        title={
          dropping ? `取消「${dropping.teacherName}」的${dropping.subjectName}授課指派` : ''
        }
        confirmLabel="取消這筆指派"
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              取消之後，{dropping?.teacherName}
              <strong>看不到「{className}」的{dropping?.subjectName}成績</strong>，
              也<strong>派不了這一科的卷子給這個班</strong>，而且改不動這個班這一科的分數。
            </p>
            <p style={{ marginBottom: 12 }}>
              他<strong>不會收到任何通知</strong>。下次打開成績頁看到的是一份空清單，
              而那與「還沒有人交卷」長得一模一樣。要換人的話，請先把新的那位指派進來。
            </p>
            <p className="yz-hint">
              他過去改過的成績、出過的題目與派過的任務全部保留，這裡拿掉的只是往後的權限。
              隨時可以再指派回來。
            </p>
            {drop.error && <p className="yz-field__err">{drop.error}</p>}
          </>
        }
        onConfirm={() => dropping && void removeTeacher(dropping)}
      />

      <ConfirmDialog
        open={droppingHomeroom !== null}
        onClose={() => {
          if (drop.busy) return;
          drop.clearError();
          setDroppingHomeroom(null);
        }}
        busy={drop.busy}
        title={droppingHomeroom ? `取消「${droppingHomeroom.teacherName}」的導師身分` : ''}
        confirmLabel="取消導師身分"
        consequence={
          <>
            <p style={{ marginBottom: 12 }}>
              取消之後，{droppingHomeroom?.teacherName}
              <strong>改不動「{className}」的名冊</strong>（登錄家長同意、移出學生、重新入班）、
              <strong>匯不了名冊</strong>、也<strong>重設不了全班的密碼</strong>。
            </p>
            <p style={{ marginBottom: 12 }}>
              他同時會失去<strong>派卷給這個班</strong>的權限，除非他另外被指派為某一科的授課老師。
            </p>
            <p className="yz-hint">
              他不會收到通知。這個班過去的資料全部保留，隨時可以再指派回來。
            </p>
            {drop.error && <p className="yz-field__err">{drop.error}</p>}
          </>
        }
        onConfirm={() => droppingHomeroom && void removeHomeroom(droppingHomeroom)}
      />
    </div>
  );
}
