'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { SelectField, TextField } from '@/components/Field';
import { Form, submitJson } from '@/components/Form';

export default function NewClass({
  years,
}: {
  years: { id: string; name: string; isCurrent: boolean }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [yearId, setYearId] = useState(
    years.find((y) => y.isCurrent)?.id ?? years[0]?.id ?? '',
  );

  if (!open) {
    return (
      <div style={{ marginBottom: 20 }}>
        <Button variant="primary" onClick={() => setOpen(true)}>
          開一個新班
        </Button>
      </div>
    );
  }

  return (
    <div className="yz-card" style={{ marginBottom: 22 }}>
      <Form
        onSubmit={async () => {
          const r = await submitJson<{ class: { id: string } }>('/api/classes', {
            json: { academicYearId: yearId, name },
          });
          router.push(`/classes/${r.class.id}`);
        }}
      >
        {({ busy }) => (
          <>
            <div className="yz-row">
              <TextField
                label="班級名稱"
                required
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                hint="學生在自己的畫面上會看到這個名稱。"
                autoFocus
              />
              <SelectField
                label="學年度"
                value={yearId}
                onChange={(e) => setYearId(e.currentTarget.value)}
              >
                {years.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.name}
                    {y.isCurrent ? '（當前）' : ''}
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
                建立
              </Button>
            </div>
          </>
        )}
      </Form>
    </div>
  );
}
