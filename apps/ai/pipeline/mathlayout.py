"""
從版面幾何還原數學式。

## 問題

PDF 沒有「分數」這個概念。排版軟體畫的是：分子放上面、分母放下面、
中間畫一條線。抽文字的時候拿到的是三段互不相干的字串：

    m＝            ← 主行
    －5－2         ← 分子（基線高 7.4pt）
    －3－（－1）    ← 分母（基線低 7.4pt）

而且 PyMuPDF 會把它們切成**四個不同的文字區塊**（實測：主行一塊、
每個分數各一塊）。下游看到的是一堆看不出關係的碎片，
而 `－3－（－1）＝－7` 這種單獨一塊的東西是沒有意義的。

上下標同理：`x²` 是一個小一號、基線抬高的 `2`，抽出來就是 `x2`。
線段記號 `AB` 上面那條線是一條獨立的繪圖物件。

## 做法

**全部從幾何重建，不問模型。**

一條細長的水平線，它的意義完全由「上下有沒有字」決定：

    上下都有字  → 分數線     \\frac{上}{下}
    只有下面有  → 上劃線     \\overline{下}（線段、直線、循環小數）
    只有上面有  → 底線       填空題的作答線
    都沒有      → 表格框線或裝飾

這個判準與出版社無關，因為它來自排版的物理事實。字級與基線的
偏移量同理：上標一定比本文小且高，這是排版的定義而不是慣例。

用模型做這件事既貴又不可靠——模型看到 `－3－（－1）＝－7` 只能猜，
而幾何資訊是精確的。**能用程式做的就不要用 AI。**
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

import fitz

log = logging.getLogger("yunzhi.ai.mathlayout")


# ─────────────────────────────────────────────────────────────────
# 幾何門檻
#
# 全部以字級（em）為單位而不是絕對點數：講義的字級從 7pt 到 14pt
# 都有，寫死點數會在某一種字級上失準。
# ─────────────────────────────────────────────────────────────────

#: 細線的最大厚度（點）。分數線與上劃線都是 0～1pt。
_RULE_MAX_THICK = 1.6
#: 細線的最小長度（點）。太短的是標點或裝飾。
_RULE_MIN_WIDTH = 3.5
#: 分子／分母離分數線的最大距離（em）。實測約 0.4–0.8em。
_FRAC_REACH = 1.35
#: 上劃線離字的最大距離（em）。
_OVERLINE_REACH = 1.2
#: 上下標的字級比例上限。實測 7.02/12.05 = 0.58。
_SCRIPT_SIZE = 0.8
#: 上標的基線抬升下限（em，相對本文字級）。實測 5.90/12.05 = 0.49。
#: 訂在 0.25 能收進各種字級，又不會誤收「◎」這種本來就偏高的符號
#: （實測 1.42/9.92 = 0.14）。
_SUPER_RISE = 0.25
#: 下標的基線下沉下限（em）。下標的位移比上標小，門檻也低一點。
_SUB_DROP = 0.12
#: 同一視覺行的基線容差（em）。
_LINE_TOL = 0.45


@dataclass
class Frag:
    """一個字元，或一個已經組好的數學結構。"""

    text: str
    x0: float
    x1: float
    base: float
    size: float
    ink: str = "000000"
    font: str = ""
    #: 已組成的結構（分數、上劃線）不再參與上下標判斷
    composed: bool = False
    #: 這個字元原本屬於 PyMuPDF 的哪一個區塊。重組之後要靠它把
    #: 視覺行放回原本的段落——見 group_blocks 的說明。
    src: int = -1

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2


@dataclass
class Rule:
    """一條細長的水平線。"""

    x0: float
    x1: float
    y: float
    role: str = "unknown"  # frac | overline | underline | none

    @property
    def width(self) -> float:
        return self.x1 - self.x0


@dataclass
class PageMath:
    blocks: list[dict] = field(default_factory=list)
    fractions: int = 0
    overlines: int = 0
    scripts: int = 0
    blanks: list[tuple[float, float, float]] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────
# 擷取
# ─────────────────────────────────────────────────────────────────


def _collect_chars(page: fitz.Page, translate) -> list[Frag]:
    out: list[Frag] = []
    for bi, block in enumerate(page.get_text("rawdict").get("blocks", [])):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                font = span.get("font", "")
                size = span.get("size", 0) or 0
                ink = f"{span.get('color', 0):06X}"
                for ch in span.get("chars", []):
                    c = ch["c"]
                    if not c.strip():
                        continue
                    if translate is not None:
                        mapped = translate(font, c)
                        if mapped is not None:
                            c = mapped
                    if not c:
                        continue  # 對應成空字串＝裝飾性字形，丟掉
                    x0, _, x1, _ = ch["bbox"]
                    out.append(
                        Frag(
                            text=c,
                            x0=x0,
                            x1=x1,
                            base=ch["origin"][1],
                            size=size,
                            ink=ink,
                            font=font.split("+")[-1],
                            src=bi,
                        )
                    )
    return out


def _collect_rules(page: fitz.Page) -> list[Rule]:
    """
    取出所有細長的水平線。

    只看外框，不看筆畫細節：分數線可能是 stroke、可能是填滿的細矩形，
    兩種在 get_drawings() 裡的 type 不同（'s' / 'f'），但外框都是
    「很寬、很扁」。用外框判斷對兩種都成立。
    """
    rules: list[Rule] = []
    for d in page.get_drawings():
        r = d["rect"]
        if r.height <= _RULE_MAX_THICK and r.width >= _RULE_MIN_WIDTH:
            rules.append(Rule(x0=r.x0, x1=r.x1, y=(r.y0 + r.y1) / 2))
    return rules


# ─────────────────────────────────────────────────────────────────
# 判定細線的角色
# ─────────────────────────────────────────────────────────────────


def _within(frag: Frag, rule: Rule, pad: float = 0.6) -> bool:
    """字元的水平中心是否落在線的範圍內（兩端各放寬一點）。"""
    return rule.x0 - pad <= frag.cx <= rule.x1 + pad


def classify_rules(rules: list[Rule], chars: list[Frag]) -> list[Rule]:
    """
    一條細線是分數線、上劃線、還是填空的底線，完全看它上下有沒有字。

    這是整個模組的核心判準。它不依賴任何出版社慣例，只依賴
    「分數的分子在線上、分母在線下」這個排版事實。
    """
    for rule in rules:
        above: list[Frag] = []
        below: list[Frag] = []
        for c in chars:
            if not _within(c, rule):
                continue
            em = c.size or 10.0
            # 基線在線上方 → 字在線上面（分子）
            if 0 < rule.y - c.base <= _FRAC_REACH * em:
                above.append(c)
            # 基線在線下方 → 字在線下面（分母，或被劃線的字）
            elif 0 < c.base - rule.y <= _FRAC_REACH * em:
                below.append(c)

        if above and below:
            rule.role = "frac"
        elif below:
            # 只有下面有字：可能是上劃線（線段 AB），也可能是
            # 這一行的底線裝飾。距離近才算上劃線。
            em = max(c.size for c in below) or 10.0
            nearest = min(c.base - rule.y for c in below)
            rule.role = "overline" if nearest <= _OVERLINE_REACH * em else "none"
        elif above:
            rule.role = "underline"  # 填空題的作答線
        else:
            rule.role = "none"
    return rules


# ─────────────────────────────────────────────────────────────────
# 組裝
# ─────────────────────────────────────────────────────────────────

#: 數學式裡的全形字元要換成半形，否則 LaTeX 排不出來。
#: 只在數學結構內部做，一般敘述的全形標點要保留。
_MATH_ASCII = str.maketrans(
    {
        "－": "-", "＋": "+", "＝": "=", "×": r"\times ", "÷": r"\div ",
        "（": "(", "）": ")", "［": "[", "］": "]", "｛": "{", "｝": "}",
        "，": ",", "﹐": ",", "．": ".", "／": "/", "＜": "<", "＞": ">",
        "≦": r"\le ", "≤": r"\le ", "≧": r"\ge ", "≥": r"\ge ",
        "≠": r"\ne ", "≒": r"\approx ", "≈": r"\approx ",
        "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
        "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
        "　": " ",
    }
)


def _math(text: str) -> str:
    return text.translate(_MATH_ASCII).strip()


def _wrap(text: str) -> str:
    """
    LaTeX 參數一律加大括號。

    單一字元其實可以省略（`\\frac72` 合法），但省略之後
    「命令的參數到哪裡結束」就要靠掃描器猜，而下游的 wrap_math
    與前端的 KaTeX 都得各自猜一次。一律加括號沒有壞處。
    """
    return "{" + text.strip() + "}"


def _majority_src(frags: list[Frag]) -> int:
    """一組字元裡出現最多次的來源區塊。"""
    tally: dict[int, int] = {}
    for f in frags:
        if f.src >= 0:
            tally[f.src] = tally.get(f.src, 0) + len(f.text)
    return max(tally, key=tally.get) if tally else -1


def build_fractions(chars: list[Frag], rules: list[Rule]) -> tuple[list[Frag], int]:
    """
    把分數組起來。由窄到寬處理，巢狀分數才會由內而外正確組合。

    組好的分數變成一個「虛擬字元」，佔據分數線的水平範圍、
    基線設在分數線上——這樣外層的分數線在找分子分母時就找得到它。
    """
    bars = sorted([r for r in rules if r.role == "frac"], key=lambda r: r.width)
    remaining = list(chars)
    made = 0

    for bar in bars:
        num: list[Frag] = []
        den: list[Frag] = []
        rest: list[Frag] = []
        for c in remaining:
            em = c.size or 10.0
            if _within(c, bar):
                if 0 < bar.y - c.base <= _FRAC_REACH * em:
                    num.append(c)
                    continue
                if 0 < c.base - bar.y <= _FRAC_REACH * em:
                    den.append(c)
                    continue
            rest.append(c)

        if not num or not den:
            # 上一輪的組合把其中一邊吃掉了。保守起見還原，
            # 寧可留下未組合的碎片，也不要造出半個分數。
            remaining = rest + num + den
            continue

        top = _render_inline(sorted(num, key=lambda f: f.x0))
        bottom = _render_inline(sorted(den, key=lambda f: f.x0))
        size = max((c.size for c in num + den), default=10.0)
        remaining = rest + [
            Frag(
                text=rf"\frac{_wrap(_math(top))}{_wrap(_math(bottom))}",
                x0=bar.x0,
                x1=bar.x1,
                base=bar.y,
                size=size,
                ink=(num[0].ink if num else "000000"),
                composed=True,
                src=_majority_src(num + den),
            )
        ]
        made += 1

    return remaining, made


def build_overlines(chars: list[Frag], rules: list[Rule]) -> tuple[list[Frag], int]:
    """
    上劃線。台灣的數學課本用它表示線段（AB 上一橫）與循環小數。

    轉成 \\overline{}，因為那是它真正的意思——不轉的話，
    「線段 AB」與「A 乘 B」在文字上完全一樣。
    """
    made = 0
    for rule in [r for r in rules if r.role == "overline"]:
        covered = [
            c
            for c in chars
            if not c.composed
            and _within(c, rule)
            and 0 < c.base - rule.y <= _OVERLINE_REACH * (c.size or 10.0)
        ]
        if not covered:
            continue
        covered.sort(key=lambda f: f.x0)
        inner = _math("".join(c.text for c in covered))
        if not inner:
            continue
        first = covered[0]
        for c in covered[1:]:
            chars.remove(c)
        first.text = rf"\overline{_wrap(inner)}"
        first.x1 = covered[-1].x1
        first.composed = True
        made += 1
    return chars, made


#: 上下標與它的基準字之間允許的水平間隙（em）。
_SCRIPT_GAP = 0.55
#: 上下標的基線位移上限（em）。超過就不是上下標，是別行的字。
_SCRIPT_MAX_SHIFT = 0.9


def apply_scripts(frags: list[Frag]) -> tuple[list[Frag], int]:
    """
    把上下標接到它的基準字上。

    **必須在分行之前做。** 上標的基線比本文高約 0.5em，而那已經
    超過同一行的基線容差——先分行的話，`x²` 的 `2` 會被歸到上一行，
    於是題幹變成「22類題２設圓C…」而 `x²` 變成 `x`。
    實測一份講義，先分行會讓題目單位從 43 個掉到 25 個。

    基準字用**空間查詢**找：左邊緊鄰、字級較大、基線相近。
    不能靠「整頁按 x 排序後往前看幾個」——同一個 x 附近可能有
    十幾行的字，往前看的那幾個多半來自別行。
    """
    from bisect import bisect_left, bisect_right

    if not frags:
        return frags, 0

    by_x1 = sorted(frags, key=lambda g: g.x1)
    x1s = [g.x1 for g in by_x1]
    max_size = max((f.size for f in frags), default=10.0)
    window = _SCRIPT_GAP * max_size + 1.0

    made = 0
    dropped: set[int] = set()

    # 由左至右處理，讓連續的上下標接得起來（x¹²）
    for f in sorted(frags, key=lambda g: (g.x0, g.base)):
        if f.composed:
            continue

        lo = bisect_left(x1s, f.x0 - 0.6 * max_size)
        hi = bisect_right(x1s, f.x0 + window)

        best = None
        best_gap = None
        op = None
        for g in by_x1[lo:hi]:
            if g is f or id(g) in dropped:
                continue
            em = g.size or 10.0
            # 字級要明顯變小才算上下標。唯一的例外是接在既有上下標
            # 後面的續字（x¹² 的第二位），那時基準字本身就是小字。
            chaining = g.composed and g.text[:1] in "^_"
            if not chaining and f.size > g.size * _SCRIPT_SIZE:
                continue
            # 分數不能當上下標的基準：它的基線設在分數線上（比主行高），
            # 所以緊接其後、位在主行的「＝」看起來就像下標。
            if g.composed and g.text.startswith("\\frac"):
                continue
            gap = f.x0 - g.x1
            if not (-0.6 * em <= gap <= _SCRIPT_GAP * em):
                continue
            dy = f.base - g.base
            if abs(dy) > _SCRIPT_MAX_SHIFT * em:
                continue
            if dy <= -_SUPER_RISE * em:
                cand = "^"
            elif dy >= _SUB_DROP * em:
                cand = "_"
            else:
                continue
            if best_gap is None or abs(gap) < best_gap:
                best, best_gap, op = g, abs(gap), cand

        if best is None:
            continue

        if best.composed and best.text.startswith(op):
            # 連續的同類上下標併成一組：x¹² 分開寫會變成 x^1^2
            inner = best.text[len(op) :].strip("{}")
            best.text = f"{op}{_wrap(inner + _math(f.text))}"
            best.x1 = f.x1
            dropped.add(id(f))
            continue

        f.text = f"{op}{_wrap(_math(f.text))}"
        f.base = best.base
        f.size = best.size
        f.composed = True
        made += 1

    return [f for f in frags if id(f) not in dropped], made


#: 相鄰兩字的水平間距超過這個比例（em）就補一個空白。
#: PDF 裡的空白字元不可靠（有時候有、有時候靠字距做出來），
#: 用幾何判斷才一致。
_SPACE_GAP = 0.22


def _is_cjk(ch: str) -> bool:
    return bool(ch) and ("一" <= ch <= "鿿" or "　" <= ch <= "〿" or "＀" <= ch <= "￯")


def _join(frags: list[Frag]) -> str:
    """把一串字元接成文字，依幾何間距補空白。"""
    if not frags:
        return ""
    out = [frags[0].text]
    for prev, f in zip(frags, frags[1:]):
        em = max(prev.size, f.size) or 10.0
        gap = f.x0 - prev.x1
        # 中文之間不補空白：中文的字距本來就大，補了會變成
        # 每個字中間一個空格。
        if gap > _SPACE_GAP * em and not (
            _is_cjk(prev.text[-1:]) or _is_cjk(f.text[:1])
        ):
            out.append(" ")
        out.append(f.text)
    return "".join(out)


def _render_inline(frags: list[Frag]) -> str:
    return _join(frags)


# ─────────────────────────────────────────────────────────────────
# 視覺行與區塊
# ─────────────────────────────────────────────────────────────────


#: 一個視覺行內，基線總跨度的上限（em）。
#: 分數的主行、分數線、以及左側標記的基線都略有差異，加起來
#: 大約 0.8em；訂在 1.1 容得下，又不會讓整頁串成一行。
_LINE_SPREAD = 1.1


def group_lines(frags: list[Frag]) -> list[list[Frag]]:
    """
    依基線把字元分成視覺行，行內由左至右。

    用**單一連結**分群而不是「與該行第一個字比較」：同一行裡的
    基線不只一種——左側的「解」色塊、分數線、主行文字各差幾個點，
    而它們兩兩相鄰的差距都很小。跟第一個字比的話，只要第一個字
    剛好是偏高的標記，主行就會被切成另一行，於是分數與它所屬的
    算式分家。

    單一連結會有串接的風險（整頁連成一行），所以再加一條總跨度上限。
    """
    if not frags:
        return []

    lines: list[list[Frag]] = []
    prev_base = None
    for f in sorted(frags, key=lambda f: (f.base, f.x0)):
        if lines:
            line = lines[-1]
            em = max((c.size for c in line), default=10.0)
            spread = max(c.base for c in line) - min(c.base for c in line)
            near = abs(f.base - prev_base) <= _LINE_TOL * em
            fits = max(spread, abs(f.base - line[0].base)) <= _LINE_SPREAD * em
            if near and fits:
                line.append(f)
                prev_base = f.base
                continue
        lines.append([f])
        prev_base = f.base

    for ln in lines:
        ln.sort(key=lambda f: f.x0)
    return lines


def group_blocks(lines: list[list[Frag]]) -> list[dict]:
    """
    把視覺行放回原本的段落。

    為什麼不自己重新分段：一個含分數的算式會被 PyMuPDF 切成四塊
    （主行一塊、每個分數各一塊），所以**行**必須重組；但**段落**
    不必——PyMuPDF 的區塊切法在講義上是對的，而且下游的切題、
    欄外標籤判斷都建立在那個粒度上。

    實測過完全由幾何重新分段的版本：同一份講義的題目單位從 39 個
    掉到 3 個，因為題幹與其後所有同色的行都被併成一塊。

    所以做法是：行照幾何重組（修好分數），段落照 PyMuPDF 原本的
    切法（每一行歸給它多數字元所屬的那個區塊）。兩全其美。
    """
    buckets: dict[int, list[list[Frag]]] = {}
    order: list[int] = []
    for ln in lines:
        src = _majority_src(ln)
        if src not in buckets:
            buckets[src] = []
            order.append(src)
        buckets[src].append(ln)

    blocks: list[dict] = []
    for src in order:
        group = buckets[src]
        group.sort(key=lambda ln: ln[0].base)
        blocks.append(_as_block(group))
    return blocks


def _as_block(lines: list[list[Frag]]) -> dict:
    texts = []
    runs: list[list] = []
    for ln in lines:
        texts.append(_join(ln))
        for f in ln:
            if runs and runs[-1][0] == f.ink:
                runs[-1][1] += f.text
            else:
                runs.append([f.ink, f.text])

    flat = [f for ln in lines for f in ln]
    tally: dict[str, int] = {}
    for f in flat:
        tally[f.ink] = tally.get(f.ink, 0) + len(f.text)

    heights = max((f.size for f in flat), default=10.0)
    block = {
        "lines": texts,
        "bbox_abs": (
            min(f.x0 for f in flat),
            min(f.base for f in flat) - heights,
            max(f.x1 for f in flat),
            max(f.base for f in flat) + heights * 0.3,
        ),
        "ink": max(tally, key=tally.get) if tally else "000000",
    }
    if len(tally) > 1:
        block["runs"] = runs
    return block


# ─────────────────────────────────────────────────────────────────
# 入口
# ─────────────────────────────────────────────────────────────────

#: 數學結構的標記。組好之後要包進 $...$，讓前端知道要用 KaTeX 渲染。
_HAS_MATH = re.compile(r"\\(?:frac|overline|sqrt)|[\^_]\{")


#: 可以被吸進數學區間的字元。
#: 半形英數與運算符號、以及它們的全形版本。**不含中文與中文標點**——
#: 那些吸進來會讓 KaTeX 把整句話當成數學符號排版，非常難看。
_MATH_CHARS = set(
    "0123456789"
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "+-=<>()[]./|"
    "＋－＝＜＞（）［］．／"
    "×÷≦≧≤≥≠≒∞√πθ"
)


def wrap_math(text: str) -> str:
    """
    把數學片段包進 $…$。

    做法是**先找出真正的數學結構**（\\frac、\\overline、上下標），
    再從它往左右吸收相鄰的算式字元，最後把重疊的區間合併。

    刻意不用「遇到算式字元就開始包」：一份英文講義滿滿都是
    英文字母，那樣會把整句英文包成數學式。有結構才包，是安全的下限。

    也刻意不吸中文：`'過'.isalnum()` 在 Python 裡是 True，
    照 isalnum 判斷會把「過點」吸進數學區間，變成 `$_{2}過點$`。

    非數學區間裡的 `$` 一律跳脫。原文裡真的會出現這個字元——
    未還原的符號字型會把 ①②③④ 吐成 `!@#$`，英文講義也會出現
    「$100」——而多出來的那一個 `$` 會讓後面所有的分隔符配對錯位，
    整段從此被當成數學式，KaTeX 排出一團亂碼卻沒有任何錯誤訊息。
    """
    spans = _structure_spans(text)
    if not spans:
        return _escape_dollar(text)

    # 往左右吸收算式字元
    grown = []
    for a, b in spans:
        while a > 0 and text[a - 1] in _MATH_CHARS:
            a -= 1
        while b < len(text) and text[b] in _MATH_CHARS:
            b += 1
        grown.append((a, b))

    # 合併重疊或相鄰的區間
    merged: list[list[int]] = []
    for a, b in sorted(grown):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])

    out = []
    cursor = 0
    for a, b in merged:
        out.append(_escape_dollar(text[cursor:a]))
        inner = _math(text[a:b])
        out.append(f"${inner}$" if inner else "")
        cursor = b
    out.append(_escape_dollar(text[cursor:]))
    return "".join(out)


def _escape_dollar(text: str) -> str:
    """跳脫非數學區間裡的 `$`，避免它被當成數學分隔符。"""
    return text.replace("\\$", "$").replace("$", "\\$")


def _structure_spans(text: str) -> list[tuple[int, int]]:
    """找出 \\命令{…} 與 ^{…} _{…} 的字元區間。"""
    spans: list[tuple[int, int]] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\\":
            j = i + 1
            while j < n and text[j].isalpha():
                j += 1
            if j == i + 1:
                i += 1
                continue
            j = _skip_groups(text, j)
            spans.append((i, j))
            i = j
            continue
        if ch in "^_" and i + 1 < n:
            j = _skip_groups(text, i + 1, at_least=1)
            spans.append((i, j))
            i = j
            continue
        i += 1
    return spans


def _skip_groups(text: str, i: int, at_least: int = 0) -> int:
    """跳過連續的 {…} 群組（含巢狀）。"""
    n = len(text)
    seen = 0
    while i < n and text[i] == "{":
        depth = 1
        i += 1
        while i < n and depth:
            depth += (text[i] == "{") - (text[i] == "}")
            i += 1
        seen += 1
    if seen < at_least and i < n:
        i += 1  # ^2 這種沒有大括號的形式
    return i


def page_blocks(page: fitz.Page, translate=None) -> PageMath:
    """
    重建一頁的文字區塊，數學式已組回可讀的形式。

    回傳的區塊形狀與舊版相容（text / bbox 絕對座標 / ink / runs），
    差別只在文字內容是重建過的、而且區塊邊界依視覺行重新切過。
    """
    chars = _collect_chars(page, translate)
    if not chars:
        return PageMath()

    rules = classify_rules(_collect_rules(page), chars)

    frags, n_frac = build_fractions(chars, rules)
    frags, n_over = build_overlines(frags, rules)
    # 上下標一定要在分行之前接好，理由見 apply_scripts 的說明。
    frags, n_script = apply_scripts(frags)

    blocks = group_blocks(group_lines(frags))
    for b in blocks:
        b["text"] = "\n".join(wrap_math(t) for t in b.pop("lines"))
        # runs 也要包。教用版的答案是靠 runs 拆出來的
        # （strip_answer_ink），只包 text 的話學生看到的版本會是
        # 沒有處理過的原始字串——同一個區塊有兩種呈現，很難查。
        if b.get("runs"):
            b["runs"] = [[ink, wrap_math(t)] for ink, t in b["runs"]]

    blanks = [(r.x0, r.x1, r.y) for r in rules if r.role == "underline"]

    return PageMath(
        blocks=blocks,
        fractions=n_frac,
        overlines=n_over,
        scripts=n_script,
        blanks=blanks,
    )
