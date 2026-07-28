#!/usr/bin/env python3
"""
接上真金鑰之後的實跑驗證。

# 這支腳本存在的理由

到目前為止，匯入管線的每一項測試都是 mock 或固定回覆。驗過的是
「材料進到模型之前」與「模型回來之後」那兩段——形狀、守門、
完整性檢查。**唯獨模型自己填得多準，一次都沒有量過。**

開發路線圖（文件 05）把這件事排在「階段 -1，正式開發之前的兩週」，
理由是「如果數學式辨識率遠低於預期，整個匯入模組的設計可能需要
改變」。那兩週沒有發生——因為沒有金鑰——而我們已經在未驗證的
假設上蓋了八人週的東西。

**這支腳本是把那兩週補回來的最小版本。** 它不寫進系統、不入庫、
不改任何資料，只做一件事：拿真實講義跑真實模型，然後印出幾個數字。

# 怎麼用

    export AI_PROVIDER=anthropic
    export AI_API_KEY=sk-ant-...          # 不會被印出來也不會寫進報告
    python3 tools/verify-ai.py --pages 6

預設只跑每份講義的前 6 頁。**先跑少的**——第一次跑完先看數字合不合
理，再決定要不要花錢跑整份。每一頁的成本會即時印出來。

金鑰請放在 .env（chmod 600）或當次的環境變數，不要寫進任何檔案。
這支腳本從頭到尾不會印出金鑰，報告裡也不會有。

# 它量什麼，以及為什麼是這幾個

  1. 每頁抽到幾題、跨頁合併之後總共幾題
        —— 對照人工數的題數。少了就是漏題，那是最嚴重的一種錯。
  2. stats.unsupported（格式吃不下的東西）
        —— 若很多，代表格式還缺型別，**而那正是我們想知道的**。
  3. stats.mean_confidence（模型自己覺得讀得多有把握）
        —— 配合下一項看：信心高而錯得多，比信心低更危險。
  4. ERROR 級 issue 的分布
        —— figure_missing、duplicate_options、answer_count_mismatch。
           這三個是「入庫之後學生會被判錯」那一類。
  5. 交叉驗證的不一致數
        —— 規則路徑與模型看法不同的地方。物理與化學那兩份沒有
           可用文字層，所以這一項會是 0，那是預期的。
  6. token 與時間
        —— 每頁成本、每份成本、外推到一萬題題庫的一次性成本。
           文件 05 估每頁 3.5k–5.5k token，這裡驗它準不準。

# 它不量什麼

**AI 自答的正確率**（文件 05 階段 -1 的第二項）需要一批已知答案的
題目當標準答案，而手上兩份講義都是學用版，答案沒有印出來。
要驗那一項，請給我一份**教用版**或一份有官方答案的歷屆試題。

**非選題評分與人工評分的相關性**（第三項）需要一批老師已經評過分
的答卷。同理，有材料才驗得了。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "ai"))

DEFAULT_SAMPLES = Path(os.getenv("WORKSHEET_SAMPLE_DIR", "/home/claude/samples"))

#: 對外報價會變，所以不寫死金額——只印 token，讓你用當期價格自己乘。
#: 寫死一個過期的數字比不寫還糟。
NOTE_PRICING = "成本請用當期定價自行換算；本報告只給 token 量。"


def _fail(msg: str) -> None:
    print(f"\n✗ {msg}\n", file=sys.stderr)
    raise SystemExit(1)


def _check_key() -> str:
    provider = (os.getenv("AI_PROVIDER") or "").strip().lower()
    if provider in ("", "mock"):
        _fail(
            "AI_PROVIDER 是 mock 或沒設。這支腳本就是要打真的 API——\n"
            "  用 mock 跑出來的數字沒有意義，而那正是現在的處境。\n\n"
            "  export AI_PROVIDER=anthropic\n"
            "  export AI_API_KEY=...（不會被印出來）"
        )
    if not (os.getenv("AI_API_KEY") or "").strip():
        _fail(f"AI_PROVIDER={provider} 但 AI_API_KEY 是空的。")
    return provider


async def run_one(path: Path, max_pages: int, tier: str) -> dict:
    """跑一份講義，回傳量測結果。不入庫、不改任何資料。"""
    from pipeline import canonical
    from pipeline.normalize import normalize_pdf
    from pipeline.reading import cross_check, prepare_image, read_page
    from providers import build_provider

    print(f"\n{'═' * 66}\n{path.name}\n{'═' * 66}")

    t0 = time.time()
    norm = normalize_pdf(path.read_bytes())
    t_norm = time.time() - t0
    pages = norm.pages[:max_pages]
    print(f"  前處理 {t_norm:5.1f}s ｜ {norm.kind} ｜ 共 {len(norm.pages)} 頁，本次跑前 {len(pages)} 頁")
    print(f"  {norm.quality_note}")

    provider = build_provider(os.environ)
    readings: list[tuple[int, object]] = []
    usage_in = usage_out = calls = 0
    t_read = 0.0

    for i, page in enumerate(pages):
        nxt = prepare_image(pages[i + 1].png, 1568) if i + 1 < len(pages) else None
        img = prepare_image(page.png, 1568)
        t = time.time()
        try:
            reading, usage = await read_page(
                provider,
                page_index=i + 1,
                image=img,
                next_image=nxt,
                text_blocks=page.text_blocks or None,
                tier=tier,
            )
        except Exception as e:  # noqa: BLE001
            # 一頁失敗不該讓整份驗證白跑——那可能是最貴的一次。
            print(f"  第 {i + 1:>2} 頁 ✗ {type(e).__name__}: {e}")
            continue
        dt = time.time() - t
        t_read += dt
        readings.append((i + 1, reading))
        usage_in += int(usage.get("input_tokens", 0))
        usage_out += int(usage.get("output_tokens", 0))
        calls += 1
        print(
            f"  第 {i + 1:>2} 頁 {dt:5.1f}s ｜ 題 {len(reading.questions):>2}"
            f" 圖 {len(reading.assets):>2} 教材 {len(reading.materials):>2}"
            f" 問題 {len(reading.issues):>2}"
            f" ｜ token 進 {usage.get('input_tokens', 0):>6} 出 {usage.get('output_tokens', 0):>5}"
        )

    if not readings:
        return {"file": path.name, "pages": 0, "error": "沒有任何一頁讀成功"}

    doc = canonical.assemble(readings, source_file=path.name, page_count=len(norm.pages))

    by_code: dict[str, int] = {}
    errors: dict[str, int] = {}
    for issue in doc.issues:
        by_code[issue.code] = by_code.get(issue.code, 0) + 1
        if issue.severity is canonical.Severity.ERROR:
            errors[issue.code] = errors.get(issue.code, 0) + 1

    # 交叉驗證：只有拿得到文字層的那幾份跑得動。
    disagreements = 0
    for page_no, reading in readings:
        src = pages[page_no - 1]
        if not src.text_blocks:
            continue
        disagreements += len(
            cross_check([q.model_dump() for q in reading.questions], src.text_blocks)
        )

    per_page = (usage_in + usage_out) / max(1, calls)
    return {
        "file": path.name,
        "kind": norm.kind,
        "pages_total": len(norm.pages),
        "pages_read": calls,
        "questions": doc.stats.questions,
        "with_printed_answer": doc.stats.with_printed_answer,
        "with_assets": doc.stats.with_assets,
        "materials": doc.stats.materials,
        "groups": doc.stats.groups,
        "unsupported": doc.stats.unsupported,
        "mean_confidence": doc.stats.mean_confidence,
        "issues": by_code,
        "errors": errors,
        "disagreements": disagreements,
        "tokens_in": usage_in,
        "tokens_out": usage_out,
        "tokens_per_page": round(per_page),
        "seconds_read": round(t_read, 1),
        "seconds_per_page": round(t_read / max(1, calls), 1),
        "document": doc,
    }


def report(results: list[dict], out: Path) -> None:
    lines: list[str] = []

    def w(s: str = "") -> None:
        lines.append(s)

    w("# AI 實跑驗證報告")
    w()
    w(f"> 產生時間：{time.strftime('%Y-%m-%d %H:%M')}　｜　{NOTE_PRICING}")
    w("> 本報告不含任何金鑰資訊。")
    w()

    ok = [r for r in results if not r.get("error")]
    if not ok:
        w("**全部失敗。** 詳見終端機輸出。")
        out.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return

    w("## 一、一眼看完")
    w()
    w("| 檔案 | 頁 | 題 | 印了答案 | 有圖 | 吃不下 | 平均信心 | ERROR | token/頁 | 秒/頁 |")
    w("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|")
    for r in ok:
        w(
            f"| {r['file'][:26]} | {r['pages_read']} | {r['questions']} "
            f"| {r['with_printed_answer']} | {r['with_assets']} | {r['unsupported']} "
            f"| {r['mean_confidence']:.2f} | {sum(r['errors'].values())} "
            f"| {r['tokens_per_page']:,} | {r['seconds_per_page']} |"
        )
    w()

    total_tok = sum(r["tokens_in"] + r["tokens_out"] for r in ok)
    total_pages = sum(r["pages_read"] for r in ok)
    per_page = total_tok / max(1, total_pages)
    w(f"合計 {total_pages} 頁、{total_tok:,} token，平均每頁 **{per_page:,.0f}**。")
    w()
    w(f"文件 05 估每頁 3.5k–5.5k。實測 {per_page:,.0f}"
      f"{'，在估計範圍內' if 3500 <= per_page <= 5500 else '，**與估計不符，成本模型要重算**'}。")
    w()
    w("外推：一份 20 頁的題本約 "
      f"{per_page * 20:,.0f} token；200 份（約一萬題）的解析階段約 "
      f"{per_page * 20 * 200 / 1_000_000:,.1f}M token。")
    w()

    w("## 二、每一份的細節")
    for r in ok:
        w()
        w(f"### {r['file']}")
        w()
        w(f"- 來源型態：`{r['kind']}`　全書 {r['pages_total']} 頁，本次讀 {r['pages_read']} 頁")
        w(f"- 抽到 {r['questions']} 題、{r['groups']} 個題組、{r['materials']} 段教材、"
          f"{r['with_assets']} 題帶圖")
        w(f"- 平均信心 {r['mean_confidence']:.3f}")
        w(f"- 交叉驗證不一致：{r['disagreements']}"
          f"{'（此份無可用文字層，0 是預期的）' if r['kind'] != 'native_pdf' else ''}")
        if r["issues"]:
            w()
            w("| 問題 | 次數 | 嚴重 |")
            w("|---|--:|:--:|")
            for code, n in sorted(r["issues"].items(), key=lambda kv: -kv[1]):
                w(f"| `{code}` | {n} | {'✗ ERROR' if code in r['errors'] else ''} |")
        else:
            w()
            w("沒有任何 issue。**這件事本身要存疑**——真實講義通常至少有幾筆，")
            w("完全乾淨比較可能是模型沒有在回報，而不是它什麼都讀對了。")

    w()
    w("## 三、這些數字該怎麼讀")
    w()
    w("**題數**要跟人工數的對。少了就是漏題——漏題是最嚴重的一種錯，"
      "因為它不會出現在任何錯誤訊息裡，只是那一題從此不存在。")
    w()
    w("**吃不下的東西（unsupported）多不是壞事。** 那代表格式還缺型別，"
      "而系統誠實地把它標出來而不是硬塞。歸零反而要懷疑模型有沒有在回報。")
    w()
    w("**信心高而錯得多，比信心低危險。** 校對介面是依信心排序的，"
      "高信心的題目老師會略過。所以要看的不是平均信心，"
      "而是「高信心那一批裡的錯誤率」——那要人工抽驗，這支腳本量不到。")
    w()
    w("**ERROR 級的三個 code** 是「入庫之後學生會被判錯」那一類："
      "`figure_missing`（題幹說如圖但圖沒接上）、"
      "`duplicate_options`（兩個選項一模一樣，沒有唯一解）、"
      "`answer_count_mismatch`（原稿說應選 3 項而答案只有 2 個）。"
      "這三個現在會擋在入庫之外，所以它們的數量代表「有多少題需要老師回頭看原稿」。")
    w()
    w("## 四、這支腳本量不到、但上線前一定要量的")
    w()
    w("**AI 自答的正確率。** 需要一批已知答案的題目。手上兩份講義都是"
      "學用版，答案沒印。給一份**教用版**或有官方答案的歷屆試題就能驗。")
    w()
    w("**高信心題目中的錯誤率。** 需要人工抽驗 30–50 題並逐題核對。"
      "這是決定「老師能不能放心略過高信心題」的唯一依據，"
      "而校對工時（50 題 20 分鐘）成不成立就取決於它。")
    w()
    w("**非選題評分與人工評分的相關性。** 需要一批老師已評過分的答卷。")

    out.write_text("\n".join(lines) + "\n", encoding="utf-8")


async def main() -> int:
    ap = argparse.ArgumentParser(description="接上真金鑰之後的實跑驗證")
    ap.add_argument("files", nargs="*", type=Path, help="要跑的 PDF；省略則掃 samples 目錄")
    ap.add_argument("--pages", type=int, default=6, help="每份最多跑幾頁（預設 6，先跑少的）")
    ap.add_argument("--tier", default="MID", choices=["LIGHT", "MID", "HIGH"])
    ap.add_argument("--out", type=Path, default=ROOT / "ai-verification-report.md")
    ap.add_argument("--json", type=Path, help="另外把完整的 QIF 文件寫成 JSON")
    args = ap.parse_args()

    provider = _check_key()

    files = args.files or sorted(DEFAULT_SAMPLES.glob("*.pdf"))
    if not files:
        _fail(f"找不到任何 PDF。給檔名，或把講義放進 {DEFAULT_SAMPLES}。")
    missing = [f for f in files if not f.exists()]
    if missing:
        _fail(f"找不到：{', '.join(str(m) for m in missing)}")

    print(f"provider={provider}　tier={args.tier}　每份最多 {args.pages} 頁")
    print("**這會真的花錢。** 每一頁的用量會即時印出來，覺得不對就 Ctrl-C。")

    results = []
    for f in files:
        try:
            results.append(await run_one(f, args.pages, args.tier))
        except KeyboardInterrupt:
            print("\n已中止。已完成的部分仍會寫進報告。")
            break
        except Exception as e:  # noqa: BLE001
            print(f"\n✗ {f.name}：{type(e).__name__}: {e}")
            results.append({"file": f.name, "error": str(e)})

    if args.json:
        payload = {
            r["file"]: json.loads(r["document"].model_dump_json())
            for r in results
            if r.get("document")
        }
        args.json.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\n完整 QIF 文件 → {args.json}")

    report(results, args.out)
    print(f"報告 → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
