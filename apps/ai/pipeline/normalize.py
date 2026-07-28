"""
階段一：正規化

輸入可能是原生 PDF、掃描 PDF、DOCX、或手機照片，第一步是把它們
統一成「頁面影像 ＋ 可選的文字層」，讓下游只需要處理一種格式。

**四種來源的品質差異很大，而系統必須誠實面對這件事。**
老師說「每一種形式都要完美支援」，但實際上：

  原生 PDF   文字層準確率接近 100%，版面座標精確
  DOCX       轉 PDF 後同上
  掃描 PDF   看掃描品質，一般八成多
  手機照片   歪斜、陰影、摺痕都會吃掉準確率，做不到「完美」

所以這一階段除了轉檔，還要**評估品質並誠實回報**，讓校對介面
能對老師說「這份是照片，建議逐題確認」，而不是假裝三種都一樣好。
"""

from __future__ import annotations

import io
import logging
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import cv2
import fitz  # PyMuPDF
import numpy as np

log = logging.getLogger("yunzhi.ai.normalize")

#: 300 dpi 是 OCR 的實務甜蜜點。再高的解析度對辨識率幫助有限，
#: 但檔案大小與處理時間會線性成長——而網路是熱點分享的。
TARGET_DPI = 300
PDF_BASE_DPI = 72


SourceKind = Literal["native_pdf", "scanned_pdf", "image", "docx", "unknown"]


@dataclass
class PageOut:
    index: int
    width: int
    height: int
    png: bytes = field(repr=False)
    #: 原生 PDF 才有。它比 OCR 準確得多，但版面資訊要靠座標推斷。
    text_layer: str | None = None
    #: 原生 PDF 的文字區塊與座標（bbox 已正規化為 0–1 比例）。
    #: 有這個，版面切分就不必花錢問視覺模型——PDF 自己知道每個字
    #: 在哪裡，那是精確值，模型的估計不可能更準。
    text_blocks: list[dict] = field(default_factory=list)
    #: 本頁的品質評估，0–1
    quality: float = 1.0
    quality_notes: list[str] = field(default_factory=list)


@dataclass
class NormalizeResult:
    kind: SourceKind
    pages: list[PageOut]
    #: 整份檔案的品質。校對介面用它決定要不要提示「建議逐題確認」。
    quality: float
    quality_note: str
    has_text_layer: bool


# ─────────────────────────────────────────────────────────────────
# 判定來源型態
# ─────────────────────────────────────────────────────────────────


def sniff(data: bytes, filename: str = "") -> SourceKind:
    """
    以檔案內容而非副檔名判定型態。

    副檔名可以隨便改，而老師把 .jpg 改名成 .pdf 上傳這種事真的會發生。
    用魔術位元組判定才是可靠的。
    """
    if data[:4] == b"%PDF":
        return "native_pdf"  # 是否為掃描件由下方進一步判斷
    if data[:2] == b"\xff\xd8":
        return "image"  # JPEG
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image"
    if data[4:12] == b"ftypheic" or data[4:12] == b"ftypheix":
        return "image"  # HEIC，行動裝置預設格式
    if data[:2] == b"PK" and filename.lower().endswith((".docx", ".odt")):
        return "docx"
    return "unknown"


# ─────────────────────────────────────────────────────────────────
# PDF
# ─────────────────────────────────────────────────────────────────


#: 每平方英寸的字元數門檻。
#: 密排的題本頁面約 20–40，只有頁首頁尾的掃描件約 0.3–1。
#: 訂在 2.5 能區分兩者，同時容納排版稀疏的頁面（例如作文題那一頁
#: 只有一段引導文字，或只有一張圖的頁面）。
_CHARS_PER_SQIN = 2.5


def _page_has_real_text(page: fitz.Page) -> bool:
    """
    區分原生 PDF 與掃描 PDF。

    掃描件也可能有文字層（掃描軟體跑過 OCR），但那個文字層的品質
    通常不如我們自己跑——所以判準不是「有沒有文字」，而是
    「文字量是否與頁面尺寸相稱」。

    用「每平方英寸字元數」而非「面積覆蓋率」：後者對排版稀疏的頁面
    會誤判，而題本裡確實有那種頁面（作文題只有一段引導文字）。
    """
    text = page.get_text("text").strip()
    if len(text) < 40:
        return False

    # PDF 單位是 point，72 pt = 1 inch
    sq_inches = abs(page.rect.width * page.rect.height) / (72 * 72)
    if sq_inches <= 0:
        return False

    density = len(text) / sq_inches
    if density >= _CHARS_PER_SQIN:
        return True

    # 密度不足時退而看結構：有多個文字塊且分布在頁面各處，
    # 仍可能是排版稀疏的原生頁面（例如整頁一張圖加兩行說明）。
    blocks = page.get_text("blocks")
    if len(blocks) >= 3 and len(text) >= 120:
        return True
    return False


def _is_cjk(ch: str) -> bool:
    return bool(ch) and (
        "一" <= ch <= "鿿"  # 中日韓統一表意文字
        or "　" <= ch <= "〿"  # 中文標點
        or "＀" <= ch <= "￯"  # 全形字元
    )


def _unwrap(text: str) -> str:
    """
    把區塊內的換行接回一行。

    PDF 的文字區塊保留了排版的斷行，而斷行是版面的產物、不是內容的
    一部分。留著會讓下游的正則全部失準：「各題答對者，得 5 分」
    在 PDF 裡可能長成「各題答對者，得5\\n \\n分」，配分就抓不到了。

    接的時候中英文規則不同：中文斷行處不該補空格（補了會在句子
    中間出現一個突兀的空白），英文則必須補（不補會把兩個字黏成
    一個）。依斷行前後的字元決定。
    """
    lines = [ln.strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln]
    if not lines:
        return ""

    out = lines[0]
    for ln in lines[1:]:
        joiner = "" if _is_cjk(out[-1]) or _is_cjk(ln[0]) else " "
        out += joiner + ln
    # 行內殘留的多重空白也一併收斂
    return re.sub(r"[ \t　]{2,}", " ", out).strip()


def _text_blocks(page: fitz.Page, translate=None) -> list[dict]:
    """
    取出原生 PDF 的文字區塊與座標，bbox 正規化成頁面比例。

    這是整條管線裡最划算的一段：一份 200 頁的原生 PDF，若每頁都送
    視覺模型做版面分析，成本是四位數新台幣且要等十幾分鐘；而 PDF
    本身就精確記錄了每個字的位置，取出來是毫秒級且免費，準確度還
    高於任何模型的估計。

    只有掃描件才真的需要視覺模型——因為那時候確實沒有別的來源。

    實際的重建交給 mathlayout：它從字元幾何與繪圖物件把分數、
    上下標、線段記號組回可讀的形式，並依視覺行重新切區塊。
    PyMuPDF 原本的區塊切法會把一個含分數的算式拆成四塊，
    那四塊單獨看都沒有意義。
    """
    w, h = page.rect.width, page.rect.height
    if w <= 0 or h <= 0:
        return []

    try:
        from .mathlayout import page_blocks

        result = page_blocks(page, translate)
        raw = result.blocks
        stats = {
            "fractions": result.fractions,
            "overlines": result.overlines,
            "scripts": result.scripts,
            "blanks": len(result.blanks),
        }
    except Exception as e:  # noqa: BLE001
        # 幾何重建失敗時退回原本的抽取方式。少了數學式的重組，
        # 但總比整頁沒有文字好——而且品質說明會講明發生了什麼。
        log.warning("數學版面重建失敗，退回逐區塊抽取：%s", e)
        return _plain_blocks(page, translate)

    out: list[dict] = []
    for order, b in enumerate(raw):
        text = b.get("text", "").strip()
        if not text:
            continue
        x0, y0, x1, y1 = b["bbox_abs"]
        entry = {
            "text": _unwrap(text),
            "bbox": {
                "x0": max(0.0, min(1.0, x0 / w)),
                "y0": max(0.0, min(1.0, y0 / h)),
                "x1": max(0.0, min(1.0, x1 / w)),
                "y1": max(0.0, min(1.0, y1 / h)),
            },
            "order": order,
        }
        if b.get("ink"):
            entry["ink"] = b["ink"]
        if b.get("runs"):
            entry["runs"] = b["runs"]
        if order == 0 and stats:
            entry["_math"] = stats
        out.append(entry)

    return _reading_order(out)


def _plain_blocks(page: fitz.Page, translate=None) -> list[dict]:
    """幾何重建失敗時的退路：照 PyMuPDF 的區塊逐塊抽。"""
    w, h = page.rect.width, page.rect.height
    out: list[dict] = []
    for no, block in enumerate(page.get_text("dict").get("blocks", [])):
        if block.get("type") != 0:
            continue
        lines = []
        runs: list[list] = []
        for line in block.get("lines", []):
            parts = []
            for span in line.get("spans", []):
                text = _apply_translation(span, translate)
                parts.append(text)
                if text.strip():
                    ink = f"{span.get('color', 0):06X}"
                    if runs and runs[-1][0] == ink:
                        runs[-1][1] += text
                    else:
                        runs.append([ink, text])
            if "".join(parts).strip():
                lines.append("".join(parts))

        t = _unwrap("\n".join(lines))
        if not t:
            continue
        x0, y0, x1, y1 = block["bbox"]
        entry = {
            "text": t,
            "bbox": {
                "x0": max(0.0, min(1.0, x0 / w)),
                "y0": max(0.0, min(1.0, y0 / h)),
                "x1": max(0.0, min(1.0, x1 / w)),
                "y1": max(0.0, min(1.0, y1 / h)),
            },
            "order": no,
        }
        if runs:
            tally: dict[str, int] = {}
            for ink, text in runs:
                tally[ink] = tally.get(ink, 0) + len(text.strip())
            entry["ink"] = max(tally, key=tally.get)
            if len(tally) > 1:
                entry["runs"] = [[i, t] for i, t in runs if t.strip()]
        out.append(entry)
    return _reading_order(out)


def _apply_translation(span: dict, translate) -> str:
    """把一個 span 的文字做符號字型還原。沒有對應的字元保留原樣。"""
    text = span.get("text", "")
    if translate is None or not text:
        return text
    font = span.get("font", "")
    parts = []
    for ch in text:
        mapped = translate(font, ch) if ch.strip() else None
        parts.append(mapped if mapped is not None else ch)
    return "".join(parts)


#: 判定雙欄所需的最低比例：至少這麼多區塊要能明確歸到某一欄。
_COLUMN_RATIO = 0.8
#: 欄間空白的最小寬度（頁寬比例）。低於此值多半只是段落縮排，
#: 不是真的分欄。學測試卷的欄間距約佔頁寬 4–6%。
_MIN_GUTTER = 0.03


def _find_gutter(blocks: list[dict]) -> float | None:
    """
    找出欄間的垂直空白帶。

    做法：在頁面中段逐一試切，數有多少區塊被切開。欄間空白處被切開
    的區塊數會接近零，而欄內任何位置都會切開一堆。取「幾乎切不到
    東西」的那段最寬區間的中心。

    刻意不用「把所有區塊投影到 x 軸再找空隙」——那個做法會被**一個**
    跨欄的標題毀掉：標題橫跨整頁，投影後空隙就消失了，而跨欄標題
    在試卷上幾乎必然存在。逐位置計數對這種情況天然免疫。

    也不假設分欄在正中央。真實試卷的兩欄常常不等寬（左欄題目、
    右欄圖表）。
    """
    n = len(blocks)
    if n < 4:
        return None

    # 允許少量跨欄區塊。一頁上同時有頁首、頁尾、節標題、跨欄圖表
    # 是很正常的，抓太緊會讓真的雙欄頁面偵測不出來。
    # 放寬到 20% 仍然安全，因為下游還有 _COLUMN_RATIO 這一關：
    # 單欄頁面的每個區塊都會跨過中線，怎麼放寬都不會誤判。
    tolerance = max(2, round(n * 0.2))

    # 只在頁面中段找。靠邊的空白是頁邊距，不是欄間距。
    lo, hi, step = 0.25, 0.75, 0.005
    positions = [lo + i * step for i in range(int((hi - lo) / step) + 1)]

    straddle = [
        sum(1 for b in blocks if b["bbox"]["x0"] < x < b["bbox"]["x1"]) for x in positions
    ]
    fewest = min(straddle)
    if fewest > tolerance:
        return None

    # 只取「切到最少」的位置，而不是「切到不超過 tolerance」的位置。
    #
    # 用門檻會在區塊數少的時候出錯：一頁只有 5 個區塊時 tolerance 是 2，
    # 而寬欄內部任一點也只切到 2 個，於是整個欄內都被當成空白帶，
    # 切點就落到欄的正中間去了。取最小值沒有這個問題——欄內一定
    # 切得比欄間多。
    clear = [s == fewest for s in straddle]

    # 最長的連續「切得過去」區間
    best_len, best_start = 0, -1
    run_start = -1
    for i, ok in enumerate([*clear, False]):
        if ok and run_start < 0:
            run_start = i
        elif not ok and run_start >= 0:
            if i - run_start > best_len:
                best_len, best_start = i - run_start, run_start
            run_start = -1

    if best_start < 0 or best_len * step < _MIN_GUTTER:
        return None
    return positions[best_start] + (best_len - 1) * step / 2


def _by_y(blocks: list[dict]) -> list[dict]:
    """
    單欄內的閱讀順序。

    不是單純按 y0 排。講義與試卷都會把標記放在版心左側的欄外
    （「範例 1」「類題」「解」這種標籤，或試卷的題號），而那些標籤
    的垂直位置通常落在它所屬那一行的**中間**，不是頂端。純按 y0 排
    會把標籤排到它所標記的內容後面，於是切題的時候整份文件錯開一格。

    改成先把垂直上重疊的區塊歸成同一「行帶」，帶內再由左至右。
    這也是人讀紙本的方式：同一行的東西先讀完，再換下一行。
    """
    ordered = sorted(blocks, key=lambda b: (b["bbox"]["y0"], b["bbox"]["x0"]))
    out: list[dict] = []
    band: list[dict] = []
    band_y0 = band_y1 = 0.0

    def flush():
        # 帶內由左至右；同一 x 再依 y，讓左欄外連續兩個標籤保持上下順序
        out.extend(sorted(band, key=lambda b: (b["bbox"]["x0"], b["bbox"]["y0"])))
        band.clear()

    for b in ordered:
        y0, y1 = b["bbox"]["y0"], b["bbox"]["y1"]
        if band:
            overlap = min(y1, band_y1) - max(y0, band_y0)
            shorter = min(y1 - y0, band_y1 - band_y0)
            same_band = shorter > 0 and overlap / shorter >= _BAND_OVERLAP
        else:
            same_band = False

        if not same_band:
            flush()
            band_y0, band_y1 = y0, y1
        else:
            band_y0, band_y1 = min(band_y0, y0), max(band_y1, y1)
        band.append(b)

    flush()
    return out


#: 兩個區塊垂直重疊超過較矮者的這個比例，就算同一行。
#: 0.5 夠寬鬆到能收進欄外標籤，又夠嚴格到不會把上下兩行黏在一起。
_BAND_OVERLAP = 0.5


def _reading_order(blocks: list[dict], _depth: int = 0) -> list[dict]:
    """
    決定閱讀順序。

    直覺的做法是「先上後下、先左後右」排序，但那對**多欄排版是錯的**：
    英文科的閱讀測驗、自然科的試卷幾乎都是雙欄，而雙欄的閱讀順序是
    「左欄整欄讀完，再讀右欄」。按 y 排序會把左右兩欄一行一行交錯
    起來，題幹和選項就全亂了——而這種錯誤在下游看起來會像是模型
    理解力不足，非常難查。

    所以先找欄間空白，找得到就分欄讀，找不到才退回單欄的 y 排序。
    分完欄之後對每一欄再遞迴一次，三欄以上（詞彙表、參考資料頁）
    也就一併處理了。

    刻意**不**用 PDF 的繪製順序當退路。繪製順序多數時候是對的，
    但它取決於產生 PDF 的軟體：Word 匯出的通常沒問題，掃描軟體
    補的文字層、或用繪圖工具排版的題本則完全不保證。既然不可靠，
    就不要拿它當基準。
    """
    # 深度上限。八欄的頁面不存在於試卷上，繼續遞迴只會切出雜訊。
    if _depth >= 3:
        return _by_y(blocks)

    gutter = _find_gutter(blocks)
    if gutter is None:
        return _by_y(blocks)

    left = [b for b in blocks if b["bbox"]["x1"] <= gutter]
    right = [b for b in blocks if b["bbox"]["x0"] >= gutter]
    spanning = [b for b in blocks if b["bbox"]["x0"] < gutter < b["bbox"]["x1"]]

    if len(left) < 2 or len(right) < 2:
        return _by_y(blocks)
    if (len(left) + len(right)) / len(blocks) < _COLUMN_RATIO:
        return _by_y(blocks)

    # 每一欄自己可能還是多欄。遞迴前要重新正規化 x 座標，
    # 否則 _find_gutter 只看頁面中段的規則會讓子欄永遠找不到欄間帶。
    def recurse(col: list[dict]) -> list[dict]:
        x0 = min(b["bbox"]["x0"] for b in col)
        x1 = max(b["bbox"]["x1"] for b in col)
        span = x1 - x0
        if span <= 0:
            return _by_y(col)
        scaled = [
            {
                **b,
                "bbox": {
                    **b["bbox"],
                    "x0": (b["bbox"]["x0"] - x0) / span,
                    "x1": (b["bbox"]["x1"] - x0) / span,
                },
            }
            for b in col
        ]
        order = {id(s): i for i, s in enumerate(scaled)}
        ranked = _reading_order(scaled, _depth + 1)
        # 回傳原始區塊而非縮放過的副本——縮放只是為了判斷順序。
        return [col[order[id(s)]] for s in ranked]

    # 跨欄區塊（標題、跨欄圖表）依 y 分成「兩欄之前」與「其餘」。
    # 夾在兩欄中間的跨欄元素很少見，放到最後比塞進某一欄安全。
    first_y = min(b["bbox"]["y0"] for b in left + right)
    head = _by_y([b for b in spanning if b["bbox"]["y1"] <= first_y])
    tail = _by_y([b for b in spanning if b["bbox"]["y1"] > first_y])

    return head + recurse(left) + recurse(right) + tail


def normalize_pdf(data: bytes, translate=None) -> NormalizeResult:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        zoom = TARGET_DPI / PDF_BASE_DPI
        matrix = fitz.Matrix(zoom, zoom)

        pages: list[PageOut] = []
        native_count = 0

        for page in doc:
            is_native = _page_has_real_text(page)
            native_count += int(is_native)

            pix = page.get_pixmap(matrix=matrix, alpha=False)

            blocks: list[dict] = []
            if is_native:
                blocks = _text_blocks(page, translate)
                # 文字層直接由區塊組回去，而不是另外呼叫 get_text("text")——
                # 否則符號字型的還原只會反映在區塊上，文字層仍是原始的
                # ASCII，兩者對不起來。
                pages.append(
                    PageOut(
                        index=len(pages),
                        width=pix.width,
                        height=pix.height,
                        png=pix.tobytes("png"),
                        text_layer="\n".join(b["text"] for b in blocks),
                        text_blocks=blocks,
                    )
                )
                continue

            # 掃描頁走影像前處理，並據此評估品質。前處理可能把一張
            # 攤開的書切成兩頁，所以 PDF 的頁數不一定等於輸出頁數，
            # index 要用累計值而不是迴圈變數。
            pngs, quality, notes = _enhance_scan(pix.tobytes("png"))
            for png in pngs:
                img = _to_cv(png)
                h, w = img.shape[:2]
                pages.append(
                    PageOut(index=len(pages), width=w, height=h, png=png,
                            text_layer=None, quality=quality, quality_notes=notes)
                )

        # 比例要用**原始頁數**算。切頁只發生在掃描頁上，用輸出頁數
        # 當分母會讓一份切過頁的檔案看起來更像掃描件，判定就飄了。
        source_total = doc.page_count or 1
        total = len(pages) or 1
        native_ratio = native_count / source_total
        kind: SourceKind = "native_pdf" if native_ratio > 0.6 else "scanned_pdf"
        quality = sum(p.quality for p in pages) / total

        split = total - source_total
        extra = f"　其中 {split} 頁是從攤開的書本切出來的。" if split > 0 else ""
        if kind == "native_pdf":
            note = f"原生 PDF，{native_count}/{source_total} 頁有可用文字層，辨識準確率高。"
        else:
            note = (
                f"掃描 PDF（{source_total - native_count}/{source_total} 頁無文字層），"
                f"品質評分 {quality:.2f}。準確率取決於掃描品質，建議抽樣確認。{extra}"
            )

        return NormalizeResult(
            kind=kind,
            pages=pages,
            quality=quality,
            quality_note=note,
            has_text_layer=native_ratio > 0.6,
        )
    finally:
        doc.close()


# ─────────────────────────────────────────────────────────────────
# 影像前處理
#
# 全部是傳統影像處理而非 AI：穩定、便宜、可預測。
# 這一段做得好，下游模型的負擔會小很多。
# ─────────────────────────────────────────────────────────────────


def _to_cv(png: bytes) -> np.ndarray:
    arr = np.frombuffer(png, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("無法解碼影像")
    return img


def _to_png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise ValueError("無法編碼影像")
    return buf.tobytes()


def estimate_skew(gray: np.ndarray) -> float:
    """
    估計頁面傾角。

    **不能只用 Hough 直線偵測。** 它對有表格框線或底線的頁面有效，
    但題本大部分是純文字，而文字的邊緣不會形成長直線——實測結果是
    回傳 0，也就是完全偵測不到傾斜。

    正確的作法是先把同一行的字**橫向膨脹連成一條**，再用最小外接
    矩形量它的角度。這是文件影像處理的標準手法，對純文字頁面可靠。
    Hough 保留為第二順位，處理以表格為主的頁面。
    """
    angle = _skew_by_textlines(gray)
    if angle is not None:
        return angle
    return _skew_by_hough(gray)


def _skew_by_textlines(gray: np.ndarray) -> float | None:
    # 反相二值化：文字變白、背景變黑，膨脹才會把字連起來
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)

    # 橫向膨脹。核寬取頁寬的約 1/40，足以把一行內的字連成條狀，
    # 又不會把相鄰兩行黏在一起。
    kw = max(15, gray.shape[1] // 40)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kw, 3))
    lines_img = cv2.dilate(binary, kernel, iterations=1)

    contours, _ = cv2.findContours(lines_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    angles: list[float] = []
    min_w = gray.shape[1] * 0.12  # 太短的不是文字行，是雜訊或頁碼
    for c in contours:
        (_, _), (w, h), ang = cv2.minAreaRect(c)
        if w < h:  # minAreaRect 的長短邊會互換，統一成橫向
            w, h = h, w
            ang += 90
        if w < min_w or h == 0 or w / h < 4:
            continue
        # 正規化到 ±45°
        while ang > 45:
            ang -= 90
        while ang < -45:
            ang += 90
        if abs(ang) <= 20:
            angles.append(ang)

    if len(angles) < 3:  # 樣本太少，中位數不可信
        return None
    return float(np.median(angles))


def _skew_by_hough(gray: np.ndarray) -> float:
    """以表格框線或底線為主的頁面走這條。"""
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180, threshold=100,
        minLineLength=max(60, gray.shape[1] // 8), maxLineGap=12,
    )
    if lines is None:
        return 0.0

    angles = []
    for x1, y1, x2, y2 in lines[:, 0]:
        if x2 == x1:
            continue
        ang = math.degrees(math.atan2(y2 - y1, x2 - x1))
        if -30 < ang < 30:
            angles.append(ang)
    return float(np.median(angles)) if angles else 0.0


def deskew(img: np.ndarray, angle: float) -> np.ndarray:
    """
    以 `estimate_skew()` 回傳的角度校正影像。

    **兩者的正負號約定必須成對使用**，不要各自單獨拿去用——
    `estimate_skew` 回傳的是「要把頁面轉正所需的旋轉量」，
    不是「頁面目前傾斜了多少度」，兩者差一個負號。

    這種隱性約定是日後最容易出錯的地方，所以請一律用
    `correct_skew()`，除非你明確需要知道角度本身。
    """
    if abs(angle) < 0.15:  # 小於這個角度，旋轉的插值損失大於收益
        return img
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return cv2.warpAffine(
        img, m, (w, h),
        flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE,
    )


def correct_skew(img: np.ndarray) -> tuple[np.ndarray, float]:
    """
    偵測並校正傾斜，回傳 (校正後影像, 原始傾角)。

    這是呼叫端該用的介面——它把正負號的約定包在裡面，
    呼叫者不需要知道 estimate_skew 與 deskew 的符號關係。
    回傳的角度是**頁面原本傾斜的角度**（正值為順時針），供記錄與回報用。
    """
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    rotation = estimate_skew(gray)
    return deskew(img, rotation), -rotation


def find_page_quad(gray: np.ndarray) -> np.ndarray | None:
    """
    找出頁面的四個角，供透視校正。

    手機拍攝時頁面是梯形的。校正後不只好看，更重要的是**版面座標
    才有意義**——校對介面的左右連動依賴 bbox，梯形變形會讓 bbox
    對不上實際位置。
    """
    h, w = gray.shape[:2]
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    page_area = h * w
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        area = cv2.contourArea(c)
        # 太小的不是頁面；太大（≈整張圖）代表沒有偵測到邊界，
        # 那時做透視校正反而會裁掉內容
        if area < page_area * 0.25 or area > page_area * 0.98:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4:
            return approx.reshape(4, 2).astype(np.float32)
    return None


def warp_to_rect(img: np.ndarray, quad: np.ndarray) -> np.ndarray:
    # 依左上、右上、右下、左下排序
    s = quad.sum(axis=1)
    d = np.diff(quad, axis=1).ravel()
    ordered = np.array(
        [quad[np.argmin(s)], quad[np.argmin(d)], quad[np.argmax(s)], quad[np.argmax(d)]],
        dtype=np.float32,
    )
    (tl, tr, br, bl) = ordered
    width = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    height = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    if width < 50 or height < 50:
        return img
    dst = np.array(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
        dtype=np.float32,
    )
    m = cv2.getPerspectiveTransform(ordered, dst)
    return cv2.warpPerspective(img, m, (width, height), flags=cv2.INTER_CUBIC)


def measure_sharpness(gray: np.ndarray) -> float:
    """
    以 Laplacian 變異數衡量清晰度。手機拍糊的頁面在這裡會很低，
    而糊掉的頁面 OCR 一定不準——先量出來，別讓老師事後才發現。
    """
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def flatten_illumination(img: np.ndarray) -> tuple[np.ndarray, float]:
    """
    補償光照不均，回傳 (處理後影像, 背景標準差)。

    **只動亮度，不動顏色。** 早期版本把整張圖轉成灰階再轉回 BGR，
    看起來乾淨，實際上把顏色扔了——而顏色是這個系統最值錢的訊號：
    教用版的答案是用洋紅色印的（實測 #EC008C / #E4007F），
    答對率標記、英文講義的表格底色也都靠顏色分辨。灰階化等於
    在第一步就把教用版與學生版的差別抹平。

    作法是轉到 LAB 只處理 L 通道：以形態學閉運算估計背景亮度，
    扣掉後正規化。a、b 通道原封不動，色相因此完整保留。
    """
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0]
    bg = cv2.morphologyEx(L, cv2.MORPH_CLOSE, np.ones((31, 31), np.uint8))
    shadow = float(np.std(bg))
    if shadow <= _SHADOW_STD:
        return img, shadow
    flat = cv2.normalize(255 - cv2.absdiff(L, bg), None, 0, 255, cv2.NORM_MINMAX)
    lab[:, :, 0] = flat
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR), shadow


#: 背景亮度標準差超過這個值就視為光照不均。實測手機翻拍
#: 落在 52–69，掃描器落在個位數。
_SHADOW_STD = 22.0


def _line_energy(gray: np.ndarray) -> float:
    """
    橫向文字行的總長度。頁面轉正時這個值最大——文字行只有在
    水平時才會被橫向膨脹連成長條。
    """
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    kw = max(15, gray.shape[1] // 40)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kw, 3))
    dilated = cv2.dilate(binary, kernel, iterations=1)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_w = gray.shape[1] * 0.06
    total = 0.0
    for c in contours:
        _, _, w, h = cv2.boundingRect(c)
        if w >= min_w and h > 4 and w / h >= 4:
            total += w
    return total


def _flush_edge(gray: np.ndarray) -> tuple[float, float] | None:
    """
    量左右兩側邊緣的「齊整度」，回傳 (左, 右)。

    排版的行首是對齊的、行尾是參差的，**與語言無關**。把頁面轉
    180° 之後兩者互換，所以哪一邊比較齊就能判斷正反。用「落在
    同一個直方格的行數比例」而不是變異數——多欄排版會讓變異數
    失去意義，但每一欄的行首仍然各自對齊，直方圖抓得到。
    """
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    kw = max(15, gray.shape[1] // 40)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kw, 3))
    dilated = cv2.dilate(binary, kernel, iterations=1)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_w = gray.shape[1] * 0.06
    lefts, rights = [], []
    for c in contours:
        x, _, w, h = cv2.boundingRect(c)
        if w >= min_w and h > 4 and w / h >= 4:
            lefts.append(x)
            rights.append(x + w)
    if len(lefts) < 8:
        return None

    def flushness(v: list[int]) -> float:
        hist, _ = np.histogram(v, bins=40, range=(0, gray.shape[1]))
        return float(hist.max()) / len(v)

    return flushness(lefts), flushness(rights)


#: 橫向行能量至少要是直向的這個倍數，才敢說頁面是正的。
#: 實測五張翻拍照片落在 5.7–23.4，轉了 90° 的那張是 0.16。
_ORIENT_RATIO = 2.0
#: 行首齊整度要領先行尾這個倍數，才敢翻 180°。
#: 實測差距最小的一張（四欄選項）是 1.14，最大的是 2.0。
_FLIP_MARGIN = 1.3


def estimate_orientation(img: np.ndarray) -> tuple[int, str]:
    """
    判定頁面要**順時針**轉幾度才是正的，回傳 (0/90/180/270, 說明)。

    分兩步，因為兩件事的可靠度差很多：

      橫／直：比較橫向文字行能量。訊號極強（實測 5–23 倍），
              可以放心自動轉。
      正／反：比較行首與行尾的齊整度。訊號較弱，只有差距夠大
              才自動轉；不夠大就不動，改在品質說明裡提醒人看一眼。

    **先做光照補償再呼叫這支。** 手機翻拍的背景是桌面與手，全域
    Otsu 在原圖上會把整片暗處當成文字——實測地理那兩張在原圖上
    偵測到 0 條文字行，補償後是 33 與 69 條。
    """
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    horiz = _line_energy(gray)
    vert = _line_energy(cv2.rotate(gray, cv2.ROTATE_90_CLOCKWISE))

    sideways = False
    if vert > horiz * _ORIENT_RATIO:
        sideways = True
        gray = cv2.rotate(gray, cv2.ROTATE_90_CLOCKWISE)
    elif horiz <= vert * _ORIENT_RATIO:
        # 兩邊差不多：多半是圖表為主、文字很少的頁面。不猜。
        return 0, "頁面方向無法判定（文字行太少），維持原樣"

    edges = _flush_edge(gray)
    if edges is None:
        return (90 if sideways else 0), (
            "已轉正 90°（無法判定正反）" if sideways else ""
        )

    left, right = edges
    flipped = right > left * _FLIP_MARGIN
    unsure = not flipped and right > left

    deg = (90 if sideways else 0) + (180 if flipped else 0)
    deg %= 360

    if deg == 0:
        note = "頁面方向可能上下顛倒，請確認" if unsure else ""
    else:
        note = f"已將頁面旋轉 {deg}°"
        if unsure:
            note += "（正反不確定，請確認）"
    return deg, note


def _rotate(img: np.ndarray, deg: int) -> np.ndarray:
    if deg == 90:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    if deg == 180:
        return cv2.rotate(img, cv2.ROTATE_180)
    if deg == 270:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return img


#: 裝訂線處的墨量最多只能是版面正常墨量的這個比例。
#: 實測四張照片是 0.00–0.01，一張裝訂處有明顯陰影的是 0.23；
#: 把一張單頁橫向拉寬當負例測得 0.51。0.30 夾在中間。
#:
#: 這個門檻抓不到的代價有限：漏切的話，那一頁會以「攤開的兩頁」
#: 送進視覺模型，而 `segment_scanned` 本來就是設計成一次看兩頁的。
#: 漏切會讓 bbox 與頁碼失真，但不會讓內容錯亂。相對地，**誤切**
#: 會把每一行從中間切斷，那才是災難——所以門檻要往保守的一邊放。
_GUTTER_DEPTH = 0.30
#: 切開後每一半至少要有這個比例的墨，否則切到的是空白邊而不是裝訂線。
_GUTTER_BALANCE = 0.25


def find_book_gutter(gray: np.ndarray) -> float | None:
    """
    找攤開書本的裝訂線，回傳它在頁寬中的位置比例；找不到回 None。

    翻拍一本攤開的書會**一次拍到兩頁**。系統若把它當成一頁，
    版面切分會橫跨裝訂線把左頁第一行和右頁第一行接成一句——
    那是無聲的錯誤，題目看起來很正常，只是內容錯了。

    判斷依據是頁面中段墨量的**山谷**，而不是「完全沒有墨的直帶」。
    絕對零墨的判準太脆：實測五張照片裡，一本厚書的兩頁幾乎相貼，
    空白帶只有 28 px（門檻 30），另一張的裝訂處有書頁彎曲的陰影，
    空白帶只剩 5 px——兩張都會被漏掉，但它們的山谷都很明顯。

    只在**橫幅**影像上找：直幅的中間空白帶是雙欄排版的欄距，
    切下去會把每一題攔腰折斷。再加一道左右墨量均衡的檢查，避免
    把一張置中留白的橫幅講義誤切成兩頁。
    """
    h, w = gray.shape[:2]
    if w < h * 1.1:  # 直幅：不是攤開的書
        return None

    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    ink = (binary > 0).sum(axis=0).astype(float) / h

    # 以「一個字寬」的窗平滑：比單一像素穩，又不會把裝訂線抹平
    win = max(3, w // 100) | 1
    smooth = cv2.blur(ink.reshape(1, -1), (win, 1)).ravel()

    lo, hi = int(w * 0.32), int(w * 0.68)
    at = lo + int(np.argmin(smooth[lo:hi]))

    # 版面的正常墨量取中位數，而不是最大值——最大值可能落在
    # 一條表格框線上，那會讓門檻變得毫無鑑別力。
    body = smooth[smooth > 0]
    if body.size == 0:
        return None
    normal = float(np.median(body))
    if normal <= 0 or smooth[at] > normal * _GUTTER_DEPTH:
        return None

    left, right = float(ink[:at].sum()), float(ink[at:].sum())
    total = left + right
    if total <= 0:
        return None
    if min(left, right) / total < _GUTTER_BALANCE:
        return None

    return at / w


def split_spread(img: np.ndarray) -> list[np.ndarray] | None:
    """把攤開書本的照片切成左右兩頁；不是攤開的書就回 None。"""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    at = find_book_gutter(gray)
    if at is None:
        return None
    x = int(img.shape[1] * at)
    return [img[:, :x], img[:, x:]]


def _enhance_scan(png: bytes) -> tuple[list[bytes], float, list[str]]:
    """
    掃描頁與照片的前處理，並回報品質。
    回傳 (處理後的 PNG 清單, 品質 0–1, 說明)。

    **回傳清單而不是單張**：翻拍攤開的書會一次拍到兩頁，這裡會
    把它切開。呼叫端必須把清單裡的每一張都當成獨立的一頁。

    步驟順序是有原因的，不要隨意調換：

      1. 先在**原圖**上量清晰度與對比度。第 3 步的光照補償會把
         背景壓成一致的白，量出來的標準差必然變低——早期版本在
         補償後才量對比度，於是每一張手機照片都被誤判成「淡墨或
         影本多次複印」（實測原圖 54–66，補償後 27–36，門檻 35）。
      2. 光照補償要在方向判定之前。翻拍照片的背景是桌面與手，
         全域二值化在原圖上找不到文字行。
      3. 方向、透視、歪斜、切頁依序做。切頁放最後，因為裝訂線
         要在頁面轉正之後才找得準。
    """
    notes: list[str] = []
    quality = 1.0

    try:
        img = _to_cv(png)
    except ValueError:
        return [png], 0.3, ["影像無法解碼，已保留原檔"]

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # ① 在原圖上量。補償之後量到的是補償的效果，不是紙的狀況。
    sharp = measure_sharpness(gray)
    if sharp < 40:
        quality -= 0.35
        notes.append(f"影像偏模糊（清晰度 {sharp:.0f}），辨識準確率會明顯下降")
    elif sharp < 120:
        quality -= 0.12
        notes.append(f"影像清晰度普通（{sharp:.0f}）")

    contrast = float(gray.std())
    if contrast < 35:
        quality -= 0.15
        notes.append(f"對比度偏低（{contrast:.0f}），可能是淡墨或影本多次複印")

    # ② 光照補償（保留顏色）
    img, shadow = flatten_illumination(img)
    if shadow > _SHADOW_STD:
        quality -= 0.08
        notes.append(f"偵測到光照不均（背景標準差 {shadow:.0f}），已補償")

    # ③ 方向
    deg, note = estimate_orientation(img)
    if deg:
        img = _rotate(img, deg)
    if note:
        notes.append(note)
        if "請確認" in note:
            quality -= 0.05

    # ④ 透視校正
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    quad = find_page_quad(gray)
    if quad is not None:
        img = warp_to_rect(img, quad)
        notes.append("已偵測頁面四角並做透視校正")

    # ⑤ 去歪斜。用 correct_skew 而非直接呼叫 estimate_skew + deskew，
    #    避免正負號用錯——那種錯誤會把頁面轉得更歪，而且不會報錯。
    img, skew_deg = correct_skew(img)
    if abs(skew_deg) >= 0.15:
        notes.append(f"已校正傾斜 {skew_deg:+.1f}°")
        if abs(skew_deg) > 8:
            quality -= 0.1
            notes.append("原始傾角偏大，邊緣文字可能受損")

    # ⑥ 攤開的書切成兩頁
    parts = split_spread(img)
    if parts:
        notes.append("偵測到攤開的書本，已從裝訂線切成兩頁")
        return [_to_png(p) for p in parts], max(0.0, min(1.0, quality)), notes

    return [_to_png(img)], max(0.0, min(1.0, quality)), notes


def normalize_image(data: bytes) -> NormalizeResult:
    pngs, quality, notes = _enhance_scan(data)

    pages: list[PageOut] = []
    for i, png in enumerate(pngs):
        img = _to_cv(png)
        h, w = img.shape[:2]
        pages.append(
            PageOut(index=i, width=w, height=h, png=png,
                    quality=quality, quality_notes=notes)
        )

    count = f"單張影像切出 {len(pages)} 頁" if len(pages) > 1 else "單張影像"
    note = (
        f"{count}，品質評分 {quality:.2f}。"
        + ("；".join(notes) if notes else "")
        + "　照片來源的辨識準確率低於掃描件，**建議逐題確認**。"
    )
    return NormalizeResult(
        kind="image",
        pages=pages,
        quality=quality,
        quality_note=note,
        has_text_layer=False,
    )


# ─────────────────────────────────────────────────────────────────
# 入口
# ─────────────────────────────────────────────────────────────────


#: LibreOffice 轉檔的逾時。一份 200 頁、內含大量圖表的 docx
#: 在慢的機器上要一分鐘出頭；三分鐘是「還沒好就一定是卡住了」。
_SOFFICE_TIMEOUT = 180


def docx_to_pdf(data: bytes, filename: str = "doc.docx") -> bytes:
    """
    DOCX／ODT 轉 PDF，之後走與 PDF 完全相同的路徑。

    為什麼不直接解析 DOCX：Word 檔的 XML 描述的是「內容與樣式」，
    不是「最後長怎樣」。分頁位置、表格換行、圖文繞排都要靠排版
    引擎算出來，而題本的版面資訊（哪一題在哪一頁、選項怎麼排）
    恰恰是我們需要的。自己實作排版引擎不可能贏過 LibreOffice。

    代價是多一次轉檔與一份中介檔，但那換來的是**下游只需要處理
    一種格式**——少一條分支就少一整類只在 Word 檔上出現的 bug。
    """
    import shutil
    import subprocess
    import tempfile
    from pathlib import Path

    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise RuntimeError(
            "找不到 LibreOffice，無法處理 Word 檔。"
            "Docker 部署請確認映像已重新建置；原生安裝請執行 "
            "apt-get install libreoffice-writer-nogui fonts-noto-cjk。"
        )

    suffix = ".odt" if filename.lower().endswith(".odt") else ".docx"
    with tempfile.TemporaryDirectory(prefix="yunzhi-docx-") as tmp:
        src = Path(tmp) / f"in{suffix}"
        src.write_bytes(data)

        try:
            proc = subprocess.run(
                [
                    soffice,
                    "--headless",
                    "--norestore",
                    # 每次用獨立的設定目錄。共用的話，兩個並行的轉檔
                    # 會互相搶 profile 鎖，第二個直接靜默失敗。
                    f"-env:UserInstallation=file://{tmp}/profile",
                    "--convert-to",
                    "pdf:writer_pdf_Export",
                    "--outdir",
                    tmp,
                    str(src),
                ],
                capture_output=True,
                timeout=_SOFFICE_TIMEOUT,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(
                f"Word 檔轉換超過 {_SOFFICE_TIMEOUT} 秒未完成。"
                f"檔案可能過大或含有損毀的內嵌物件，建議先用 Word 另存成 PDF 再上傳。"
            ) from e

        out = Path(tmp) / "in.pdf"
        if not out.exists():
            detail = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace")[:400]
            raise RuntimeError(
                f"Word 檔轉換失敗（LibreOffice 回傳 {proc.returncode}）。"
                f"若檔案能在 Word 正常開啟，請另存成 PDF 後再上傳。原始訊息：{detail}"
            )

        pdf = out.read_bytes()

    if not pdf.startswith(b"%PDF"):
        raise RuntimeError("Word 檔轉換的產物不是有效的 PDF")
    return pdf


@dataclass
class Prepared:
    """
    正規化前的準備結果。

    拆成獨立一步，是因為中間夾了一個**需要呼叫 AI 的**環節
    （符號字型辨識），而正規化本身是同步的重運算。分開之後，
    呼叫端可以把兩段各自放在該去的地方：重運算進執行緒池，
    AI 呼叫留在事件迴圈。
    """

    kind: SourceKind
    #: PDF/DOCX 都會轉成 PDF bytes；影像為 None
    pdf: bytes | None
    original: bytes
    filename: str
    glyphs: "GlyphReport"


def prepare(data: bytes, filename: str = "") -> Prepared:
    """轉檔（若需要）並盤點符號字型。同步，不呼叫 AI。"""
    from .glyphmap import GlyphReport, scan

    kind = sniff(data, filename)

    if kind == "unknown":
        raise ValueError(
            f"無法辨識的檔案格式（前 8 位元組：{data[:8]!r}）。"
            f"支援 PDF、JPEG、PNG、WebP、HEIC 與 DOCX。"
        )

    if kind == "image":
        return Prepared(kind, None, data, filename, GlyphReport())

    pdf = docx_to_pdf(data, filename) if kind == "docx" else data

    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        report = scan(doc)
    except Exception as e:  # noqa: BLE001
        # 字型盤點失敗不該擋住匯入——最差的結果是符號字元保持原樣。
        log.warning("符號字型盤點失敗：%s", e)
        report = GlyphReport()
    finally:
        doc.close()

    return Prepared(kind, pdf, data, filename, report)


def normalize(
    data: bytes | Prepared,
    filename: str = "",
    translate=None,
) -> NormalizeResult:
    """
    正規化。可以吃原始位元組（自行 prepare），或吃已經 prepare 過的結果。

    吃 Prepared 的路徑才會用到符號字型的還原——那需要先問過模型。
    """
    if isinstance(data, Prepared):
        prep = data
        if translate is None and prep.glyphs.mapping:
            from .glyphmap import translator

            translate = translator(prep.glyphs)
    else:
        prep = None

    if prep is None:
        kind = sniff(data, filename)
        if kind == "image":
            return normalize_image(data)
        if kind == "docx":
            return _with_docx_note(normalize_pdf(docx_to_pdf(data, filename), translate))
        if kind in ("native_pdf", "scanned_pdf"):
            return normalize_pdf(data, translate)
        raise ValueError(
            f"無法辨識的檔案格式（前 8 位元組：{data[:8]!r}）。"
            f"支援 PDF、JPEG、PNG、WebP、HEIC 與 DOCX。"
        )

    if prep.kind == "image":
        return normalize_image(prep.original)

    result = normalize_pdf(prep.pdf, translate)
    if prep.kind == "docx":
        result = _with_docx_note(result)

    if note := prep.glyphs.note():
        result.quality_note = f"{result.quality_note}　{note}"
        # 有字形沒還原成功時，品質要跟著降——那代表題號或選項編號
        # 可能是錯的，而那種錯誤在校對時不容易一眼看出來。
        if prep.glyphs.unresolved:
            result.quality = max(0.0, result.quality - 0.15)
    return result


def _with_docx_note(result: NormalizeResult) -> NormalizeResult:
    result.quality_note = (
        f"Word 檔已轉為 PDF 後解析。{result.quality_note}"
        "　若原檔的版面在 Word 裡有特殊設定，轉換後可能略有差異。"
    )
    return result
