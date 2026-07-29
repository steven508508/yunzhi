'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { SelectField, TextField } from '@/components/Field';
import { Form, submitJson } from '@/components/Form';

export default function NewPaper({ subjects }: { subjects: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
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
            json: { subjectId, title },
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
