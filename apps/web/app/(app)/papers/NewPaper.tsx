'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { SelectField, TextAreaField, TextField } from '@/components/Field';
import { Form, submitJson } from '@/components/Form';

export default function NewPaper({ subjects }: { subjects: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? '');

  if (!open) {
    return (
      <div style={{ marginBottom: 20 }}>
        <Button variant="primary" onClick={() => setOpen(true)}>
          建一份新卷子
        </Button>
      </div>
    );
  }

  return (
    <div className="yz-card" style={{ marginBottom: 22 }}>
      <Form
        onSubmit={async () => {
          const r = await submitJson<{ paper: { id: string } }>('/api/papers', {
            json: { subjectId, title, instructions },
          });
          // 建完直接進編輯畫面。建一份空卷子本身沒有意義，
          // 下一步一定是挑題。
          router.push(`/papers/${r.paper.id}`);
        }}
      >
        {({ busy }) => (
          <>
            <div className="yz-row">
              <TextField
                label="卷名"
                required
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
                hint="學生在作答畫面最上方看到的就是它。例如「第一次段考 數學A」。"
                autoFocus
              />
              <SelectField
                label="科目"
                value={subjectId}
                onChange={(e) => setSubjectId(e.currentTarget.value)}
                hint="科目建立之後不能改——已經挑進來的題目會對不上。"
              >
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </SelectField>
            </div>
            {/* 這一欄印在考卷與作答畫面最上方。在此之前 schema、lib 與 API
                一路都收，只是沒有任何地方填得進去——於是「不可使用計算機」
                這種話只能口頭講，而分兩個時段考的兩班不一定聽到同一句。
                現在留白也沒關係，之後在「編輯卷頭」還補得回來。 */}
            <TextAreaField
              label="考試說明（可留白）"
              value={instructions}
              onChange={(e) => setInstructions(e.currentTarget.value)}
              rows={3}
              hint="印在考卷與作答畫面最上方。例如「本卷共 25 題，第 1–20 題單選、第 21–25 題選填，不可使用計算機」。"
            />
            <div className="yz-actions">
              <span className="yz-actions__spacer" />
              <Button variant="quiet" onClick={() => setOpen(false)} disabled={busy}>
                取消
              </Button>
              <Button type="submit" variant="primary" busy={busy} busyLabel="建立中…">
                建立並開始挑題
              </Button>
            </div>
          </>
        )}
      </Form>
    </div>
  );
}
