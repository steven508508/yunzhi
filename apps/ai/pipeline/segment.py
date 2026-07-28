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
from dataclasses import dataclass, field
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
#:
#: 光看「說明：」開頭是不夠的——講義的教學說明也長這樣
#: （「說明： 如右圖，設 P（x﹐y）為直線 L 上任意點。」）。
#: 兩者的差別在於試卷的節說明**一定會交代題號範圍或計分規則**，
#: 那正是下游要拿來推定題型與配分的東西。沒有那些就不是節說明。
_SECTION_NOTE = re.compile(
    rf"^\s*說\s*明\s*[：:].*?(?:"
    rf"第\s*[{_D}]+\s*題"
    rf"|[{_D}]+\s*分"
    rf"|選項"
    rf"|作答"
    rf"|答案[卡欄區]"
    rf")"
)

#: 「第 37 題至第 39 題為題組」「37-39 為題組」
#: 「請問 9～10 題」「請回答第 11 至 12 題」——講義的說法不一樣，
#: 它把題組指示語寫在共用敘述的**結尾**而不是獨立一行。
_GROUP_LEAD = re.compile(
    rf"(?:第?\s*[{_D}]+\s*(?:題)?\s*(?:至|[-－—~～])\s*第?\s*[{_D}]+\s*題?\s*為題組"
    rf"|請\s*(?:問|回?答|依據.{{0,12}}回答)\s*第?\s*[{_D}]+\s*(?:題)?\s*"
    rf"[至~～\-－—]\s*第?\s*[{_D}]+\s*題)"
)

#: 講義的單元標題：「考古題大搜查」「夯時事練非選」「好好練題」
#: 「綜合演練」「文法選擇」。
#:
#: 學測試卷的節標題是「一、單選題（占 30 分）」那種格式化的東西，
#: 講義則是編輯取的名字，形狀完全不同。認不出來的話，它會依
#: 「跟著前一塊」的規則被歸成選項或題幹，然後混進上一題的內容裡。
_WORKSHEET_SECTION = re.compile(
    r"^\s*[0-9０-９]?\s*(?:"
    r"考古題[大搜查練]*|夯時事[練習]*[^\s]{0,4}|好好[練做]題|綜合演練|實力養成"
    r"|牛刀小試|即時練習|學測.{0,4}演練|歷屆試題|試題演練|能力檢測"
    r"|文法選擇|字彙測驗|閱讀測驗|克漏字[測驗]*|翻譯練習"
    r")\s*(?:[：:].*)?$"
)

#: 非選題的作答格：「作答區」「作答欄」「答案欄」。
#: 那是給學生寫字的空白，不是題目內容——當成表格抽取的話，
#: 題庫裡會多出一堆內容為空的欄位。
_ANSWER_AREA = re.compile(r"^\s*(?:作答[區欄格]|答案[區欄格]|請於下方作答)\s*$")

#: 作答括號。英文與社會的講義把它印在題號**前面**：
#:
#:     (  ) 6. It was on Sep. 21, 1999 ______ a big earthquake hit Taiwan.
#:     ( C ) 7. To win the game, all the players have to cooperate with ______.
#:
#: 學生版是空的，教用版裡面就是**印出來的答案**。
#:
#: 沒有這一條的話，英文講義的每一題都會被判成題幹（實測那一頁
#: 20 題全部漏掉），整頁變成一團沒有結構的文字。數學講義從來
#: 不用這個體例，所以先前完全沒有暴露出來——這是五科都要做的
#: 系統只拿一科的教材驗證會遇到的典型問題。
#:
#: **但這個形狀與選項只差一點點**，而認錯的代價很大：
#:
#:     (A) 4.5 公尺      ← 選項。認錯的話這一題少一個選項，
#:                          而且「A」會被當成印出來的標準答案
#:     ( C ) 7. To win…  ← 題號
#:
#: 所以加了兩道限制：
#:
#:   · 括號裡**要嘛是空的**（學生版，選項不可能沒有編號），
#:     **要嘛編號前後有空白**（`( C )` 而不是 `(C)`）。
#:   · 句點後面**不可以緊接數字**——`4.5` 是小數，`6. It` 是題號。
#:     小數點後不會有空白，題號後會，這一點可以分得乾淨。
#:
#: 代價是排版成 `(C)7.` 這種沒有空白的教用版會漏掉，那一題會被
#: 判成選項——與加這條規則之前的行為相同，不會更糟。**寧可漏，
#: 不可錯**：漏掉的題目校對時看得見，憑空生出來的答案看不見。
_PAREN_PREFIX = (
    rf"{_LP}(?:\s+[A-EＡ-Ｅ①-⑩{_D}]\s+|\s*){_RP}\s*"
)
_NUMBER_HEAD = rf"[{_D}]{{1,3}}\s*(?:[.．](?![0-9])|[、·])"

_ANSWER_PAREN = re.compile(
    rf"^\s*{_LP}(?:\s+([A-EＡ-Ｅ①-⑩{_D}])\s+|(\s*)){_RP}\s*(?={_NUMBER_HEAD})"
)

#: 題號。「1.」「12、」「１．」「(3)」都算，前面可以有作答括號。
#:
#: **分隔標點是必要的，不是可選的。** 少了這個限制，數學講義裡
#: 每個以數字開頭的算式片段（分數的分母「2 ，如圖」、「1 ＝－4」）
#: 都會被當成題號——實測一份 29 頁的講義會抽出 419 個假題號，
#: 而真正的題目只有 24 個。
_QUESTION_NO = re.compile(
    rf"^\s*(?:{_PAREN_PREFIX})?"               # 作答括號（可省略）
    rf"(?:"
    rf"{_LP}\s*[{_D}]{{1,3}}\s*{_RP}"          # (3) （12）
    rf"|{_NUMBER_HEAD}"                        # 1. 12、
    rf")\s*(?=\S)"
)


def answer_in_paren(text: str) -> str | None:
    """
    取出教用版印在作答括號裡的答案：`( C ) 7. …` → `C`。

    這是**零成本**拿到答案的路徑，比 AI 自答便宜也可靠得多。
    空括號（學生版）回 None——不猜。憑空生出一個答案會被當成
    標準答案拿去改學生的卷子，那是這整條管線最不能犯的錯。
    """
    m = _ANSWER_PAREN.match(text)
    if not m:
        return None
    inner = (m.group(1) or "").strip()
    return inner or None

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


# ─────────────────────────────────────────────────────────────────
# 講義體例
#
# 補習班日常用的是講義而不是學測試卷。翰林、南一、龍騰的講義結構
# 高度一致：觀念條列 → 範例 → 解 → 類題 → 解 → 習題。
#
# 這套體例與學測試卷幾乎沒有重疊——講義沒有「一、單選題（占 30 分）」，
# 試卷沒有「範例 1」。所以兩套規則可以並存而不互相干擾，
# 不需要先判斷文件類型再選規則。
# ─────────────────────────────────────────────────────────────────

#: 「範例 1」「類題」「類題２」「習題」「隨堂練習」
#: 這是講義裡的**題目邊界**——一個範例加它底下的解，就是一個題目單位。
_EXERCISE = re.compile(
    rf"^\s*(範例|類題|例題|習題|隨堂練習|練習題|綜合練習|自我評量|精選題)"
    rf"\s*[{_D}１-９]{{0,3}}\s*$"
)

#: 教用版直接印出答案：「答：　(B)」「答：　y＝2x－1」
_ANSWER_KEY = re.compile(r"^\s*答\s*[：:]")

#: 詳解的起始。講義用單獨一個「解」字，不像試卷會寫「【詳解】」。
_SOLUTION = re.compile(r"^\s*解\s*[：:]?\s*$|^\s*解\s+")

#: 教學說明與註記。這些是課本內容，不是題目——混進題幹會很難看，
#: 而且它們的著作權地位與試題不同（試題不受保護，說明文字受保護）。
_TEACHING = re.compile(r"^\s*(說\s*明|註|提示|想法|作法|觀念|補充|延伸)\s*[：:]")

#: 觀念條列：「1. 點斜式：」「2. 兩點式：」
#: 與題號長得很像，靠**結尾的冒號**區分——題目不會以冒號結尾。
_CONCEPT_ITEM = re.compile(rf"^\s*[{_D}]{{1,2}}\s*[.、．]\s*\S{{1,20}}\s*[：:]\s*$")

#: 講義與課本的對應標記：「◎ 搭配課本 P.160～P.163」「★ 搭配課本例題 1」
#: 這是排版元素，對題目內容沒有貢獻。
_CROSSREF = re.compile(r"^\s*[◎★☆●※]\s*搭配")


# ─────────────────────────────────────────────────────────────────
# 出處與全國答對率
#
# 社會科與英文的講義在每一道考古題旁邊印兩個小標籤：出處（「112學測」）
# 與**全國答對率**（「答對率 43%」）。它們看起來只是版面裝飾，實際上
# 是這整個系統拿得到的**最有價值的一筆資料**：
#
#   · 答對率是大考中心的實測難度，比任何模型估的 difficulty 都準。
#     沒有它，一道新題目要等我們自己的學生作答幾百次才知道難不難；
#     有它，題目一入庫就有校準過的難度。
#   · 它讓能力分析能說「你這題錯了，但全國有 73% 的人也錯」，
#     而不是只給一個分數。訪談時老師抱怨的就是現有系統「分析很淺」。
#
# 抓法用規則而非模型：這兩個標籤的格式非常固定，規則抓得準又免費。
# ─────────────────────────────────────────────────────────────────

#: 「112學測」「115學測」「110指考」「113分科」
_SOURCE_EXAM = re.compile(r"(1[0-2][0-9])\s*(學測|指考|分科|統測|會考)")

#: 「答對率 95%」「[答對率 39%]」「答對率：43％」
_CORRECT_RATE = re.compile(r"答對率\s*[：:]?\s*([0-9]{1,3})\s*[%％]")


@dataclass
class Provenance:
    """題目旁邊印的出處與全國答對率。"""

    exam: str | None = None            # 「112學測」
    correct_rate: float | None = None  # 0–1

    def __bool__(self) -> bool:
        return self.exam is not None or self.correct_rate is not None


#: 標籤與標籤之間、標籤與文字結尾之間允許出現的東西：空白、
#: 括號、分隔符號。除此之外就不是標籤區了。
_BADGE_FILLER = re.compile(r"[\s\[\]\(\)（）【】｜|,，、／/·．.:：-]*$")


def extract_provenance(text: str) -> tuple[Provenance, str]:
    """
    抽出出處與答對率，回傳 (資料, 拿掉標籤後的文字)。

    標籤要從題幹拿掉——它是版面元素不是題目內容，留著會讓
    重複題偵測把「同一題但年份標籤不同」看成兩題，也會讓學生
    在作答時看到「答對率 27%」而先入為主。

    **但兩個標籤都不能見到就抓**，因為兩者都可能是題目在講的事：

        自 108 學測起，社會科加考混合題型，下列敘述何者正確？
        已知該次測驗全班答對率 43%，共 40 人應試，求答對人數。

    抓掉之後句子仍然通順——「自 起，社會科加考…」——校對介面上
    看不出來，而題目已經壞了。第二個例子更糟：那個 43% 會被當成
    大考中心的實測難度寫進題庫，而 schema 明寫這一欄「編出來的
    數字混進去就再也分不出真假」。

    所以判準不是「位置接近」而是**版面事實**：這兩個標籤印在題目
    末端的一串圓角色塊裡，所以它們一定構成文字**結尾的一段連續
    標籤區**（中間只隔空白、括號、分隔符）。從尾端往前一個一個
    剝，剝不動就停——中間出現的一律視為內容。
    """
    prov = Provenance()
    head = text
    spans: list[tuple[int, int]] = []

    while True:
        stripped = _BADGE_FILLER.sub("", head)
        m = _CORRECT_RATE.search(stripped)
        if m and m.end() == len(stripped) and 0 <= int(m.group(1)) <= 100:
            if prov.correct_rate is None:
                prov.correct_rate = int(m.group(1)) / 100
            spans.append((m.start(), len(head)))
            head = stripped[: m.start()]
            continue

        m = _SOURCE_EXAM.search(stripped)
        if m and m.end() == len(stripped):
            if prov.exam is None:
                prov.exam = f"{m.group(1)}{m.group(2)}"
            spans.append((m.start(), len(head)))
            head = stripped[: m.start()]
            continue
        break

    if not spans:
        return prov, text

    # 標籤常被方括號或全形括號包著。剝掉標籤之後左括號會落單，
    # 留著會變成「…面積約多少？（」這種看起來像抽壞了的題幹。
    cleaned = re.sub(r"[\[\(（【]\s*$", "", head)
    cleaned = re.sub(r"[\[\(（【]\s*[\]\)）】]", "", cleaned)
    return prov, re.sub(r"[ \t　]{2,}", " ", cleaned).strip()


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

    # 講義體例先判。它們的特徵最明確（單一個「解」字、「答：」開頭），
    # 而且若讓題號規則先攔，「答：　(B)」會被當成一般題幹。
    if _EXERCISE.match(t):
        return BlockType.EXERCISE_HEADER
    if _ANSWER_KEY.match(t):
        return BlockType.ANSWER_KEY
    if _SOLUTION.match(t):
        return BlockType.EXPLANATION
    if _CROSSREF.match(t):
        return BlockType.HEADER_FOOTER
    # 節說明要排在教學說明之前：兩者都以「說明：」開頭，
    # 而節說明的判準比較嚴（必須交代題號範圍或計分）。
    if _SECTION_NOTE.match(t):
        return BlockType.SECTION_NOTE
    if _TEACHING.match(t):
        return BlockType.TEACHING_NOTE
    if _CONCEPT_ITEM.match(t):
        return BlockType.CONCEPT

    if _EXPLANATION.match(t):
        return BlockType.EXPLANATION
    if _HEADER_FOOTER.match(t):
        return BlockType.HEADER_FOOTER
    # 題組指示語在試卷裡自成一行、在講義裡黏在共用敘述的結尾，
    # 所以整塊都要找，不能只看開頭。
    if _GROUP_LEAD.search(t):
        return BlockType.GROUP_LEAD
    if _SECTION_HEADER.match(t) or _WORKSHEET_SECTION.match(t):
        return BlockType.SECTION_HEADER
    if _ANSWER_AREA.match(t) or _ANSWER_ROW.search(t):
        return BlockType.ANSWER_AREA
    # 子題編號要排在選項之前判。兩者的形狀很像，而混合題子題
    # 被誤判成選項是會靜默壞掉的那種錯。
    if _SUB_LABEL.match(t):
        return BlockType.STEM  # 混合題子題，題幹的一種
    # 教用版的作答括號也要排在選項之前：`( C ) 7. To win…` 的開頭
    # 與選項 `(C) themselves` 只差在括號後面接的是不是「數字＋標點」。
    # 判成選項的話，整道題會被當成前一題的第五個選項。
    if _ANSWER_PAREN.match(t):
        return BlockType.QUESTION_NO
    if _OPTION.match(t):
        return BlockType.OPTION
    if _QUESTION_NO.match(t):
        return BlockType.QUESTION_NO

    # 都不像的話，看前一塊：選項後面接的通常還是選項的續行，
    # 題幹後面接的還是題幹。這比一律歸成 STEM 準得多。
    if prev in (BlockType.OPTION, BlockType.STEM, BlockType.QUESTION_NO):
        return prev
    return BlockType.STEM


def segment_native(
    page_index: int,
    text_blocks: list[dict],
    answer_ink: str | None = None,
    running_heads: set[str] | None = None,
) -> SegmentResult:
    """
    原生 PDF 的切分。純程式，零成本。

    text_blocks 由 normalize._text_blocks 產出，已經是閱讀順序、
    bbox 已正規化為 0–1 比例。

    answer_ink 是教用版的答案墨色（detect_answer_ink 的結果）。
    有它的話，「哪些是題目、哪些是詳解」就不必靠猜字——顏色是
    排版時就決定好的事實。
    """
    blocks: list[LayoutBlock] = []
    prev: BlockType | None = None

    for b in split_embedded_headers(text_blocks):
        raw = (b.get("text") or "").strip()
        if not raw:
            continue

        # 重複出現在頁緣的文字＝頁首頁尾，直接歸類，不進後面的判斷。
        if running_heads and _running_key(raw) in running_heads:
            blocks.append(
                LayoutBlock(
                    type=BlockType.HEADER_FOOTER, bbox=_bbox_of(b, page_index), text=raw
                )
            )
            continue

        answers: list[str] = []
        text = raw
        if answer_ink:
            student, answers = strip_answer_ink(b, answer_ink)
            # 整塊都是答案墨色 → 這是詳解或答案，不是題目
            if not student and answers:
                joined = " ".join(answers)
                bt = (
                    BlockType.ANSWER_KEY
                    if _ANSWER_KEY.match(joined)
                    else BlockType.EXPLANATION
                )
                blocks.append(
                    LayoutBlock(
                        type=bt,
                        bbox=_bbox_of(b, page_index),
                        text=joined,
                        answers=answers,
                    )
                )
                continue
            text = student or raw

        bt = _classify(text, prev)
        # 教用版把答案印在題號前的括號裡（`( C ) 7. …`）。這是零成本
        # 拿到答案的路徑，比 AI 自答便宜也可靠得多。有顏色資訊時
        # 顏色優先——顏色是排版時就決定好的事實，不需要任何推論。
        if not answers and (paren := answer_in_paren(text)):
            answers = [paren]
        blocks.append(
            LayoutBlock(
                type=bt, bbox=_bbox_of(b, page_index), text=text, answers=answers
            )
        )
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


#: 黏在區塊尾巴的題目標頭。
#:
#: 排版時「範例 1」是一個色塊標籤，而 PDF 的文字區塊會把同一行的
#: 東西併成一塊，於是抽出來變成「三點共線（斜率相等）★搭配課本習題 2範例3」。
#: 沒拆開的話這一塊不會被認成標頭，整份講義的題目邊界就全部錯開一格——
#: 每一題都拿到上一題的尾巴，而題幹的開頭掉進上一題的詳解裡。
#:
#: 只比對**結尾**：中間出現的「習題」多半是「搭配課本習題 2」這種
#: 交叉參照，不是標頭。
#:
#: 前面緊接著「搭配」「課本」「參見」的不算標頭——那是交叉參照
#: （「★ 搭配課本習題 2」指的是課本裡的第 2 題，不是本頁的習題）。
_TRAILING_HEADER = re.compile(
    rf"^(?P<before>.*?\S)\s*"
    rf"(?<!搭配)(?<!課本)(?<!參見)(?<!見)"
    rf"(?P<header>(?:範例|類題|例題|習題|隨堂練習|練習題|綜合練習)\s*[{_D}]{{0,3}})\s*$"
)

#: 黏在區塊開頭的題目標頭。
#:
#: 標頭在版面上是一個色塊標籤，位置在該行的最左邊，所以只要行的
#: 重組是對的（見 mathlayout），它就會出現在開頭而不是結尾。
#: 兩種都要處理：文字重組前後、以及不同排版工具，位置都可能不同。
_LEADING_HEADER = re.compile(
    rf"^\s*(?P<header>(?:範例|類題|例題|習題|隨堂練習|練習題|綜合練習)\s*[{_D}]{{0,3}})"
    rf"\s*(?P<after>\S.*)$"
)


def split_embedded_headers(text_blocks: list[dict]) -> list[dict]:
    """把尾巴黏著題目標頭的區塊拆成兩塊。在分類之前做。"""
    out: list[dict] = []
    for b in text_blocks:
        text = (b.get("text") or "").strip()
        if not text:
            out.append(b)
            continue

        lead = _LEADING_HEADER.match(text)
        if lead and len(lead.group("after")) >= 2:
            out.extend(_cut(b, lead.group("header"), lead.group("after"), header_first=True))
            continue

        m = _TRAILING_HEADER.match(text)
        if not m or len(m.group("before")) < 2:
            out.append(b)
            continue

        bb = b["bbox"]
        # 標頭在版面上位於這一行的左側（它是個標籤），所以給它
        # 一個靠左的窄框。座標只影響校對介面的連動，精確度足夠。
        width = bb["x1"] - bb["x0"]
        out.append(
            {
                **b,
                "text": m.group("before"),
                "bbox": {**bb, "x0": min(1.0, bb["x0"] + width * 0.2)},
                "runs": None,
            }
        )
        out.append(
            {
                **b,
                "text": m.group("header"),
                "bbox": {**bb, "x1": min(1.0, bb["x0"] + width * 0.2)},
                "runs": None,
                "ink": None,
            }
        )
    return out


def _cut(b: dict, header: str, body: str, header_first: bool) -> list[dict]:
    """把一個區塊拆成標頭與內文兩塊，並各給一個合理的框。"""
    bb = b["bbox"]
    width = bb["x1"] - bb["x0"]
    split = min(1.0, bb["x0"] + width * 0.2)
    head_box = {**bb, "x1": split}
    body_box = {**bb, "x0": split}
    head = {**b, "text": header, "bbox": head_box, "runs": None, "ink": None}
    rest = {**b, "text": body, "bbox": body_box, "runs": None}
    return [head, rest] if header_first else [rest, head]


def _bbox_of(b: dict, page_index: int) -> BBox:
    bb = b["bbox"]
    try:
        return BBox(page=page_index, x0=bb["x0"], y0=bb["y0"], x1=bb["x1"], y1=bb["y1"])
    except Exception:
        # 退化的 bbox（零寬或零高）。內容仍然有用，座標放棄——
        # 只會失去校對介面的連動，不該讓整頁失敗。
        return BBox(page=page_index, x0=0.0, y0=0.0, x1=1.0, y1=1.0)


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


# ─────────────────────────────────────────────────────────────────
# 講義的切題
#
# 學測試卷靠「節」切（split_by_section），講義靠「範例／類題／習題」切。
# 兩者的差別不只是分隔符不同：
#
#   試卷的一題 = 題號 ＋ 題幹 ＋ 選項
#   講義的一題 = 標頭 ＋ 題幹 ＋ **解** ＋ **答**
#
# 多出來的那兩塊是這個系統最想要的東西（訪談第 2 題的痛點就是
# 「解析不足」），但它們的著作權地位與試題完全不同——
# 試題依著作權法第 9 條不受保護，詳解受保護。所以切出來之後
# 必須分開存、分開標權利，不能混進題幹。
# ─────────────────────────────────────────────────────────────────


@dataclass
class ExerciseUnit:
    """講義裡的一個題目單位。"""

    label: str                      # 「範例 1」「類題 2」
    stem: list[LayoutBlock] = field(default_factory=list)
    explanation: list[LayoutBlock] = field(default_factory=list)
    answer: str = ""                # 教用版印出來的答案
    notes: list[LayoutBlock] = field(default_factory=list)
    page: int = 0

    def stem_text(self) -> str:
        return blocks_to_text(self.stem)

    def explanation_text(self) -> str:
        return "\n".join(b.text for b in self.explanation)

    def inline_answers(self) -> list[str]:
        """
        題幹裡被填掉的空格答案，**以顏色為準**。

        教用版把答案印成另一個顏色，segment_native 已經據此把每個
        區塊拆成「學生看到的」與「答案」。這裡只是把題幹區塊的
        答案收集起來——沒有任何猜測，所以學生版自然是空的。
        """
        return [a for b in self.stem for a in b.answers]

    def provenance(self) -> Provenance:
        """本題旁邊印的出處與全國答對率。"""
        merged = Provenance()
        for b in self.stem:
            prov, _ = extract_provenance(b.text)
            merged.exam = merged.exam or prov.exam
            if merged.correct_rate is None:
                merged.correct_rate = prov.correct_rate
        return merged

    def clean_stem_text(self) -> str:
        """拿掉出處標籤之後的題幹——學生看到的就是這個。"""
        _, cleaned = extract_provenance(self.stem_text())
        return cleaned


def split_by_exercise(blocks: list[LayoutBlock]) -> list[ExerciseUnit]:
    """
    依「範例／類題／習題」把講義切成題目單位。

    切完之後每個單位裡的區塊再分三類：題幹、詳解、註記。
    分界是 EXPLANATION 區塊——它之後的東西都算詳解，
    直到下一個標頭為止。
    """
    units: list[ExerciseUnit] = []
    current: ExerciseUnit | None = None
    in_solution = False

    for b in blocks:
        if b.type is BlockType.HEADER_FOOTER:
            continue

        if b.type is BlockType.EXERCISE_HEADER:
            carried = _pull_back(current)
            current = ExerciseUnit(label=b.text.strip(), page=b.bbox.page, stem=carried)
            units.append(current)
            in_solution = False
            continue

        if current is None:
            continue  # 標頭之前的觀念條列不屬於任何題目

        if b.type is BlockType.EXPLANATION:
            in_solution = True
            # 「解 連線 AB 的斜率…」這種：後面接著內容，要留下來
            body = _SOLUTION.sub("", b.text, count=1).strip()
            if body:
                current.explanation.append(
                    LayoutBlock(type=b.type, bbox=b.bbox, text=body)
                )
            continue

        if b.type is BlockType.ANSWER_KEY:
            # 教用版把「答：」印成白字色塊、答案本身印成答案墨色，
            # 於是 text 只剩「答：」而答案在 answers 裡。優先取後者。
            raw = " ".join(b.answers) if b.answers else b.text
            current.answer = re.sub(
                r"^\s*答\s*[：:]\s*|[\s　。]+$", "", raw
            ).strip()
            continue

        if b.type is BlockType.TEACHING_NOTE:
            current.notes.append(b)
            continue

        (current.explanation if in_solution else current.stem).append(b)

    # 沒有題幹的單位多半是切錯（例如頁尾剛好有個「類題」字樣）
    return [u for u in units if u.stem]


def _pull_back(prev: "ExerciseUnit | None") -> list[LayoutBlock]:
    """
    把誤放進上一題詳解裡的題幹搬回來。

    為什麼會誤放：「類題」是一個色塊標籤，排版時它的垂直位置對齊的是
    題幹的**第二行**，而題幹的第一行在它上面。於是閱讀順序是
    「題幹第一行 → 類題標籤 → 題幹第二行」，第一行就掉進上一題了。

    判準用顏色而不是文意：教用版的詳解一律印成答案墨色，所以
    **詳解區段裡出現的黑字區塊，一定是下一題的題幹**。這個判準
    不依賴任何語意猜測，錯不了。

    學生版沒有顏色可分（詳解本身就不在同一份檔案裡），這時
    prev.explanation 會是空的，自然不會誤搬。
    """
    if prev is None or not prev.explanation:
        return []

    carried: list[LayoutBlock] = []
    while prev.explanation and prev.explanation[-1].type not in (
        BlockType.EXPLANATION,
        BlockType.ANSWER_KEY,
    ):
        carried.insert(0, prev.explanation.pop())
    return carried


#: 試卷型與講義型各自的特徵區塊。用它們的相對數量判斷文件性質。
_EXAM_MARKS = (BlockType.SECTION_HEADER, BlockType.SECTION_NOTE, BlockType.GROUP_LEAD)
_SHEET_MARKS = (BlockType.EXERCISE_HEADER, BlockType.ANSWER_KEY, BlockType.CONCEPT)


def detect_genre(blocks: list[LayoutBlock]) -> str:
    """
    判斷這份文件是試卷還是講義。

    下游的提示詞要據此調整：試卷要抽「第幾題、幾分」，講義要抽
    「這是範例還是類題、詳解在哪」。用同一套提示詞處理兩種文件，
    結果會是兩邊都做得普通。

    判斷不出來時回 "unknown"，下游就用比較保守的通用提示詞。
    """
    exam = sum(1 for b in blocks if b.type in _EXAM_MARKS)
    sheet = sum(1 for b in blocks if b.type in _SHEET_MARKS)
    if sheet >= 3 and sheet > exam:
        return "worksheet"
    if exam >= 2 and exam >= sheet:
        return "exam"
    return "unknown"


#: 教用版的填空答案（文字啟發式）。
#:
#: **優先用顏色**（ExerciseUnit.inline_answers）。這個函式是給
#: 「答案印成黑色、與題目同色」的教用版用的退路，而它天生不可靠：
#: 全形空白在數學排版裡也拿來當一般間隔，光靠配對會把
#: 「∴斜率 m1＝」這種東西當成答案。
#:
#: 所以加了一個限制：空格前面必須是「＝為是：⇒得」之一，
#: 也就是**答案該出現的位置**。實測一份學生版講義，
#: 不加這個限制會抽出 21 個假答案，加了之後降到個位數。
_ANSWER_POSITION = "＝=為是：:⇒得"
_BLANK_DELIM = "\u3000"  # 全形空白


def extract_inline_answers(text: str) -> list[str]:
    """
    抽出教用版填在空格裡的答案（沒有顏色資訊時的退路）。

    把全形空白當成成對的分隔符，取奇數段。**不用正則**——
    正則的非貪婪比對在空白格（連續兩個分隔符）上會跨過邊界，
    把「，m2＝」當成答案抽出來。分段取奇數位天然沒有這個問題：

        教用版  則 m1＝　1　，m2＝　－4　。
                 → ['則 m1＝', '1', '，m2＝', '－4', '。']  奇數段 = 答案
        學生版  則 m1＝　　，m2＝　　。
                 → ['則 m1＝', '', '，m2＝', '', '。']      奇數段全是空的

    學生版不會產生假答案，這一點很重要：假答案會被當成標準答案
    入庫，然後拿去改學生的考卷。
    """
    parts = text.split(_BLANK_DELIM)
    out = []
    for i in range(1, len(parts), 2):
        v = parts[i].strip()
        if not v or re.fullmatch(r"[，、。：；．,.:;]+", v):
            continue
        # 前一段的結尾要是「答案該出現的位置」
        before = parts[i - 1].rstrip()
        if not before or before[-1] not in _ANSWER_POSITION:
            continue
        out.append(v)
    return out


# ─────────────────────────────────────────────────────────────────
# 教用版的答案墨色
#
# 教用版講義把答案與詳解印成另一個顏色（實測翰林兩份講義分別是
# #EC008C 與 #E4007F——同一家出版社不同章節都不完全一樣，所以
# 不能寫死顏色值，只能偵測）。
#
# 這是分離「試題」與「解析」**最可靠的訊號**——比任何文字特徵都準，
# 因為它是排版時就決定的，不依賴我們猜對「解」字在哪。
#
# 為什麼這件事重要：試題依著作權法第 9 條不受保護，詳解受保護
# （文件 16 §3）。兩者混在一起入庫，等於把一份受保護的內容
# 標成不受保護——那是這個系統最不該犯的錯。
#
# 附帶的好處是，同一份教用版可以同時產出學生版：黑字是題目，
# 答案墨色是解答，各自存到該去的地方。
# ─────────────────────────────────────────────────────────────────

#: 答案墨色至少要佔多少比例的文字。低於此值多半只是強調用色。
_INK_MIN_SHARE = 0.15
#: 判定「有顏色」的門檻。灰階（頁首頁尾、淡色說明）不算。
_INK_MIN_CHROMA = 60


def _chroma(hex_color: str) -> int:
    try:
        v = int(hex_color, 16)
    except ValueError:
        return 0
    r, g, b = (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF
    return abs(r - g) + abs(g - b) + abs(r - b)


def detect_answer_ink(page_blocks: list[list[dict]]) -> str | None:
    """
    找出教用版的答案墨色。回傳色碼，或 None 表示這不是教用版。

    判準有三個，缺一不可：
      1. 有彩度（灰階的是頁首頁尾與淡色說明，不是答案）
      2. 佔全文一定比例（零星的強調用色不算）
      3. **「解」「答」開頭的區塊確實是這個顏色**

    第三點是關鍵的確認。少了它，一份用藍色標題的學生版講義會被
    誤判成教用版，接著整批標題會被當成答案抽走——而那種錯誤
    在校對介面上看起來只是「題目怎麼少了標題」，很難聯想到原因。
    """
    total = 0
    tally: dict[str, int] = {}
    marker_ink: dict[str, int] = {}

    for blocks in page_blocks:
        for b in blocks:
            ink = b.get("ink")
            n = len(b.get("text", "").strip())
            if not ink or not n:
                continue
            total += n
            tally[ink] = tally.get(ink, 0) + n
            head = b["text"].lstrip()[:2]
            if head.startswith("解") or head.startswith("答"):
                marker_ink[ink] = marker_ink.get(ink, 0) + 1

    if not total:
        return None

    candidates = [
        (n, ink)
        for ink, n in tally.items()
        if _chroma(ink) >= _INK_MIN_CHROMA and n / total >= _INK_MIN_SHARE
    ]
    if not candidates:
        return None

    _, ink = max(candidates)
    # 確認：解答標記確實印成這個顏色
    if marker_ink.get(ink, 0) < 2:
        return None
    return ink


def strip_answer_ink(block: dict, ink: str) -> tuple[str, list[str]]:
    """
    把一個區塊拆成「學生看到的」與「答案」。

    回傳 (學生版文字, 答案片段清單)。整塊都是答案墨色時，
    學生版是空的——那就是一個純詳解區塊。

    這比用全形空白配對可靠得多：數學排版裡全形空白也拿來當
    一般間隔，配對法會把「∴斜率 m1＝」這種東西當成答案抽出來。
    顏色不會有這個問題。
    """
    runs = block.get("runs")
    if not runs:
        # 單色區塊：整塊歸給其中一邊
        text = block.get("text", "")
        return ("", [text]) if block.get("ink") == ink else (text, [])

    student, answers = [], []
    for run_ink, text in runs:
        (answers if run_ink == ink else student).append(text)

    return (
        re.sub(r"\s{2,}", " ", "".join(student)).strip(),
        [a.strip() for a in answers if a.strip()],
    )


# ─────────────────────────────────────────────────────────────────
# 頁首頁尾
#
# 用重複偵測而不是正則。理由是正則永遠追不完：
#   學測試卷   「第 2 頁，共 8 頁」
#   翰林講義   「162　互動式教學講義‧數學（1）」「4-1 直線方程式及其圖形　163」
#   南一、龍騰 又是別的寫法
#
# 而它們有一個共同的、與出版社無關的特徵：**同樣的文字出現在
# 大多數頁面的同一個位置**。這個特徵抓得到所有寫法，也不會誤傷
# 只出現一兩次的真實內容。
# ─────────────────────────────────────────────────────────────────

#: 頁首頁尾所在的帶。超出這個範圍的重複文字是真的重複內容。
_MARGIN_BAND = 0.08
#: 要在多少比例的頁面出現才算頁首頁尾。
_RUNNING_SHARE = 0.4
#: 至少要有這麼多頁才做這個判斷。三頁的文件談不上「重複」。
_MIN_PAGES = 4


def _running_key(text: str) -> str:
    """去掉頁碼後的骨架。頁首頁尾的文字每頁都差一個數字。"""
    return re.sub(rf"[{_D}\s　]+", "", text)[:40]


def detect_running_heads(page_blocks: list[list[dict]]) -> set[str]:
    """找出重複出現在頁緣的文字骨架。"""
    if len(page_blocks) < _MIN_PAGES:
        return set()

    seen: dict[str, set[int]] = {}
    for pno, blocks in enumerate(page_blocks):
        for b in blocks:
            bb = b.get("bbox") or {}
            y0, y1 = bb.get("y0", 0.5), bb.get("y1", 0.5)
            if y1 > _MARGIN_BAND and y0 < 1 - _MARGIN_BAND:
                continue  # 不在頁緣
            key = _running_key(b.get("text", ""))
            if len(key) < 2:
                continue
            seen.setdefault(key, set()).add(pno)

    threshold = max(2, int(len(page_blocks) * _RUNNING_SHARE))
    return {k for k, pages in seen.items() if len(pages) >= threshold}
