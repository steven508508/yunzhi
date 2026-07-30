/**
 * 素材的新增、修改、刪除，以及「為哪些校系勾選」。
 *
 * # 為什麼容量在這裡就要說
 *
 * 因為上限是**中央資料庫端的**，不是本系統的——在這裡上傳成功不代表
 * 送得上去。等到送出前的確認清單才說的話，他手上可能只剩那一份檔案，
 * 重做來不及。所以每一件旁邊都印著它的大小，超過的直接標紅。
 *
 * 這裡不做真的檔案上傳（storageKey 留給後續批次），先收檔名與大小——
 * 而**大小這一欄的價值在於它現在就擋得住**，這比檔案存在哪裡重要。
 *
 * # 為什麼沒有「一鍵全選」
 *
 * 因為個人申請階段的勾選是逐校系至多 3 件課程學習成果，而「全選」的
 * 結果一定超過。做一顆會讓每個人都違規的按鈕，然後再用紅字告訴他違規，
 * 是把系統的方便換成他的焦慮。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { SelectField, TextField } from '@/components/Field';
import { submitJson, useAction } from '@/components/Form';
import { Note } from '@/components/Feedback';

type Item = {
  id: string;
  category: string;
  itemCode: string;
  itemLabel: string | null;
  title: string;
  semester: string | null;
  fileName: string | null;
  fileBytes: number | null;
  fileKind: string | null;
  abilityTags: string[];
  selectedFor: string[];
  note: string | null;
  sizeIssue: string | null;
};

type Code = { code: string; label: string; category: string };

const SEMESTERS = ['高一上', '高一下', '高二上', '高二下', '高三上', '高三下'];

const mb = (b: number | null) => (b ? `${(b / 1024 / 1024).toFixed(1)}MB` : '');

export default function ItemEditor({
  items,
  codes,
  docMB,
  mediaMB,
  programRefs,
}: {
  items: Item[];
  codes: Code[];
  docMB: number;
  mediaMB: number;
  programRefs: string[];
}) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [itemCode, setItemCode] = useState(codes[0]?.code ?? 'B');
  const [title, setTitle] = useState('');
  const [semester, setSemester] = useState('高二上');
  const [fileName, setFileName] = useState('');
  const [fileMB, setFileMB] = useState('');
  const [fileKind, setFileKind] = useState('DOC');
  const [tags, setTags] = useState('');
  const [newProgram, setNewProgram] = useState('');

  const chosen = codes.find((c) => c.code === itemCode);

  const add = () =>
    run(async () => {
      await submitJson('/api/portfolio/items', {
        json: {
          category: chosen?.category ?? 'DIVERSE_PERFORMANCE',
          itemCode,
          title,
          semester,
          fileName: fileName || null,
          fileBytes: fileMB ? Math.round(Number(fileMB) * 1024 * 1024) : null,
          fileKind: fileName ? fileKind : null,
          abilityTags: tags
            .split(/[、,，\s]+/)
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 12),
        },
      });
      setTitle('');
      setFileName('');
      setFileMB('');
      setTags('');
      setOpen(false);
      router.refresh();
    });

  const patch = (id: string, body: Record<string, unknown>) =>
    run(async () => {
      await submitJson(`/api/portfolio/items/${id}`, { method: 'PATCH', json: body });
      router.refresh();
    });

  const remove = (id: string) =>
    run(async () => {
      await submitJson(`/api/portfolio/items/${id}`, { method: 'DELETE' });
      router.refresh();
    });

  const toggleProgram = (it: Item, ref: string) => {
    const next = it.selectedFor.includes(ref)
      ? it.selectedFor.filter((r) => r !== ref)
      : [...it.selectedFor, ref];
    return patch(it.id, { selectedFor: next });
  };

  return (
    <section>
      <h2 className="yz-card__title" style={{ marginTop: 26 }}>
        素材（{items.length}）
      </h2>

      {error && <Note tone="error">{error}</Note>}

      <ul className="yz-pf__items">
        {items.map((it) => (
          <li key={it.id} className="yz-pf__item">
            <div className="yz-pf__itemhead">
              <span className="yz-pf__code">{it.itemCode}</span>
              <strong className="yz-pf__title">{it.title}</strong>
              <span className="yz-pf__meta">
                {it.semester ?? '沒有標學期'}
                {it.itemLabel ? `　${it.itemLabel}` : ''}
                {it.fileName ? `　${it.fileName}（${mb(it.fileBytes)}）` : ''}
              </span>
              <Button variant="quiet" busy={busy} onClick={() => remove(it.id)}>
                移除
              </Button>
            </div>

            {it.sizeIssue && <Note tone="error">{it.sizeIssue}</Note>}

            {it.abilityTags.length > 0 && (
              <p className="yz-pf__tags">
                {it.abilityTags.map((t) => (
                  <span key={t} className="yz-chip">
                    {t}
                  </span>
                ))}
              </p>
            )}

            {programRefs.length > 0 && (
              <p className="yz-pf__pick">
                <span className="yz-pf__picklabel">為哪些校系勾選</span>
                {programRefs.map((ref) => (
                  <button
                    key={ref}
                    type="button"
                    disabled={busy}
                    className={`yz-chip${it.selectedFor.includes(ref) ? ' yz-chip--on' : ''}`}
                    onClick={() => toggleProgram(it, ref)}
                  >
                    {ref}
                  </button>
                ))}
              </p>
            )}
          </li>
        ))}
      </ul>

      {/*
        新增一個校系代號。個申階段的件數上限是**逐校系**算的，所以
        校系要先存在，那幾顆勾選的按鈕才有東西可以勾。
      */}
      <div className="yz-pf__addprog">
        <TextField
          label="加一個校系（填代碼或你自己看得懂的簡稱）"
          hint="個人申請的勾選上限是逐校系算的，所以要先有校系才勾得了。"
          value={newProgram}
          onChange={(e) => setNewProgram(e.target.value)}
        />
        <Button
          busy={busy}
          disabled={!newProgram.trim() || items.length === 0}
          onClick={() => {
            const ref = newProgram.trim();
            setNewProgram('');
            // 掛在第一件上，讓這個校系出現在下面每一件的勾選列裡；
            // 之後他自己再逐件勾。**用 add 而不是 toggle**：打了一個
            // 已經存在的代碼時，toggle 會把它從第一件上拿掉，而畫面上
            // 看起來像是「加了之後少了一個勾」。
            return patch(items[0].id, {
              selectedFor: [...new Set([...items[0].selectedFor, ref])],
            });
          }}
        >
          加校系
        </Button>
      </div>

      {open ? (
        // 不用 `<Form>` 包：那個元件自己管 busy 與錯誤，而這一整段的
        // 錯誤已經由 `useAction()` 統一顯示在上面（新增與逐件的修改
        // 共用同一個錯誤區）。包起來的話，同一個畫面會有兩個地方
        // 冒出錯誤訊息，而學生只會看到其中一個。
        <div className="yz-pf__form">
          <SelectField
            label="這是哪一類"
            required
            value={itemCode}
            onChange={(e) => setItemCode(e.target.value)}
          >
            {codes.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}　{c.label}
              </option>
            ))}
          </SelectField>

          {itemCode === 'N' && (
            <Note tone="info">
              綜整心得有 800 字加 3 張圖的明文限制，<strong>但它不計入 10 件多元表現的額度</strong>。
              內容在「自述與心得」那一頁寫，這裡只是登記你有這一件。
            </Note>
          )}

          <TextField
            label="標題"
            required
            hint="寫得具體一點。三個月後你要從十幾件裡認出這一件。"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <SelectField
            label="哪一個學期"
            hint="件數上限是逐學年算的，所以這一欄會影響你還剩幾件。"
            value={semester}
            onChange={(e) => setSemester(e.target.value)}
          >
            {SEMESTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </SelectField>

          <TextField
            label="檔名（選填）"
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
          />
          <TextField
            label="檔案大小（MB，選填）"
            hint={`中央資料庫的上限是文件 ${docMB}MB、影音 ${mediaMB}MB。填了就現在擋，不要等到送出前才發現。`}
            inputMode="decimal"
            value={fileMB}
            onChange={(e) => setFileMB(e.target.value)}
          />
          <SelectField
            label="文件還是影音"
            value={fileKind}
            onChange={(e) => setFileKind(e.target.value)}
          >
            <option value="DOC">文件（PDF）</option>
            <option value="MEDIA">影音</option>
          </SelectField>

          <TextField
            label="這一件呈現了什麼能力（選填，用頓號分隔）"
            hint="選件討論會用它來看「這幾件呈現的是不是同一種能力」。"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />

          <div className="yz-actions">
            <Button variant="primary" busy={busy} disabled={!title.trim()} onClick={add}>
              加進來
            </Button>
            <Button variant="quiet" onClick={() => setOpen(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="primary" onClick={() => setOpen(true)}>
          加一件素材
        </Button>
      )}
    </section>
  );
}
