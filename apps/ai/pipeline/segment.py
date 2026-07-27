"""
階段二：版面切分。

輸入是正規化後的頁面，輸出是帶類型與座標的內容區塊。下游的結構化
階段吃這些區塊，校對介面則用區塊座標做左右連動（點候選題 → 原稿
對應位置反白）。

這一階段有兩條路徑，選哪一條完全取決於**有沒有文字層**：

  原生 PDF → 純程式切分。PDF 自己精確記錄了每個字的位置，
             題號、選項標記、節標題的寫法又高度規則化，
             正則比模型準、快、而且免費。

  掃描件   → 視覺模型。這時候確實沒有別的資訊來源。

一份 200 頁的原生 PDF 若每頁都送視覺模型，成本是四位數新台幣、
要等十幾分鐘，而準確度還比不上直接讀 PDF 的座標。所以這裡的
分流不是最佳化，是常識：**能用程式做的就不要用 AI**。
"""

from __future__ import annotations

import logging
import re
from typing import Any

from providers import BaseProvider, ProviderError

from .prompts import SEGMENT_SYSTEM, segment_user
from .schemas import BBox, BlockType, LayoutBlock, SegmentResult

log = logging.getLogger("yunzhi.ai.pipeline.segment")


# ─────────────────────────────────────────────────────────────────
# 體例的正則
#
# 全部來自 115 學測真實試卷。全形／半形都要收——同一份題本裡
# 中文用全形括號、數學式用半形括號是很普遍的。
# ─────────────────────────────────────────────────────────────────

_D = "0-9０-９"  # 半形與全形數字
_LP = r"[（(]"
_RP = r"[）)]"

#: 「第壹部分、選擇題（占 85 分）」「一、單選題（占 30 分）」
_SECTION_HEADER = re.compile(
    rf"^\s*(?:第\s*[壹貳參叁肆伍陸柒捌玖拾一二三四五六七八九十]+\s*部分"
    rf"|[一二三四五六七八九十]+\s*[、．.]"
    rf"|第\s*[{_D}]+\s*部分)"
)

#: 「第壹部分、選擇題與選填題（占 85 分）」——部，不是節。
_PART_HEADER = re.compile(
    r"^\s*第\s*[壹貳參叁肆伍陸柒捌玖拾]+\s*部分"
)

#: 「說明：第 1 題至第 6 題，每題有 5 個選項…」
_SECTION_NOTE = re.compile(r"^\s*說\s*明\s*[：:]")

#: 「第 37 題至第 39 題為題組」「37-39 為題組」
_GROUP_LEAD = re.compile(
    rf"第?\s*[{_D}]+\s*(?:題)?\s*(?:至|[-－—~～])\s*第?\s*[{_D}]+\s*題?\s*為題組"
)

#: 題號。「1.」「12、」「１．」「(3)」都算。
#: 必須錨在行首，否則「共 20 題」裡的數字會被當成題號。
_QUESTION_NO = re.compile(rf"^\s*{_LP}?\s*([{_D}]{{1,3}})\s*{_RP}?\s*[.、．·]?\s")

#: 選項。學測數學是 5 個 (1)–(5)，英文是 4 個 (A)–(D)，
#: 舊卷與部分講義用 ①②③④⑤。三種都要認得。
#:
#: **刻意排除小寫字母**。(a)(b) 在學測體例裡是混合題的子題編號，
#: 不是選項——把它當成選項會讓一整道非選題被拆成幾個空殼選項，
#: 而且錯得很安靜（下游只會看到一題「沒有題幹的選擇題」）。
_OPTION = re.compile(
    rf"^\s*(?:{_LP}\s*(?:[{_D}]|[A-EＡ-Ｅ])\s*{_RP}|[①②③④⑤⑥⑦⑧⑨⑩]|[ＡＢＣＤＥ][、．.])"
)

#: 混合題子題：「（a）」「（b）」，學測用全形小寫。
_SUB_LABEL = re.compile(rf"^\s*{_LP}\s*[a-zａ-ｚ]\s*{_RP}")

#: 頁首頁尾。「第 3 頁，共 8 頁」「115學測-數學A」
_HEADER_FOOTER = re.compile(
    rf"^\s*(?:[-－]?\s*[{_D}]+\s*[-－]?\s*$"
    rf"|第\s*[{_D}]+\s*頁"
    rf"|共\s*[{_D}]+\s*頁"
    rf"|[{_D}]+\s*學年度)"
)

#: 詳解區塊。題目與解析的著作權地位完全不同（試題依著作權法
#: 第 9 條不受保護、解析受保護），所以一定要分流。
_EXPLANATION = re.compile(r"^\s*[【\[]?\s*(?:詳解|解析|答案與解析|說明與解析|試題解析)\s*[】\]]?")

#: 答案欄。獨立答案卷的形狀：「1.(3) 2.(5) 3.(1)…」連續多組。
_ANSWER_ROW = re.compile(rf"(?:[{_D}]+\s*[.、．]\s*{_LP}?[{_D}A-E]+{_RP}?[\s,，]*){{3,}}")


def _classify(text: str, prev: BlockType | None) -> BlockType:
    """
    依文字內容判定區塊類型。

    順序有意義：先判斷特徵最明確的，再判斷容易誤中的。
    例如題號的規則很寬鬆（行首一個數字加標點），所以要排在
    節標題、頁碼之後——否則「第 3 頁」會被當成第 3 題。
    """
    t = text.strip()
    if not t:
        return BlockType.HEADER_FOOTER

    if _EXPLANATION.match(t):
        return BlockType.EXPLANATION
    if _HEADER_FOOTER.match(t):
        return BlockType.HEADER_FOOTER
    if _SECTION_NOTE.match(t):
        return BlockType.SECTION_NOTE
    if _GROUP_LEAD.search(t[:40]):
        return BlockType.GROUP_LEAD
    if _SECTION_HEADER.match(t):
        return BlockType.SECTION_HEADER
    if _ANSWER_ROW.search(t):
        return BlockType.ANSWER_AREA
    # 子題編號要排在選項之前判。兩者的形狀很像，而混合題子題
    # 被誤判成選項是會靜默壞掉的那種錯。
    if _SUB_LABEL.match(t):
        return BlockType.STEM  # 混合題子題，題幹的一種
    if _OPTION.match(t):
        return BlockType.OPTION
    if _QUESTION_NO.match(t):
        return BlockType.QUESTION_NO

    # 都不像的話，看前一塊：選項後面接的通常還是選項的續行，
    # 題幹後面接的還是題幹。這比一律歸成 STEM 準得多。
    if prev in (BlockType.OPTION, BlockType.STEM, BlockType.QUESTION_NO):
        return prev
    return BlockType.STEM


def segment_native(page_index: int, text_blocks: list[dict]) -> SegmentResult:
    """
    原生 PDF 的切分。純程式，零成本。

    text_blocks 由 normalize._text_blocks 產出，已經是閱讀順序、
    bbox 已正規化為 0–1 比例。
    """
    blocks: list[LayoutBlock] = []
    prev: BlockType | None = None

    for b in text_blocks:
        text = (b.get("text") or "").strip()
        if not text:
            continue
        bt = _classify(text, prev)
        bb = b["bbox"]
        try:
            bbox = BBox(page=page_index, x0=bb["x0"], y0=bb["y0"], x1=bb["x1"], y1=bb["y1"])
        except Exception:
            # 退化的 bbox（零寬或零高）。內容仍然有用，座標放棄——
            # 只會失去校對介面的連動，不該讓整頁失敗。
            bbox = BBox(page=page_index, x0=0.0, y0=0.0, x1=1.0, y1=1.0)
        blocks.append(LayoutBlock(type=bt, bbox=bbox, text=text))
        # HEADER_FOOTER 不該影響後續的續行判定
        if bt is not BlockType.HEADER_FOOTER:
            prev = bt

    _mark_continuations(blocks)

    groups = [
        m.group(0)
        for b in blocks
        if b.type is BlockType.GROUP_LEAD
        for m in [_GROUP_LEAD.search(b.text)]
        if m
    ]
    return SegmentResult(blocks=blocks, group_ranges=groups)


#: 頁面底部／頂部的邊界。跨頁題目的判定只看這兩個帶。
_BOTTOM = 0.88
_TOP = 0.12


def _mark_continuations(blocks: list[LayoutBlock]) -> None:
    """
    標記跨頁。

    判準很保守：只有「頁面最下方的內容區塊不是完整的一題」才標。
    誤標的代價是把兩題合成一題（下游要靠人拆開），漏標的代價是
    一題被切成兩半（下游會產生兩個殘缺候選）。兩者都不好，
    但誤標比較容易在校對時看出來，所以偏向保守。
    """
    content = [b for b in blocks if b.type is not BlockType.HEADER_FOOTER]
    if not content:
        return

    last = content[-1]
    if last.bbox.y1 >= _BOTTOM and last.type in (
        BlockType.STEM,
        BlockType.OPTION,
        BlockType.GROUP_LEAD,
        BlockType.QUESTION_NO,
    ):
        last.continues_to_next = True

    first = content[0]
    # 頁首就是選項或題幹續行 → 多半延續自前頁。
    # 題號開頭的那種不算，它是新的一題。
    if first.bbox.y0 <= _TOP and first.type in (BlockType.OPTION, BlockType.STEM):
        first.continued_from_prev = True


async def segment_scanned(
    provider: BaseProvider,
    page_index: int,
    images: list[bytes],
    page_note: str = "",
) -> SegmentResult:
    """
    掃描件的切分。這時候只有影像，不得不用視覺模型。

    一次送**連續兩頁**（呼叫端負責組），讓模型看得到跨頁的接續。
    只給一頁時，「這一題的選項在哪裡」是無解的。
    """
    from .stages import _structured  # 延後匯入，避免循環相依

    note = page_note or f"這是第 {page_index} 頁"
    result, _ = await _structured(
        provider,
        model_cls=SegmentResult,
        system=SEGMENT_SYSTEM,
        user=segment_user(note),
        tier="MID",
        max_tokens=16384,
        images=images,
    )

    # 模型回報的 page 可能是 1 或 2（它看到兩頁），要換算回真實頁碼。
    for b in result.blocks:
        if b.bbox.page <= 1:
            b.bbox.page = page_index
        else:
            b.bbox.page = page_index + (b.bbox.page - 1)
    return result


async def segment_page(
    provider: BaseProvider,
    *,
    page_index: int,
    text_blocks: list[dict] | None,
    images: list[bytes] | None = None,
    page_note: str = "",
) -> tuple[SegmentResult, str]:
    """
    切分單頁，自動選路徑。回傳 (結果, 使用的方法)。

    方法會記錄下來給校對介面用：純程式切出來的頁面幾乎不會錯，
    視覺模型切出來的則值得多看一眼。這個差別要讓老師知道。
    """
    if text_blocks:
        return segment_native(page_index, text_blocks), "native"

    if not images:
        raise ValueError(f"第 {page_index} 頁既無文字層也無影像，無法切分")

    try:
        return await segment_scanned(provider, page_index, images, page_note), "vision"
    except ProviderError as e:
        log.error("第 %d 頁的視覺切分失敗：%s", page_index, e)
        raise


def merge_across_pages(pages: list[SegmentResult]) -> list[LayoutBlock]:
    """
    把各頁的區塊接成單一序列，並合併跨頁的題目。

    合併的定義是「把被切斷的文字接回去」，而不是「把兩個區塊放在
    一起」——下游的結構化階段吃的是連續文字，中間多一個斷點就
    可能把一題讀成兩題。
    """
    out: list[LayoutBlock] = []
    for page in pages:
        for b in page.blocks:
            if (
                b.continued_from_prev
                and out
                and out[-1].continues_to_next
                and out[-1].type == b.type
            ):
                # 接回去。中文不需要空格，英文需要——用結尾字元判斷。
                joiner = "" if _ends_with_cjk(out[-1].text) else " "
                out[-1].text = f"{out[-1].text}{joiner}{b.text}"
                out[-1].continues_to_next = b.continues_to_next
                continue
            out.append(b)
    return out


def _ends_with_cjk(text: str) -> bool:
    if not text:
        return False
    c = text.rstrip()[-1:]
    return bool(c) and ("一" <= c <= "鿿" or "　" <= c <= "〿")


def blocks_to_text(blocks: list[LayoutBlock]) -> str:
    """
    餵給結構化階段的文字。

    帶上區塊類型標記而不是丟一坨純文字：類型是這一階段已經算出來的
    資訊，扔掉它等於讓下游模型再猜一次，而且可能猜得比較差。
    """
    lines: list[str] = []
    for b in blocks:
        if b.type is BlockType.HEADER_FOOTER:
            continue  # 頁首頁尾對題目內容沒有貢獻，只會干擾
        lines.append(f"[{b.type.value}] {b.text}")
    return "\n".join(lines)


def split_by_section(blocks: list[LayoutBlock]) -> list[dict[str, Any]]:
    """
    依節切段。

    結構化階段是逐節處理的——節標題與節說明決定了該節的題型與配分
    推定（parse_section），而那個推定是「原稿不逐題標配分」時
    唯一的依據。整份一起送就沒有這個資訊了。
    """
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    part = ""

    for b in blocks:
        # 頁首頁尾不該開新節，也不該被算進任何一節。
        if b.type is BlockType.HEADER_FOOTER:
            continue

        if b.type is BlockType.SECTION_HEADER:
            # 「第壹部分（占 85 分）」是部標題，「一、單選題（占 30 分）」
            # 才是節標題。部標題底下不會直接有題目，若丟掉它，
            # 部總分這個機械檢核的依據就沒了。所以把它記著，
            # 併進接下來每一節的標題。
            if _PART_HEADER.match(b.text):
                part = b.text.strip()
                continue
            title = f"{part} / {b.text.strip()}" if part else b.text.strip()
            current = {"title": title, "note": "", "blocks": []}
            sections.append(current)
            continue

        if current is None:
            current = {"title": part, "note": "", "blocks": []}
            sections.append(current)

        if b.type is BlockType.SECTION_NOTE:
            current["note"] = (current["note"] + " " + b.text).strip()
            continue
        current["blocks"].append(b)

    return [s for s in sections if s["blocks"]]
