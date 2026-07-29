"""
雲端智學題目交換格式（QIF v1）

# 這是什麼

每個老師丟進來的東西都不一樣：翰林的數學教用版、南一的英文學生版、
自己出的段考卷、手機拍的一頁社會講義、從網路抓的考古題。體例不同、
版本不同、科目不同、印刷慣例不同。

這個格式是**所有那些東西被理解之後的共同終點**。模型讀完一份原稿，
輸出的一律是這個形狀；下游（校對介面、題庫、組卷、能力分析、
智慧老師）只認這個形狀，永遠不必知道原稿是哪一家出版社的。

# 一條界線：這份 JSON 記錄「原稿說了什麼」，不是「題庫長什麼樣」

答案只收 `PRINTED`（原稿印出來的）與 `NONE`（原稿沒印）兩種來源。
系統推導出來的答案**不進這個格式**——那是自答階段的產物，寫在
資料庫的候選題上，有投票次數與一致率跟著。

這條界線是整套設計的骨幹：**事實與推論分開存**。混在一起之後，
半年後沒有人分得出「這個答案是題本印的還是系統猜的」，而那兩者
的可信度差了一個量級。

# 遇到格式裡沒有的東西：回報，不准硬塞

音樂科的五線譜、化學的結構式、活動單的心智圖、某家出版社獨有的
題型——這些一定會出現，而且是在系統上線之後、由不寫程式的人遇到。

規則是：**對不上任何型別的東西，不允許塞進任何一個型別**，
而是產生一筆 `code="unsupported_content"` 的 issue，把原文與座標
原樣留著，並把相關的題目標成存疑。

硬塞的代價不是「資料難看」，是**沒有人會發現**。一張五線譜被當成
表格塞進題幹，出來的是一串亂碼；一個獨有題型被當成單選題，選項
是空的而答案指向不存在的選項。兩者都會安靜地進到題庫。

# 版本

`schema_version` 是必填。格式一定會長，而題庫裡會同時存在好幾個
版本產出的資料——沒有版本號的話，日後任何一次格式調整都要靠猜。
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .schemas import BBox

#: 格式版本。**改欄位就要動它。**
#: 主版本變動代表不相容（欄位改名、語意改變），次版本代表只加欄位。
#:
#: 1.1 —— 拿兩份真實的自然科講義（南易物理、翰林化學）打過之後補的
#:        三個欄位，三個都是「原稿印在紙上、而我們原本丟掉」的東西：
#:        `Scoring.expected_count`（「應選 3 項」）、
#:        `Provenance.related_raw`（「相關題型：單元練習 3.、7.」）、
#:        `Provenance.badges`（「素養題」）。
#:        只加欄位，1.0 產出的文件照樣有效。
#:
#: 1.2 —— `Asset.width` / `Asset.height`：裁出來的圖有多少像素。
#:        只有裁圖的那一刻量得到，而少了它，作答畫面上每一張圖
#:        載進來的瞬間都會把題幹往下推。只加欄位，1.1 照樣有效。
SCHEMA_VERSION = "1.2"


# ═════════════════════════════════════════════════════════════════
# 內容標記
#
# 題幹、選項、詳解、素材、教材全部用同一套標記，所以「題幹裡有一張
# 表格」「選項裡有一個數學式」不需要任何特殊處理。
#
# 刻意用**帶約定的純文字**而不是節點樹：節點樹要模型多吐三倍的
# token，而且巢狀結構一深，模型就開始漏括號。純文字加上一個驗證器
# 便宜得多，而且它就是最後要拿去渲染的東西。
# ═════════════════════════════════════════════════════════════════

#: 資產參照。`![[a:fig1]]` 指向 assets 裡 id 為 fig1 的那一項。
ASSET_REF = re.compile(r"!\[\[a:([A-Za-z0-9_-]{1,32})\]\]")

#: 有編號的作答格位（學測選填題）：`{{slot:⑬}}`
SLOT_REF = re.compile(r"\{\{slot:([^}]{1,8})\}\}")

#: 沒有編號的填空：`{{blank}}`
BLANK_REF = re.compile(r"\{\{blank\}\}")

#: 未跳脫的數學分隔符。用來檢查配對。
MATH_DELIM = re.compile(r"(?<!\\)\$")

#: 化學式與反應式。`$\ce{2H2 + O2 -> 2H2O}$`
#:
#: 用 mhchem 的 `\ce{}` 而不是自己拼 LaTeX 下標，有三個實際的理由：
#:
#:   · `$2H_2 + O_2 \rightarrow 2H_2O$` 排出來的字級與間距都不對，
#:     化學老師一眼就看得出來不專業
#:   · 電荷、狀態、可逆箭頭（`<=>`）、沉澱符號用純 LaTeX 拼很痛苦，
#:     而模型拼錯了不會報錯，只是排出一個看起來差不多的東西
#:   · `\ce{}` 是可搜尋的：要找「所有考到硫酸的題目」時，
#:     `\ce{H2SO4}` 是一個穩定的字串，`H_2SO_4` 有五種寫法
#:
#: **渲染端要載入 KaTeX 的 mhchem 擴充**，否則這些會排不出來。
CHEM_REF = re.compile(r"\\ce\{")

#: 看起來像化學式、卻用純 LaTeX 下標寫的。這不算錯，但值得提醒——
#: 同一份題本裡兩種寫法混用，日後就搜不到其中一種。
CHEM_AS_LATEX = re.compile(r"(?<!\\ce\{)\b[A-Z][a-z]?_\{?\d")

#: 向量與其他戴帽子的符號：`$\vec{v}$`、`$\overrightarrow{AB}$`、
#: `$\hat{n}$`、`$\overline{AB}$`。
#:
#: **箭頭掉了就是另一個物理量。** $v$ 是速率、$\vec{v}$ 是速度；
#: $F$ 是力的量值、$\vec{F}$ 是力。物理題目大量在這個區別上出題
#: （「合力的方向」「動量變化量」），而箭頭是頁面上最細的一筆，
#: 也是最容易在翻拍與壓縮中被抹掉的一筆。
#:
#: 抹掉之後的症狀特別惡劣：一題問「下列何者為合力」而四個選項的
#: 箭頭全掉了，四個選項就會長得**一模一樣**。題目看起來完全正常，
#: 只是不管學生選哪一個都可能被判錯。這正是下面 `duplicate_options`
#: 要攔的東西——箭頭掉了我們攔不住，但選項變得無法區分我們攔得住。
VEC_REF = re.compile(r"\\(?:vec|overrightarrow|overleftarrow|hat|overline)\{")


def _brace_unbalanced(text: str, brace_open: int) -> bool:
    """從 `{` 的位置往後掃，看括號有沒有收回來。"""
    depth = 0
    for i in range(brace_open, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return False
    return True


def content_issues(text: str, asset_ids: set[str]) -> list[str]:
    """檢查一段內容標記，回傳問題描述。空清單代表沒問題。"""
    problems: list[str] = []

    if len(MATH_DELIM.findall(text)) % 2:
        problems.append("數學分隔符 $ 沒有成對。落單的一個會讓後面整段被當成數學式")

    for m in ASSET_REF.finditer(text):
        if m.group(1) not in asset_ids:
            problems.append(f"參照到不存在的資產 {m.group(1)}")

    # `\ce{...}` 的大括號要配對。少一個右括號，mhchem 會把後面
    # 整段話都當成化學式排版——排出來是一團看不懂的東西。
    for m in CHEM_REF.finditer(text):
        if _brace_unbalanced(text, m.end() - 1):
            problems.append(r"\ce{} 的大括號沒有配對，後面整段會被當成化學式排版")

    # 向量同理：`$\vec{v$` 少一個右括號，KaTeX 會整段排不出來，
    # 而畫面上出現的是一行紅字而不是題目。
    for m in VEC_REF.finditer(text):
        if _brace_unbalanced(text, m.end() - 1):
            problems.append(r"\vec{} 這類符號的大括號沒有配對，整段數學式會排不出來")

    return problems


# ═════════════════════════════════════════════════════════════════
# 單位
#
# 物理與化學的答案是「數字＋單位」，而**同一個單位有很多種寫法**：
#
#     m/s²   m/s^2   m·s⁻²   m s^-2   ms^-2
#
# 五種都對，五種都會出現在不同出版社的講義上。自動改考卷時若逐字
# 比對，學生寫 `m/s^2` 而答案存 `m·s⁻²` 就被判錯——而那是排版差異，
# 不是物理錯誤。
#
# 這裡把單位化成一個正規形式（符號與指數），讓等價的寫法比得出來。
# **刻意不做字首換算**：km 與 m 不相等，答案要求公尺就是公尺。
# ═════════════════════════════════════════════════════════════════

#: 上標數字與正負號。`m·s⁻²` → `m·s-2`
_SUPERSCRIPT = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻", "0123456789+-")

#: 乘號的各種寫法，含全形空白。
_UNIT_MULT = re.compile(r"[·⋅∙*×・\s]+")

#: 一個因式：符號（含希臘字母、度、歐姆、百分比、中文單位）加上
#: 可有可無的指數。
_UNIT_FACTOR = re.compile(r"([A-Za-zΑ-Ωα-ω°Ω%‰Å一-鿿]+)\^?([+-]?\d+)?")

#: 中文單位名稱 → SI 符號。
#:
#: 同一份講義裡兩種寫法混用是常態，不是例外。南易《EZ 講義 物理》
#: 第 3 章裡，範例 5 寫「負 2 米/秒² 的定值加速度」，它正下方的
#: 類題 5 就寫「多少 m/s²」——**同一頁、同一個概念、兩種單位系統**。
#:
#: 不對應的話，學生寫「m/s²」而答案存「米/秒²」會被判錯，而那是
#: 排版差異不是物理錯誤。
#:
#: 刻意不收的：
#:   · 「度」——角度、溫度、電度（千瓦時）都叫度，對不出唯一解
#:   · 「尺」「里」——台尺與台里是舊制，與公尺公里差很多
#:   · 「兩」「斤」——同上
#: 對不出來的寧可回報看不懂，也不要猜一個。
_CJK_UNITS = {
    "公里": "km", "公尺": "m", "米": "m", "公分": "cm", "厘米": "cm",
    "公釐": "mm", "毫米": "mm", "微米": "μm", "奈米": "nm",
    "公噸": "t", "公斤": "kg", "千克": "kg", "公克": "g", "克": "g",
    "毫克": "mg", "微克": "μg",
    "公升": "L", "毫升": "mL", "立方公尺": "m3", "立方公分": "cm3",
    "秒": "s", "毫秒": "ms", "微秒": "μs", "分鐘": "min", "小時": "hr",
    "牛頓": "N", "焦耳": "J", "瓦特": "W", "瓦": "W", "帕": "Pa",
    "巴斯卡": "Pa", "大氣壓": "atm", "伏特": "V", "安培": "A",
    "歐姆": "Ω", "庫侖": "C", "赫茲": "Hz", "卡": "cal", "大卡": "kcal",
    "莫耳": "mol", "百萬分點": "ppm",
}


def normalize_unit(raw: str | None) -> str:
    """
    把單位化成正規形式，讓 `m/s²`、`m·s⁻²`、`m s^-2` 比得出相等。

    回傳依符號排序的正規字串（`kg·m·s^-2`）。看不懂的輸入回傳
    `"?" + 原文`——**不假裝正規化成功**：如果系統看不懂那個單位，
    改考卷時就不該宣稱兩個答案等價，而該讓老師知道它看不懂。

    不做字首換算（km ≠ m）也不做量綱分析（N ≠ kg·m/s²）：題目要求
    什麼單位就是什麼單位，替學生換算不是這一層的事。
    """
    if not raw or not raw.strip():
        return ""

    s = raw.strip()
    for junk in ("$", "\\mathrm", "\\text", "\\rm", "{", "}"):
        s = s.replace(junk, "")
    s = s.translate(_SUPERSCRIPT)
    # µ（微符號 U+00B5）與 μ（希臘小寫 mu）、Ω（歐姆符號 U+2126）與
    # Ω（希臘大寫 omega）長得一樣但碼位不同。不統一的話 `μm` 與 `μm`
    # 會被判成兩個單位。
    s = s.replace("\u00b5", "\u03bc").replace("\u2126", "\u03a9")

    # 第一個 `/` 之後全部取負指數，所以 `m/s/s` 與 `m/s^2` 相等，
    # `J/(kg·K)` 的兩個都在分母。
    pieces = s.split("/")
    groups = [(pieces[0], 1)] + [(p, -1) for p in pieces[1:]]

    factors: dict[str, int] = {}
    for part, sign in groups:
        part = part.strip().replace("(", "").replace(")", "")
        for tok in _UNIT_MULT.split(part):
            if not tok:
                continue
            m = _UNIT_FACTOR.fullmatch(tok)
            if not m:
                return "?" + " ".join(raw.split())
            sym = _CJK_UNITS.get(m.group(1), m.group(1))
            exp = sign * int(m.group(2) or 1)
            # 「立方公尺」對到 `m3`，指數要乘進去而不是黏在符號上。
            if sym[-1].isdigit() and not sym[:-1].isdigit():
                sym, exp = sym[:-1], exp * int(sym[-1])
            if any("一" <= c <= "鿿" for c in sym):
                # 認不得的中文單位。**不要猜。** 猜錯的代價是宣稱兩個
                # 不同的答案等價，而那會讓學生被判錯。
                return "?" + " ".join(raw.split())
            factors[sym] = factors.get(sym, 0) + exp

    out = []
    for sym in sorted(k for k, v in factors.items() if v):
        v = factors[sym]
        out.append(sym if v == 1 else f"{sym}^{v}")
    return "·".join(out)


def same_unit(a: str | None, b: str | None) -> bool:
    """
    兩個單位是不是同一個。

    任一邊沒填就回 True——**沒填不等於不相等**。原稿沒標單位是很
    常見的，那時候沒有東西可以矛盾，不該因此把學生判錯。
    """
    na, nb = normalize_unit(a), normalize_unit(b)
    if not na or not nb:
        return True
    return na == nb


# ═════════════════════════════════════════════════════════════════
# 列舉
# ═════════════════════════════════════════════════════════════════


class SubjectCode(str, Enum):
    """
    科目。

    **學測的「自然」與「社會」是合科考卷，但補習班是分科教的。**
    化學老師傳的是化學講義、地理老師傳的是地理講義；訪談時說的
    「每科三位老師、七個班」指的就是分科。只留 SCIENCE 一個值的話，
    化學老師的題目會跟生物的混在同一個題庫裡，而他要組一份化學
    小考時篩不出來。

    所以分科與合科並存：SCIENCE／SOCIAL 給學測合科試卷用，
    其餘給日常的分科講義用。
    """

    CHINESE = "CHINESE"
    ENGLISH = "ENGLISH"
    MATH_A = "MATH_A"
    MATH_B = "MATH_B"

    # 學測合科試卷
    SOCIAL = "SOCIAL"
    SCIENCE = "SCIENCE"

    # 社會的分科
    HISTORY = "HISTORY"
    GEOGRAPHY = "GEOGRAPHY"
    CIVICS = "CIVICS"

    # 自然的分科
    PHYSICS = "PHYSICS"
    CHEMISTRY = "CHEMISTRY"
    BIOLOGY = "BIOLOGY"
    EARTH_SCIENCE = "EARTH_SCIENCE"

    ELECTIVE = "ELECTIVE"
    UNKNOWN = "UNKNOWN"


#: 分科 → 學測合科。組一份學測模擬卷時要能把分科的題目湊起來。
PARENT_SUBJECT = {
    SubjectCode.HISTORY: SubjectCode.SOCIAL,
    SubjectCode.GEOGRAPHY: SubjectCode.SOCIAL,
    SubjectCode.CIVICS: SubjectCode.SOCIAL,
    SubjectCode.PHYSICS: SubjectCode.SCIENCE,
    SubjectCode.CHEMISTRY: SubjectCode.SCIENCE,
    SubjectCode.BIOLOGY: SubjectCode.SCIENCE,
    SubjectCode.EARTH_SCIENCE: SubjectCode.SCIENCE,
}


class Genre(str, Enum):
    """原稿的體例。決定下游怎麼切、怎麼呈現。"""

    EXAM = "EXAM"              # 學測／模擬考試卷
    WORKSHEET = "WORKSHEET"    # 補習班講義（範例／類題／習題）
    MATERIAL = "MATERIAL"      # 純觀念頁，沒有題目
    ANSWER_KEY = "ANSWER_KEY"  # 獨立的答案卷
    SOLUTION = "SOLUTION"      # 獨立的詳解本
    MIXED = "MIXED"
    UNKNOWN = "UNKNOWN"


class Edition(str, Enum):
    """教用版印答案與詳解，學生版不印。這個差別決定了整份的價值。"""

    TEACHER = "TEACHER"
    STUDENT = "STUDENT"
    UNKNOWN = "UNKNOWN"


class QuestionKind(str, Enum):
    """
    題型。**這一組要涵蓋五科**，所以比資料庫既有的列舉多幾項。

    加的那幾項都是實際看得到的：社會科的作答格（MATCHING）、
    國文的排序題（ORDERING）、數學的計算證明（CALCULATION）、
    英聽（LISTENING）。OTHER 是逃生口，用它的時候一定要附 issue。
    """

    SINGLE_CHOICE = "SINGLE_CHOICE"
    MULTI_CHOICE = "MULTI_CHOICE"
    TRUE_FALSE = "TRUE_FALSE"
    FILL_SLOT = "FILL_SLOT"          # 學測選填，答案填進編號格位 ⑬⑭
    FILL_BLANK = "FILL_BLANK"        # 一般填空
    MATCHING = "MATCHING"            # 配合題、社會科的 A/B/C/D 作答格
    ORDERING = "ORDERING"            # 排序
    SHORT_ANSWER = "SHORT_ANSWER"
    CALCULATION = "CALCULATION"      # 計算、證明（要寫過程）
    ESSAY = "ESSAY"
    TRANSLATION = "TRANSLATION"
    LISTENING = "LISTENING"
    #: 出版社專屬題型。**必須同時填 custom_type**，那是它到底是
    #: 什麼的說明；`custom_type.answer_mode` 決定它怎麼作答與評分。
    PUBLISHER_CUSTOM = "PUBLISHER_CUSTOM"
    OTHER = "OTHER"                  # 逃生口，必須伴隨 issue


#: 沒有標準答案、只有評分原則的題型。這些不跑自答。
OPEN_ENDED = {
    QuestionKind.SHORT_ANSWER,
    QuestionKind.CALCULATION,
    QuestionKind.ESSAY,
    QuestionKind.TRANSLATION,
}

#: 有選項的題型。
CHOICE_KINDS = {
    QuestionKind.SINGLE_CHOICE,
    QuestionKind.MULTI_CHOICE,
    QuestionKind.TRUE_FALSE,
}


class CustomTypeRef(BaseModel):
    """
    出版社專屬的題型。

    出版社常有自己設計的題型：翰林的「觀念速記」、南一的「圖表解碼」、
    龍騰的某種雙欄配對。它們**呈現方式獨特，但作答方式幾乎一定是
    標準的那幾種之一**——這一點讓它變得可處理：系統不必懂那個題型
    的教學設計，只要知道學生要怎麼答、怎麼給分。

    流程是「問老師一次，之後記住」：

      1. 模型遇到不認得的題型 → `kind=OTHER` ＋ 一筆 unsupported_content
      2. 校對介面把裁下來的原圖與模型的猜測拿給老師看，問這是什麼、
         學生要怎麼答、有沒有取得出版社授權
      3. 老師確認後存成租戶層級的題型定義
      4. 下一次同一種題型出現，定義會放進提示詞，模型就認得了，
         `kind` 填 PUBLISHER_CUSTOM 並帶上 `custom_type`

    **授權要記在這裡而不是只記在匯入工作上。** 題型會被反覆使用，
    而「這個題型我們有沒有權利用」是題型層級的事實，不是某一次
    匯入的事實。
    """

    #: 租戶題型庫裡的 id。模型從提示詞給的清單裡選，**不得自創**——
    #: 自創的話同一種題型會在系統裡有五個名字，篩選就失效了。
    id: str | None = None
    #: 題型名稱。第一次遇到（還沒有 id）時由模型提議，交給老師確認。
    name: str = Field(min_length=1)
    publisher: str | None = None
    #: 學生實際上怎麼作答。這是系統真正需要知道的部分。
    answer_mode: QuestionKind = QuestionKind.SHORT_ANSWER
    #: 這一題是不是用既有定義認出來的。false 代表模型在提議一個
    #: 新題型，**尚未經過老師確認，不可自動入庫**。
    confirmed: bool = False


class GroupKind(str, Enum):
    """題組共用的是什麼。"""

    PASSAGE = "PASSAGE"        # 閱讀測驗、文言文選段
    CLOZE = "CLOZE"            # 克漏字：一篇文章挖數個空
    DATA = "DATA"              # 圖表、統計表、地圖、史料
    EXPERIMENT = "EXPERIMENT"  # 自然科的實驗敘述
    SCENARIO = "SCENARIO"      # 社會科的情境／時事
    MIXED = "MIXED"


class AssetKind(str, Enum):
    FIGURE = "FIGURE"
    TABLE = "TABLE"
    AUDIO = "AUDIO"
    VIDEO_LINK = "VIDEO_LINK"  # 講義上的「解題影音」QR code
    QR = "QR"
    OTHER = "OTHER"


class AnswerSource(str, Enum):
    """
    **只有兩種。** 系統推導的答案不進這個格式——那是自答階段的
    產物，帶著投票次數與一致率，存在候選題上。

    混在一起之後，半年後沒有人分得出「這個答案是題本印的還是
    系統猜的」，而那兩者的可信度差了一個量級。
    """

    PRINTED = "PRINTED"
    NONE = "NONE"


class Severity(str, Enum):
    INFO = "info"
    WARN = "warn"
    ERROR = "error"


# ═════════════════════════════════════════════════════════════════
# 基本結構
# ═════════════════════════════════════════════════════════════════


class Placement(BaseModel):
    """這個東西在原稿的哪裡。校對介面的左右連動靠它。"""

    page: int = Field(ge=1)
    bbox: BBox | None = None
    #: 內容延續到下一頁。跨頁的題目與題組靠這個合併。
    continues: bool = False


class Asset(BaseModel):
    """
    圖、表、音檔、影音連結。**全文件唯一 id**，內容用 `![[a:id]]` 參照。

    表格也算資產而不是直接寫進題幹：表格常常被兩題共用（地理那份
    「西班牙流感死亡人數」表就是），而且它需要獨立的替代文字。
    """

    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,32}$")
    kind: AssetKind
    placement: Placement
    #: 替代文字。視障學生看到的就是這個，所以要寫成完整的句子。
    alt: str = ""
    caption: str | None = None       # 「▲圖一」
    #: kind=TABLE 時的 Markdown 表格。
    table_markdown: str | None = None
    #: QR／影音連結的目標。
    url: str | None = None
    #: 裁出來的影像在物件儲存的位置。
    storage_key: str | None = None
    #: 裁出來的影像有多少像素。**沒有它，前端就得等圖載完才知道要留
    #: 多高**，而圖一到整段題幹會往下跳——學生正在讀第三行的時候。
    #: 只有真的裁過的圖才有值。
    width: int | None = None
    height: int | None = None

    @model_validator(mode="after")
    def _table_has_content(self) -> "Asset":
        if self.kind is AssetKind.TABLE and not (self.table_markdown or self.storage_key):
            raise ValueError("表格資產必須有 table_markdown 或裁出來的影像")
        return self


class Option(BaseModel):
    order: int = Field(ge=1, le=20)
    label: str                       # 「(1)」「(A)」「①」
    content: str                     # 內容標記


class AnswerSlot(BaseModel):
    """學測選填題的答案格位。答案卡上的格子有編號（⑬⑭）。"""

    slot: str
    value: str


class GridCell(BaseModel):
    """社會科非選的作答格：第 row 列勾第 col 欄。"""

    row: str
    col: str


class Answer(BaseModel):
    """
    一題的答案。**只記原稿印了什麼。**

    五個欄位互斥使用，由題型決定該用哪一個——分成五欄而不是一個
    自由字串，是因為下游要拿它自動改考卷。改考卷的邏輯不該去猜
    「(B)」跟「B」跟「2」是不是同一件事。
    """

    source: AnswerSource = AnswerSource.NONE
    #: 選擇題：選項的 order（1 起算，不是 A/B/C/D）
    keys: list[int] = Field(default_factory=list)
    #: 選填題：格位與值
    slots: list[AnswerSlot] = Field(default_factory=list)
    #: 填空、計算、翻譯、簡答的答案原文
    text: str | None = None
    #: 配合題／作答格
    grid: list[GridCell] = Field(default_factory=list)

    @model_validator(mode="after")
    def _none_means_empty(self) -> "Answer":
        if self.source is AnswerSource.NONE and (
            self.keys or self.slots or self.text or self.grid
        ):
            raise ValueError(
                "source=NONE 卻帶著答案。原稿沒印答案就是沒印——"
                "推導出來的答案不進這個格式"
            )
        if self.source is AnswerSource.PRINTED and not (
            self.keys or self.slots or self.text or self.grid
        ):
            raise ValueError("source=PRINTED 卻沒有任何答案內容")
        return self


class Scoring(BaseModel):
    """配分與給分規則。"""

    score: float | None = Field(default=None, ge=0, le=100)
    #: 多選題的部分給分。學測是「答錯 k 個選項者，得 (n-2k)/n 的分數」。
    partial_credit: bool = False
    #: 多選題印在題號旁的「（應選 3 項）」。
    #:
    #: **這是一個免費的正確性檢查。** 原稿自己說了應該選幾個，
    #: 所以抽出來的答案數量對不上就一定是抽錯了——不必問模型、
    #: 不必自答、不必老師看。南易《EZ 講義 物理》的多選題每一題
    #: 都印，而少了這一欄，那個事實就白白丟掉。
    expected_count: int | None = Field(default=None, ge=1, le=20)
    #: 非選題的字數限制（國寫、英文作文）
    word_limit: int | None = Field(default=None, ge=1, le=5000)
    #: 答案的單位。理化常標，而「答對數字但沒寫單位」是不是給分
    #: 由老師決定——系統要記得原稿有沒有要求。
    #:
    #: **存原文。** 老師校對時看到的要跟講義上印的一樣；等價寫法的
    #: 比對交給 `unit_canonical`。
    unit: str | None = None
    #: 有效位數。「答案取三位有效數字」是理化的常見要求，
    #: 而自動改考卷時 2.00 與 2 是不是同一個答案取決於它。
    sig_figs: int | None = Field(default=None, ge=1, le=15)
    #: 原稿印的評分原則原文。與詳解一樣受著作權保護，分開存。
    rubric_raw: str | None = None

    @property
    def unit_canonical(self) -> str:
        """
        給改考卷用的正規化單位。學生寫 `m/s^2`、答案存 `m·s⁻²` 時，
        逐字比對會判錯——那是排版差異，不是物理錯誤。

        刻意做成 property 而不是欄位：存進系統的是原文，正規形式
        是算出來的。存兩份的話，日後改了正規化規則，舊資料就會帶著
        一份過時的正規形式而沒有人知道。
        """
        return normalize_unit(self.unit)


class Explanation(BaseModel):
    """
    原稿的詳解。**與題幹分開存。**

    試題依著作權法第 9 條不受保護，詳解受保護。把它寫進題幹等於
    把一份受保護的內容標成不受保護。
    """

    body: str                        # 內容標記，逐字保留不改寫
    #: 詳解裡出現的答案（「故選(A)(B)(E)」「⇒ k＝－13」）。
    #: 這是**比 AI 自答便宜也可靠**的答案來源。
    stated_answer: str | None = None


class Provenance(BaseModel):
    """這一題從哪裡來。"""

    #: 出處標籤「112學測」。社會與英文的考古題幾乎每題都印。
    exam: str | None = None
    #: 大考中心公布的**全國**答對率（0–1）。校準過的實測難度。
    #: **只在原稿印了才填，絕對不可推估。**
    national_correct_rate: float | None = Field(default=None, ge=0, le=1)
    #: 原稿印的相關題目指引，原文照收：
    #:   「〈相關題型：單元練習 3.、7.〉」（南易物理，每個範例都印）
    #:   例題框右上角的「2 1.」（翰林化學，指向習題編號）
    #:
    #: **這是出版社替我們做好的題目關聯。** 智慧老師要在學生答錯時
    #: 說「這個觀念這裡還有兩題可以練」，靠的就是它，而編輯已經
    #: 一題一題標好了。
    #:
    #: 存原文不存 id：那些指引指向的是「這一本裡的第幾題」，要等
    #: 整份匯入完才解得開。現在不收，之後就只能重讀一次 PDF。
    related_raw: list[str] = Field(default_factory=list)
    #: 題目旁的分類標籤原文：「素養題」「跨科」「實驗題」「經典」。
    #: 108 課綱之後「素養題」是老師實際會拿來篩選的維度。
    badges: list[str] = Field(default_factory=list)


class TextbookRef(BaseModel):
    """
    教科書索引：出版社 × 冊次 × 章節。

    這是台灣老師實際使用的第一層索引（文件 11），而它**就印在每一頁
    的頁首**——「4-1 直線方程式及其圖形」「單元 1 地理技能」
    「13 代名詞」。不收下來的話，日後要靠人一本一本補。
    """

    publisher: str | None = None     # 翰林、南一、龍騰、三民…
    book: str | None = None          # 「互動式教學講義 數學(1)」
    volume: str | None = None        # 冊次
    chapter: str | None = None       # 「4-1 直線方程式及其圖形」
    unit: str | None = None          # 「單元 1 地理技能」


class ConfidenceReason(BaseModel):
    """
    扣分理由。**必須具體到校對者知道要看哪裡。**

    不合格：「辨識信心較低」
    合格：  「選項 (3) 的指數字跡黏連，未能確定是 6 或 8」
    """

    code: str
    detail: str = Field(min_length=4)
    severity: Severity = Severity.WARN


class Confidence(BaseModel):
    score: float = Field(ge=0, le=1)
    reasons: list[ConfidenceReason] = Field(default_factory=list)


# ═════════════════════════════════════════════════════════════════
# 主要結構
# ═════════════════════════════════════════════════════════════════


class Section(BaseModel):
    """
    節。試卷是「一、單選題（占 30 分）」，講義是「考古題大搜查」
    「綜合演練」。兩者形狀完全不同，但作用一樣：交代這一段的體例。
    """

    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,32}$")
    title: str
    note: str = ""                   # 「說明：第 1 題至第 6 題…」
    placement: Placement
    #: 本節推定的題型與配分。原稿常常只在節標題交代一次。
    default_kind: QuestionKind | None = None
    default_score: float | None = None
    total_score: float | None = None


class Group(BaseModel):
    """
    題組。共用的素材放在這裡，子題只放自己的部分。

    這是原本的格式最大的缺口：學測有大量題組（閱讀測驗、克漏字、
    圖表題、實驗題），把共用敘述複製到每一題裡的話，重複題偵測會
    把整組看成互相重複，而學生在第二題看到的是同一段又讀一次。
    """

    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,32}$")
    kind: GroupKind = GroupKind.MIXED
    #: 指示語原文：「第 37 題至第 39 題為題組」「請問 9～10 題」
    lead: str = ""
    #: 共用素材（文章、圖表說明）。內容標記。
    stimulus: str = ""
    placement: Placement
    section_id: str | None = None


class Question(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,32}$")
    #: 原稿上的題號。可能是「7」「37-39」「（a）」，也可能沒有。
    number: str | None = None
    #: 講義的題目標頭：「範例 3」「類題 1」「Quiz Time」
    label: str | None = None
    #: 混合題的子題編號，學測用全形「（a）」
    sub_label: str | None = None
    group_id: str | None = None
    section_id: str | None = None

    kind: QuestionKind
    stem: str = Field(min_length=1)
    options: list[Option] = Field(default_factory=list)
    answer: Answer = Field(default_factory=Answer)
    scoring: Scoring = Field(default_factory=Scoring)
    explanation: Explanation | None = None
    provenance: Provenance = Field(default_factory=Provenance)
    placement: Placement
    confidence: Confidence
    #: 這一題引用到的資產 id。與 stem 裡的 `![[a:id]]` 應一致，
    #: 冗餘是刻意的——下游要查「哪些題目用到這張圖」時不必解析文字。
    asset_ids: list[str] = Field(default_factory=list)
    #: 知識點線索。模型從單元標題與內容讀到的，供標註階段當候選。
    #: **不是知識點本身**——那必須從知識點樹裡選，不得自由生成。
    topic_hints: list[str] = Field(default_factory=list)
    #: 出版社專屬題型的說明。`kind=PUBLISHER_CUSTOM` 時必填。
    custom_type: CustomTypeRef | None = None

    @field_validator("stem")
    @classmethod
    def _stem_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("題幹不得為空")
        return v

    @model_validator(mode="after")
    def _shape_matches_kind(self) -> "Question":
        # 選擇題必須有選項。抽不到選項卻標成選擇題是很常見的抽取錯誤，
        # 在這裡擋下來比讓它進到校對介面好。
        if self.kind in CHOICE_KINDS and self.kind is not QuestionKind.TRUE_FALSE:
            if len(self.options) < 2:
                raise ValueError(f"{self.kind.value} 至少需要 2 個選項，實得 {len(self.options)}")
            orders = sorted(o.order for o in self.options)
            if orders != list(range(1, len(orders) + 1)):
                raise ValueError(f"選項序號必須從 1 連續，實得 {orders}")

        if self.kind in OPEN_ENDED and self.options:
            raise ValueError(f"{self.kind.value} 不應有選項")

        # **答案指向不存在的選項**是最危險的一種錯：題目看起來完全
        # 正常，只是每個答對的學生都會被判錯。
        if self.answer.keys:
            n = len(self.options)
            bad = [k for k in self.answer.keys if k < 1 or k > n]
            if bad:
                raise ValueError(f"答案 {bad} 超出選項範圍（本題共 {n} 個選項）")
            if self.kind is QuestionKind.SINGLE_CHOICE and len(self.answer.keys) > 1:
                raise ValueError("單選題只能有一個答案")

        # 選填題的答案格位要對得上題幹裡標的格位
        if self.kind is QuestionKind.FILL_SLOT and self.answer.slots:
            in_stem = {m.group(1) for m in SLOT_REF.finditer(self.stem)}
            if in_stem:
                unknown = [s.slot for s in self.answer.slots if s.slot not in in_stem]
                if unknown:
                    raise ValueError(f"答案填在題幹沒有標示的格位 {unknown}")
        return self


class Material(BaseModel):
    """
    講義的觀念頁：文法表格、公式整理、例句對照、「使用時機」說明。

    不是題目，但也不是垃圾——智慧老師要在學生卡住時「退回去補前置
    觀念」，而那些內容就是教材。同一份 PDF 裡本來就有。
    """

    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,32}$")
    title: str
    body: str
    placement: Placement
    section_id: str | None = None
    asset_ids: list[str] = Field(default_factory=list)
    topic_hints: list[str] = Field(default_factory=list)


class Issue(BaseModel):
    """
    這份原稿裡有問題、或格式吃不下的東西。

    `raw` 是這整個設計的安全閥：**對不上任何型別的內容不允許塞進
    任何一個型別**，而是原樣留在這裡。硬塞的代價不是資料難看，
    是沒有人會發現——一張五線譜被當成表格塞進題幹，出來的是一串
    亂碼；一個獨有題型被當成單選題，選項是空的而答案指向不存在的
    選項。兩者都會安靜地進到題庫。
    """

    code: str
    severity: Severity = Severity.WARN
    detail: str = Field(min_length=4)
    page: int | None = None
    bbox: BBox | None = None
    question_id: str | None = None
    #: 沒能結構化的原文。`code="unsupported_content"` 時**必填**。
    raw: str | None = None
    #: 或者那一塊的影像（裁下來存進物件儲存）。
    raw_asset_id: str | None = None

    @model_validator(mode="after")
    def _unsupported_keeps_the_original(self) -> "Issue":
        if self.code == "unsupported_content" and not (self.raw or self.raw_asset_id):
            raise ValueError(
                "回報未支援的內容時必須保留原文（raw）或影像（raw_asset_id）。"
                "只說「有東西讀不懂」而不留下是什麼，等於把它丟掉"
            )
        return self


class DocumentMeta(BaseModel):
    subject: SubjectCode = SubjectCode.UNKNOWN
    genre: Genre = Genre.UNKNOWN
    edition: Edition = Edition.UNKNOWN
    #: 主要語言。英文科與中譯英是 mixed。下游的嵌入與朗讀要用。
    language: Literal["zh-Hant", "en", "mixed", "unknown"] = "unknown"
    textbook: TextbookRef = Field(default_factory=TextbookRef)
    page_count: int = Field(default=0, ge=0)
    #: 原稿檔名與物件鍵，供回頭比對
    source_file: str | None = None


class DocumentStats(BaseModel):
    """校對介面第一眼要看的數字。由組裝階段算出來，不是模型填的。"""

    questions: int = 0
    with_printed_answer: int = 0
    with_explanation: int = 0
    with_assets: int = 0
    groups: int = 0
    materials: int = 0
    unsupported: int = 0
    #: 平均信心，供「這一份要不要逐題細看」的判斷
    mean_confidence: float = 0.0


class ImportDocument(BaseModel):
    """
    一份原稿被理解之後的標準形狀。**這是存進系統的東西。**

    下游只認這個形狀，永遠不必知道原稿是哪一家出版社、哪一科、
    教用版還是學生版、原生 PDF 還是手機拍的。
    """

    schema_version: str = SCHEMA_VERSION
    document: DocumentMeta = Field(default_factory=DocumentMeta)
    assets: list[Asset] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)
    groups: list[Group] = Field(default_factory=list)
    questions: list[Question] = Field(default_factory=list)
    materials: list[Material] = Field(default_factory=list)
    issues: list[Issue] = Field(default_factory=list)
    stats: DocumentStats = Field(default_factory=DocumentStats)


# ═════════════════════════════════════════════════════════════════
# 驗證
#
# pydantic 管得到「單一物件的形狀」，管不到「物件之間的關係」。
# 而真正會出事的都是關係：題目指向不存在的題組、內容參照到不存在
# 的圖、統計數字與實際內容對不上。
# ═════════════════════════════════════════════════════════════════


#: 題幹在講「去看那張圖／那張表」。
#:
#: 物理是這件事最要命的科目：v–t 圖求位移、x–t 圖求速度、電路圖求
#: 電流、光路圖求成像——**圖就是題目本身**，沒有圖那一題完全不能作答。
#: 其他科漏一張圖多半還能猜，物理漏一張圖是零分。
#:
#: 型式刻意收得緊，而且是**拿真實講義量過的**。中文裡「表」與「圖」
#: 都身兼動詞與名詞，寬鬆的樣式會大量誤報：
#:
#:   「代表中國」      → 含「表中」
#:   「以上表現優異」  → 含「上表」
#:   「圖形表一圓」    → 含「表一」（這裡的「表」是「表示」，
#:                       「一圓」是「一個圓」，不是「表 1」）
#:
#: 最後那一條在翰林《數學(1)》4-3 圓與直線裡出現 9 次——早期的樣式
#: 會在那一份講義上丟出 9 筆假警報。誤報吃掉的是校對時間，
#: 而那是這個系統最稀缺的資源（50 題 20 分鐘）。
#:
#: 所以編號形式要求後面接的是邊界或引用語（「圖1所示」「表一，」），
#: 不能是名詞（「表一圓」）。
_REF_TAIL = r"(?=[\s、，。：；）)\]】]|$|所|中|之|的|可|為|列|資料|數據)"
_FIGURE_MENTION = re.compile(
    r"(?:如|依|由|見|參[考見]|據|根據)[右左上下本該]?[圖表]"
    r"|[右左上下附]圖"
    # 「圖中 4 秒的位置為 8 公尺」「圖中 PQ 代表切線」——物理的讀值題
    # 大量這樣寫。實測兩份數學講義上「圖中」只出現 2 次，兩次都是
    # 真的在指圖，零誤報。
    # 「表中」**不收**：「代表中國」「代表中央」會誤報，而那在歷史與
    # 公民很常見。少抓一點好過多吵一點。
    r"|圖中"
    r"|[右左上下附]表" + _REF_TAIL +
    r"|圖\s*[一二三四五六七八九十\d]+" + _REF_TAIL +
    r"|表\s*[一二三四五六七八九十\d]+" + _REF_TAIL
)

#: Markdown 表格。題幹裡直接排了表格就不算「引用了一張看不到的表」。
_MD_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$", re.MULTILINE)


def validate_document(doc: ImportDocument) -> list[Issue]:
    """
    跨物件的完整性檢查。回傳的 issue 會併進 `doc.issues`。

    **不拋例外。** 一份文件裡有三題有問題時，正確的處理是把那三題
    標出來讓人看，而不是讓整份匯入失敗——老師已經等了十分鐘。
    """
    found: list[Issue] = []
    asset_ids = {a.id for a in doc.assets}
    section_ids = {s.id for s in doc.sections}
    group_ids = {g.id for g in doc.groups}
    #: 題組共用的圖。子題的 `asset_ids` 可以是空的，圖掛在題組上——
    #: 不算進來的話，每一組實驗題的每一題都會被誤報成「圖不見了」。
    group_assets = {
        g.id: {m.group(1) for m in ASSET_REF.finditer(g.stimulus)} for g in doc.groups
    }

    def add(code: str, detail: str, **kw) -> None:
        found.append(Issue(code=code, detail=detail, **kw))

    # ── id 唯一 ──────────────────────────────────────────────────
    for name, items in (
        ("資產", doc.assets), ("節", doc.sections), ("題組", doc.groups),
        ("題目", doc.questions), ("教材", doc.materials),
    ):
        seen: set[str] = set()
        for it in items:
            if it.id in seen:
                add("duplicate_id", f"{name} id 重複：{it.id}", severity=Severity.ERROR)
            seen.add(it.id)

    # ── 參照解得開 ───────────────────────────────────────────────
    for q in doc.questions:
        if q.group_id and q.group_id not in group_ids:
            add("dangling_group", f"題目 {q.id} 指向不存在的題組 {q.group_id}",
                severity=Severity.ERROR, question_id=q.id)
        if q.section_id and q.section_id not in section_ids:
            add("dangling_section", f"題目 {q.id} 指向不存在的節 {q.section_id}",
                question_id=q.id)
        for aid in q.asset_ids:
            if aid not in asset_ids:
                add("dangling_asset", f"題目 {q.id} 指向不存在的資產 {aid}",
                    severity=Severity.ERROR, question_id=q.id)

        # ── 內容標記 ────────────────────────────────────────────
        for field_name, text in (
            ("題幹", q.stem),
            *((f"選項 {o.label}", o.content) for o in q.options),
            *((("詳解", q.explanation.body),) if q.explanation else ()),
        ):
            for problem in content_issues(text, asset_ids):
                add("content_markup", f"題目 {q.id} 的{field_name}：{problem}",
                    question_id=q.id, page=q.placement.page)

        # ── 文字裡引用的圖要出現在 asset_ids ────────────────────
        #
        # 兩邊冗餘是刻意的：`asset_ids` 讓下游查「哪些題目用到這張圖」
        # 時不必解析文字。但冗餘就會不同步，而不同步的症狀是
        # 「刪掉一張圖之後有幾題的題幹出現破圖，卻查不到是哪幾題」。
        referenced = {m.group(1) for m in ASSET_REF.finditer(q.stem)}
        for o in q.options:
            referenced |= {m.group(1) for m in ASSET_REF.finditer(o.content)}
        missing = referenced - set(q.asset_ids)
        if missing:
            add("asset_not_listed",
                f"題目 {q.id} 的內容引用了 {sorted(missing)}，但沒有列進 asset_ids",
                question_id=q.id, page=q.placement.page)

        # ── 兩個選項一模一樣 ────────────────────────────────────
        #
        # 這是「有東西被讀掉了」最可靠的徵兆，而被讀掉的通常是最細的
        # 那一筆：向量的箭頭、指數的上標、負號、單位。物理與數學最常
        # 中招——$\vec{v}$ 與 $v$、$10^3$ 與 $103$、$-2$ 與 $2$。
        #
        # 症狀是**題目看起來完全正常**：選項數量對、答案是合法的序號、
        # 校對者一眼掃過去不會停。但兩個無法區分的選項意味著這一題
        # 沒有唯一解，而每一個選到「另一個一樣的」的學生都被判錯。
        if len(q.options) > 1:
            seen_content: dict[str, str] = {}
            for o in q.options:
                key = " ".join(o.content.split())
                if not key:
                    add("empty_option",
                        f"題目 {q.id} 的選項 {o.label} 是空的。"
                        f"抽不到選項內容的話，這一題不能拿去考學生",
                        severity=Severity.ERROR, question_id=q.id,
                        page=q.placement.page)
                elif key in seen_content:
                    add("duplicate_options",
                        f"題目 {q.id} 的選項 {seen_content[key]} 與 {o.label} 內容完全一樣"
                        f"（{key[:40]}）。多半是有東西被讀掉了——向量的箭頭、"
                        f"指數的上標、負號、單位。這一題目前沒有唯一解",
                        severity=Severity.ERROR, question_id=q.id,
                        page=q.placement.page)
                else:
                    seen_content[key] = o.label

        # ── 題幹說「如圖」，圖卻不在 ────────────────────────────
        have_assets = set(q.asset_ids) | group_assets.get(q.group_id or "", set())
        if not have_assets and not _MD_TABLE_ROW.search(q.stem):
            hit = _FIGURE_MENTION.search(q.stem)
            if hit:
                add("figure_missing",
                    f"題目 {q.id} 的題幹提到「{hit.group(0)}」，但這一題沒有接上"
                    f"任何圖表。學生會看到一句「如圖」與一片空白",
                    severity=Severity.ERROR, question_id=q.id,
                    page=q.placement.page)

        # ── 原稿說「應選 3 項」而答案只有 2 個 ──────────────────
        #
        # 免費的正確性檢查：原稿自己說了應該選幾個。對不上就一定是
        # 抽錯了，不必問模型也不必老師看。**只在原稿印了答案時才比**
        # ——沒印答案的學生版本來就沒有東西可以對。
        if (
            q.scoring.expected_count
            and q.answer.source is AnswerSource.PRINTED
            and q.answer.keys
            and len(q.answer.keys) != q.scoring.expected_count
        ):
            add("answer_count_mismatch",
                f"題目 {q.id} 原稿印著「應選 {q.scoring.expected_count} 項」，"
                f"但抽到的答案有 {len(q.answer.keys)} 個。"
                f"其中一邊讀錯了，而這一題現在不能用",
                severity=Severity.ERROR, question_id=q.id, page=q.placement.page)

        # ── 單位看不看得懂 ──────────────────────────────────────
        #
        # 只在**解析失敗**時出聲，所以不會誤報：系統看不懂那個單位，
        # 就不該在改考卷時宣稱兩種寫法等價，而該讓老師知道。
        if q.scoring.unit and q.scoring.unit_canonical.startswith("?"):
            add("unit_unparsed",
                f"題目 {q.id} 的單位「{q.scoring.unit}」系統看不懂。"
                f"自動改考卷時無法判斷 m/s^2 與 m·s⁻² 這類等價寫法，"
                f"會逐字比對",
                question_id=q.id, page=q.placement.page)

        # ── 出版社專屬題型要說得出它是什麼 ──────────────────────
        if q.kind is QuestionKind.PUBLISHER_CUSTOM:
            if not q.custom_type:
                add("custom_type_missing",
                    f"題目 {q.id} 標成出版社專屬題型卻沒有說明那是什麼。"
                    f"沒有 custom_type 的話，下游不知道學生要怎麼作答",
                    severity=Severity.ERROR, question_id=q.id)
            elif not q.custom_type.confirmed:
                add("custom_type_unconfirmed",
                    f"題目 {q.id} 是模型提議的新題型「{q.custom_type.name}」，"
                    f"尚未經老師確認。請確認這是什麼題型、學生怎麼作答、"
                    f"以及是否已取得出版社授權",
                    question_id=q.id, page=q.placement.page)

        # ── 逃生口用了就要說明 ──────────────────────────────────
        if q.kind is QuestionKind.OTHER:
            explained = any(
                i.question_id == q.id and i.code == "unsupported_content"
                for i in doc.issues
            )
            if not explained:
                add("other_without_issue",
                    f"題目 {q.id} 標成 OTHER 卻沒有說明它是什麼。"
                    f"OTHER 是逃生口，用了就要附一筆 unsupported_content 並保留原文",
                    severity=Severity.ERROR, question_id=q.id)

    for m in doc.materials:
        for aid in m.asset_ids:
            if aid not in asset_ids:
                add("dangling_asset", f"教材 {m.id} 指向不存在的資產 {aid}")
        for problem in content_issues(m.body, asset_ids):
            add("content_markup", f"教材 {m.id}：{problem}", page=m.placement.page)

    for g in doc.groups:
        if g.section_id and g.section_id not in section_ids:
            add("dangling_section", f"題組 {g.id} 指向不存在的節 {g.section_id}")
        for problem in content_issues(g.stimulus, asset_ids):
            add("content_markup", f"題組 {g.id} 的共用素材：{problem}",
                page=g.placement.page)

    # ── 孤兒題組 ─────────────────────────────────────────────────
    used_groups = {q.group_id for q in doc.questions if q.group_id}
    for g in doc.groups:
        if g.id not in used_groups:
            add("orphan_group",
                f"題組 {g.id} 沒有任何子題。共用素材抽出來了但題目沒接上，"
                f"學生會看到一段沒有問題的文章",
                page=g.placement.page)

    return found


def recompute_stats(doc: ImportDocument) -> DocumentStats:
    """統計由程式算，不讓模型填——模型算數字會算錯，而且沒必要。"""
    qs = doc.questions
    return DocumentStats(
        questions=len(qs),
        with_printed_answer=sum(1 for q in qs if q.answer.source is AnswerSource.PRINTED),
        with_explanation=sum(1 for q in qs if q.explanation),
        with_assets=sum(1 for q in qs if q.asset_ids),
        groups=len(doc.groups),
        materials=len(doc.materials),
        unsupported=sum(1 for i in doc.issues if i.code == "unsupported_content"),
        mean_confidence=round(sum(q.confidence.score for q in qs) / len(qs), 3) if qs else 0.0,
    )


def finalize(doc: ImportDocument) -> ImportDocument:
    """
    驗證、補統計、排序。**存進系統之前一定要跑這一支。**

    排序照頁碼與版面位置，讓校對介面的順序與原稿一致——老師是
    對著紙本校對的，順序不一樣會讓每一題都要重新找。
    """
    doc.issues.extend(validate_document(doc))

    def key(item) -> tuple:
        p = item.placement
        b = p.bbox
        return (p.page, round(b.y0, 3) if b else 0.0, round(b.x0, 3) if b else 0.0)

    doc.sections.sort(key=key)
    doc.groups.sort(key=key)
    doc.questions.sort(key=key)
    doc.materials.sort(key=key)
    doc.assets.sort(key=key)

    doc.stats = recompute_stats(doc)
    doc.schema_version = SCHEMA_VERSION
    return doc


def json_schema() -> dict:
    """
    輸出 JSON Schema，供其他工具驗證。

    這是「交換格式」名副其實的地方：老師若要把題庫轉出去給別的
    系統，或別的系統要轉進來，靠的是這一份而不是讀我們的原始碼。
    """
    schema = ImportDocument.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = f"https://yunzhi.local/schema/qif-{SCHEMA_VERSION}.json"
    schema["title"] = f"雲端智學題目交換格式 v{SCHEMA_VERSION}"
    return schema


# ═════════════════════════════════════════════════════════════════
# 逐頁閱讀 → 整份文件
#
# 模型一次讀一頁（輸出長度有限，一次讀 30 頁會被截斷），程式負責
# 把各頁組裝成一份文件。分工的理由：
#
#   模型做的是「這一頁上有什麼」——需要看得懂版面，只有它做得到。
#   程式做的是「跨頁合併、id 去重、統計、排序」——確定性的工作，
#   交給模型只會得到不確定的結果，而且貴。
# ═════════════════════════════════════════════════════════════════


class PageReading(BaseModel):
    """模型讀一頁的產出。欄位與 ImportDocument 對應，但只涵蓋這一頁。"""

    #: 這一頁看到的科目／體例／版本線索。各頁可能不一致（一份檔案
    #: 前半是講義後半是試卷），組裝時取多數決。
    subject: SubjectCode = SubjectCode.UNKNOWN
    genre: Genre = Genre.UNKNOWN
    edition: Edition = Edition.UNKNOWN
    language: Literal["zh-Hant", "en", "mixed", "unknown"] = "unknown"
    #: 頁首頁尾印的章節。每一頁都印，取眾數就是整份的章節。
    textbook: TextbookRef = Field(default_factory=TextbookRef)

    assets: list[Asset] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)
    groups: list[Group] = Field(default_factory=list)
    questions: list[Question] = Field(default_factory=list)
    materials: list[Material] = Field(default_factory=list)
    issues: list[Issue] = Field(default_factory=list)


def _mode(values: list, default):
    """取眾數，忽略 UNKNOWN／空值。各頁不一致時以出現最多的為準。"""
    real = [v for v in values if v and v != default]
    return max(set(real), key=real.count) if real else default


def assemble(
    readings: list[tuple[int, PageReading]],
    *,
    source_file: str | None = None,
    page_count: int = 0,
) -> ImportDocument:
    """
    把逐頁的閱讀結果組裝成一份文件。

    **id 要加上頁碼前綴。** 模型是逐頁呼叫的，它不知道別頁用過什麼
    id，於是每一頁都可能吐出 `q1`。不加前綴的話，第 2 頁的 q1 會
    覆蓋第 1 頁的 q1——而症狀是「匯入 30 頁只出來 4 題」。
    """
    doc = ImportDocument()
    remap: dict[tuple[int, str], str] = {}

    def uid(page: int, kind: str, raw: str) -> str:
        # 前綴用頁碼與型別，尾巴保留模型給的 id 讓人看得懂
        clean = re.sub(r"[^A-Za-z0-9_-]", "", raw)[:12] or "x"
        new = f"p{page}{kind}{clean}"[:32]
        remap[(page, raw)] = new
        return new

    def ref(page: int, raw: str | None) -> str | None:
        return remap.get((page, raw)) if raw else None

    for page, r in readings:
        for a in r.assets:
            a.id = uid(page, "a", a.id)
            doc.assets.append(a)
        for s in r.sections:
            s.id = uid(page, "s", s.id)
            doc.sections.append(s)
        for g in r.groups:
            g.id = uid(page, "g", g.id)
            doc.groups.append(g)
        for m in r.materials:
            m.id = uid(page, "m", m.id)
            doc.materials.append(m)
        for q in r.questions:
            q.id = uid(page, "q", q.id)
            doc.questions.append(q)

    # 第二輪才改參照：同一頁的題目可能指向同一頁稍後才出現的題組。
    for page, r in readings:
        for q in r.questions:
            q.group_id = ref(page, q.group_id) or None
            q.section_id = ref(page, q.section_id) or None
            q.asset_ids = [ref(page, a) or a for a in q.asset_ids]
            q.stem = _remap_refs(q.stem, page, remap)
            for o in q.options:
                o.content = _remap_refs(o.content, page, remap)
            if q.explanation:
                q.explanation.body = _remap_refs(q.explanation.body, page, remap)
        for g in r.groups:
            g.section_id = ref(page, g.section_id) or None
            g.stimulus = _remap_refs(g.stimulus, page, remap)
        for m in r.materials:
            m.section_id = ref(page, m.section_id) or None
            m.asset_ids = [ref(page, a) or a for a in m.asset_ids]
            m.body = _remap_refs(m.body, page, remap)
        for i in r.issues:
            i.question_id = ref(page, i.question_id) or i.question_id
            i.raw_asset_id = ref(page, i.raw_asset_id) or i.raw_asset_id
            if i.page is None:
                i.page = page
            doc.issues.append(i)

    pages = [r for _, r in readings]
    doc.document = DocumentMeta(
        subject=_mode([r.subject for r in pages], SubjectCode.UNKNOWN),
        genre=_mode([r.genre for r in pages], Genre.UNKNOWN),
        edition=_mode([r.edition for r in pages], Edition.UNKNOWN),
        language=_mode([r.language for r in pages], "unknown"),
        textbook=TextbookRef(
            publisher=_mode([r.textbook.publisher for r in pages], None),
            book=_mode([r.textbook.book for r in pages], None),
            volume=_mode([r.textbook.volume for r in pages], None),
            chapter=_mode([r.textbook.chapter for r in pages], None),
            unit=_mode([r.textbook.unit for r in pages], None),
        ),
        page_count=page_count or len(readings),
        source_file=source_file,
    )
    return finalize(doc)


def _remap_refs(text: str, page: int, remap: dict) -> str:
    """把內容標記裡的 `![[a:舊id]]` 換成加了頁碼前綴的新 id。"""
    return ASSET_REF.sub(
        lambda m: f"![[a:{remap.get((page, m.group(1)), m.group(1))}]]", text
    )
