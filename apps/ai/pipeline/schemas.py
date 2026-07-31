"""
雲端智學 — 匯入管線的結構化輸出定義

所有 AI 呼叫都要求回傳符合這些 schema 的 JSON，並在應用層嚴格驗證。
驗證失敗就重試，重試仍失敗降級為人工。

這一條紀律擋掉了大量下游的錯誤處理複雜度，也是提示詞注入防護的
第一道防線——被誘導後產出的內容過不了 schema 驗證。

結構全部依 115 學測真實試卷的體例，不是憑印象設計的：
  · 選項數不固定（數學 5 個、英文 4 個）
  · 多選題有多個正解，且部分給分
  · 選填題的答案要填進答案卡上編號的格位（⑬⑭）
  · 題組共用前導敘述，子題編號用全形（a）（b）
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator


class QuestionType(str, Enum):
    SINGLE_CHOICE = "SINGLE_CHOICE"
    MULTI_CHOICE = "MULTI_CHOICE"
    FILL_SLOT = "FILL_SLOT"
    FILL_TEXT = "FILL_TEXT"
    SHORT_ANSWER = "SHORT_ANSWER"
    ESSAY = "ESSAY"
    TRANSLATION = "TRANSLATION"
    TRUE_FALSE = "TRUE_FALSE"


#: 沒有標準答案、只有評分原則的題型。這些不跑 AI 自答。
OPEN_ENDED = {
    QuestionType.SHORT_ANSWER,
    QuestionType.ESSAY,
    QuestionType.TRANSLATION,
}

#: 選擇題。跑自答且答案空間小，投票次數較少即可。
CHOICE = {
    QuestionType.SINGLE_CHOICE,
    QuestionType.MULTI_CHOICE,
    QuestionType.TRUE_FALSE,
}


# ─────────────────────────────────────────────────────────────────
# 階段二：版面分析與切題
# ─────────────────────────────────────────────────────────────────


class BBox(BaseModel):
    """原稿座標，供校對介面左右連動。單位為頁面寬高的比例（0–1）。"""

    page: int = Field(ge=1)
    x0: float = Field(ge=0, le=1)
    y0: float = Field(ge=0, le=1)
    x1: float = Field(ge=0, le=1)
    y1: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def _ordered(self) -> "BBox":
        if self.x1 <= self.x0 or self.y1 <= self.y0:
            raise ValueError("bbox 的右下角必須大於左上角")
        return self


class BlockType(str, Enum):
    SECTION_HEADER = "SECTION_HEADER"   # 「第壹部分、選擇（填）題（占 85 分）」
    SECTION_NOTE = "SECTION_NOTE"       # 「說明：第 1 題至第 6 題…」
    GROUP_LEAD = "GROUP_LEAD"           # 題組的前導敘述
    QUESTION_NO = "QUESTION_NO"
    STEM = "STEM"
    OPTION = "OPTION"
    FIGURE = "FIGURE"
    TABLE = "TABLE"
    ANSWER_AREA = "ANSWER_AREA"         # 非選題的作答區（空白，給學生寫）
    EXPLANATION = "EXPLANATION"         # 詳解區塊，另走解析匯入
    HEADER_FOOTER = "HEADER_FOOTER"

    # ── 以下是講義體例，學測試卷不會出現 ────────────────────────
    # 補習班日常用的是講義而不是試卷（訪談第 9 題：「可以參考學測、
    # 但有時候會有作業或小考」），而講義的結構完全不同：
    # 沒有「一、單選題（占 30 分）」，有的是「範例 1」「類題」「解」。
    EXERCISE_HEADER = "EXERCISE_HEADER"  # 「範例 1」「類題 2」「習題」
    ANSWER_KEY = "ANSWER_KEY"            # 「答：　(B)」教用版直接印答案
    TEACHING_NOTE = "TEACHING_NOTE"      # 「說明：…」「註：…」教學內容，不是題目
    CONCEPT = "CONCEPT"                  # 觀念條列：「1. 點斜式：…」


class LayoutBlock(BaseModel):
    type: BlockType
    bbox: BBox
    text: str = ""
    #: 本題是否延續自前頁／延續至次頁。跨頁題目靠這兩個旗標合併。
    continued_from_prev: bool = False
    continues_to_next: bool = False
    #: 教用版裡印成答案墨色的片段。text 已經是拿掉這些之後的學生版，
    #: 兩者分開存是因為它們的著作權地位不同（文件 16 §3）。
    answers: list[str] = Field(default_factory=list)


class SegmentResult(BaseModel):
    blocks: list[LayoutBlock]
    #: 「37-39 題為題組」這類指示語偵測到的題組範圍
    group_ranges: list[str] = Field(default_factory=list)


# ─────────────────────────────────────────────────────────────────
# 階段三：內容結構化
# ─────────────────────────────────────────────────────────────────


class OptionOut(BaseModel):
    """
    一個選項。

    別名是給模型的餘裕：提示詞沒有附 schema，模型很常回
    `{"key": "A", "text": "..."}`。**只認等價的寫法，不猜語意。**
    """

    model_config = ConfigDict(populate_by_name=True)

    order: int = Field(ge=1, le=10)
    label: str = Field(validation_alias=AliasChoices("label", "key", "letter", "marker"))
    content: str = Field(validation_alias=AliasChoices("content", "text", "value"))


class AnswerSlot(BaseModel):
    """選填題的答案格位。學測答案卡上的格子有編號（⑬⑭）。"""

    slot: str
    value: str


class ConfidenceReason(BaseModel):
    """
    扣分理由。**必須具體到校對者知道要看哪裡**——
    「信心較低」沒有用，「選項 (1) 與 (3) 數值相等，疑為印刷錯誤」才有用。
    這是 50 題 20 分鐘目標的關鍵：校對者只細看被指出的地方。
    """

    code: str
    detail: str
    severity: Literal["info", "warn", "error"] = "warn"


class StructuredQuestion(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: 別名是給模型的餘裕：提示詞沒有附 schema，模型很常回 `number`／
    #: `stem`。**只認等價的寫法，不猜語意。**
    question_no: str = Field(
        validation_alias=AliasChoices("question_no", "number", "no", "q_no", "num")
    )
    sub_label: str | None = None        # 混合題子題：「（a）」，全形
    group_key: str | None = None
    type: QuestionType
    content: str = Field(validation_alias=AliasChoices("content", "stem", "text", "body"))
    options: list[OptionOut] = Field(default_factory=list)
    answer_slots: list[AnswerSlot] = Field(default_factory=list)
    score: float | None = None
    has_figure: bool = False
    figure_alt: str | None = None
    source_bbox: BBox | None = None
    #: 題目旁邊印的出處標籤：「112學測」。只在原稿真的印了才填。
    source_exam: str | None = None
    #: 原稿印的**全國**答對率（0–1）。社會與英文的講義幾乎每題都印。
    #: 這是大考中心的實測難度，比任何模型估的都準——一道題入庫當天
    #: 就有校準過的難度，不必等我們自己的學生作答幾百次。
    #: **只在原稿印了才填，絕對不可推估。** 一個編出來的答對率會被
    #: 當成實測值寫進題庫，之後再也分不出真假。
    national_correct_rate: float | None = Field(default=None, ge=0, le=1)
    #: 缺漏時預設 0（最低），**不是**猜一個高分。信心分數決定校對者
    #: 先看哪幾題，預設高等於安靜地把沒把握的題目送進題庫。
    confidence: float = Field(default=0.0, ge=0, le=1)
    confidence_reasons: list[ConfidenceReason] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _fill_option_order(cls, data):
        """
        選項沒給 `order` 時依出現順序補 1、2、3…

        模型很常回 `{"key": "A", "text": "…"}` 而漏掉 order——那是它
        看不到 schema 的必然結果。順序本來就是陣列順序，補得回來，
        沒必要為此讓整頁重跑一次（一次重跑就是一次 AI 費用）。
        """
        if isinstance(data, dict):
            opts = data.get("options")
            if isinstance(opts, list):
                for i, o in enumerate(opts, start=1):
                    if isinstance(o, dict) and o.get("order") is None:
                        o["order"] = i
        return data

    @field_validator("content")
    @classmethod
    def _stem_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("題幹不得為空")
        return v

    @model_validator(mode="after")
    def _consistent(self) -> "StructuredQuestion":
        # 選擇題必須有選項。抽不到選項卻標成選擇題，是很常見的抽取錯誤，
        # 在這裡擋下來比讓它進到校對介面好。
        if self.type in CHOICE and self.type != QuestionType.TRUE_FALSE:
            if len(self.options) < 2:
                raise ValueError(f"{self.type} 至少需要 2 個選項，實得 {len(self.options)}")
            orders = [o.order for o in self.options]
            if sorted(orders) != list(range(1, len(orders) + 1)):
                raise ValueError(f"選項序號必須從 1 連續，實得 {sorted(orders)}")

        # 非選題不應該有選項
        if self.type in OPEN_ENDED and self.options:
            raise ValueError(f"{self.type} 不應有選項")

        return self


class ExtractResult(BaseModel):
    questions: list[StructuredQuestion]
    group_stimuli: dict[str, str] = Field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────
# 整頁閱讀（模型為主的抽取）
#
# 原本的流程是「切分（版面）→ 結構化（內容）」兩段，切分在原生 PDF
# 上走純程式的規則。那條路的問題不是不準，是**每加一種體例就要打
# 一批新規則，而新規則會打壞舊的**：加英文的作答括號支援時，
# `(A) 4.5 公尺` 被判成題號，於是憑空生出標準答案。
#
# 改成把整頁的影像交給模型讀，一次產出版面區塊與題目。規則路徑
# 保留下來當**交叉驗證**——兩邊不一致的題目自動標成存疑，讓校對者
# 優先看那幾題。規則是純程式，多跑一次的成本是零。
# ─────────────────────────────────────────────────────────────────


class ReadQuestion(StructuredQuestion):
    """
    模型從整頁讀出來的一題。

    比 `StructuredQuestion` 多了三類「原稿上看得到」的東西。分開放
    而不是併進題幹，是因為它們的**著作權地位不同**：試題依著作權法
    第 9 條不受保護，詳解受保護（文件 16 §3）。
    """

    #: 原稿印出來的答案（教用版）。選擇題填選項序號，1 起算。
    #: **只有原稿真的印了才填。** 推論出來的答案走自答階段，
    #: 那條路有投票與一致率，這裡沒有。
    printed_answer_keys: list[int] = Field(default_factory=list)
    printed_answer_text: str | None = None
    #: 原稿的詳解原文。受著作權保護，與題幹分開存、分開判斷權利。
    explanation: str | None = None
    #: 題幹延續到下一頁。跨頁題目靠這個合併。
    continues_to_next: bool = False
    #: 講義的題目標頭：「範例 3」「類題 1」「Quiz Time」
    label: str | None = None

    @model_validator(mode="after")
    def _printed_keys_in_range(self) -> "ReadQuestion":
        # 答案指向不存在的選項是最危險的一種錯：題目看起來完全正常，
        # 只是每個答對的學生都會被判錯。這裡就擋掉。
        if self.printed_answer_keys and self.options:
            n = len(self.options)
            bad = [k for k in self.printed_answer_keys if k < 1 or k > n]
            if bad:
                raise ValueError(
                    f"印出來的答案 {bad} 超出選項範圍（本題共 {n} 個選項）"
                )
        return self


class ReadResult(BaseModel):
    """一次呼叫（一頁，含次頁作為上下文）讀出來的東西。"""

    #: 版面區塊。供校對介面的左右連動與附圖裁切；bbox 是頁面比例。
    blocks: list[LayoutBlock] = Field(default_factory=list)
    #: 這一頁**開始**的題目。跨頁題目在起始頁完整輸出，不要重複。
    questions: list[ReadQuestion] = Field(default_factory=list)
    #: 講義的觀念頁與教學說明。不是題目，但智慧老師要用它來
    #: 「退回去補前置觀念」——同一份 PDF 裡本來就有，丟掉可惜。
    materials: list["ReadMaterial"] = Field(default_factory=list)
    genre: Literal["exam", "worksheet", "material", "unknown"] = "unknown"
    #: 模型自己說不確定的地方。這會直接變成校對介面的提示，
    #: 所以要具體到「校對者知道要看哪裡」。
    unsure: list[str] = Field(default_factory=list)


class ReadMaterial(BaseModel):
    """講義的觀念頁：文法表格、公式整理、例句對照。"""

    title: str
    body: str
    bbox: BBox | None = None


ReadResult.model_rebuild()


# ─────────────────────────────────────────────────────────────────
# 階段四：答案處理
# ─────────────────────────────────────────────────────────────────


class SolveAttempt(BaseModel):
    """單次推導。低一致率時整批呈現給老師裁決。"""

    approach: str
    reasoning: str
    answer_keys: list[int] = Field(default_factory=list)
    answer_slots: list[AnswerSlot] = Field(default_factory=list)
    answer_text: str | None = None


class SolveResult(BaseModel):
    attempts: list[SolveAttempt]
    #: 一致率＝最高票數 ÷ 總次數。用比例而非絕對票數，
    #: 讓門檻不隨投票次數改變而失效。
    consistency: float = Field(ge=0, le=1)
    consensus_keys: list[int] = Field(default_factory=list)
    consensus_slots: list[AnswerSlot] = Field(default_factory=list)
    consensus_text: str | None = None

    @property
    def tier(self) -> Literal["high", "mid", "low"]:
        if self.consistency >= 1.0:
            return "high"
        if self.consistency >= 0.6:
            return "mid"
        return "low"

    @property
    def should_autofill(self) -> bool:
        """
        一致率低於 0.6 時**不填入任何答案**，而是把所有候選與各自的
        推導並列給老師裁決。強行給一個答案會讓老師誤信。
        """
        return self.consistency >= 0.6


# ─────────────────────────────────────────────────────────────────
# 階段六：知識點標註
# ─────────────────────────────────────────────────────────────────


class KpPick(BaseModel):
    kp_id: str
    weight: float = Field(gt=0, le=1)
    evidence: str

    @field_validator("evidence")
    @classmethod
    def _evidence_required(cls, v: str) -> str:
        # 「這題考三角函數」不夠，要「依據是題幹第二行的 sin(A+B) 展開」。
        # 有依據，老師的校對成本才會低。
        if len(v.strip()) < 4:
            raise ValueError("必須說明判定依據")
        return v


class AnnotateResult(BaseModel):
    #: 只能從候選中選，不得自由生成。模型幻覺出不存在的知識點名稱，
    #: 會讓同一個概念在系統中有五種寫法，整個能力分析失效。
    picks: list[KpPick] = Field(max_length=3)
    no_suitable_candidate: bool = False
    difficulty: float = Field(ge=0, le=1)
    bloom_level: Literal[
        "REMEMBER", "UNDERSTAND", "APPLY", "ANALYZE", "EVALUATE", "CREATE"
    ]
    bloom_level_legacy: Literal[
        "KNOWLEDGE", "COMPREHENSION", "APPLICATION", "ANALYSIS", "SYNTHESIS", "EVALUATION"
    ]
    est_time_seconds: int = Field(ge=5, le=3600)

    @model_validator(mode="after")
    def _weights(self) -> "AnnotateResult":
        if self.no_suitable_candidate:
            if self.picks:
                raise ValueError("既然沒有合適候選，就不應該挑出知識點")
            return self
        if not self.picks:
            raise ValueError("必須挑出至少一個知識點，或明確標示沒有合適候選")
        total = sum(p.weight for p in self.picks)
        if abs(total - 1.0) > 0.02:
            raise ValueError(f"權重總和須為 1.0，實得 {total:.3f}")
        return self


# ─────────────────────────────────────────────────────────────────
# 評分原則抽取（大考中心的非選擇題評分原則）
# ─────────────────────────────────────────────────────────────────


class RubricBandOut(BaseModel):
    grade: str
    score_max: float
    score_min: float
    descriptor: str


class RubricDimensionOut(BaseModel):
    name: str
    name_en: str | None = None
    max_score: float
    descriptor: str | None = None
    bands: list[RubricBandOut] = Field(default_factory=list)


class RubricOut(BaseModel):
    name: str
    total_score: float
    mode: Literal["BAND", "DIMENSION", "DEDUCTION"]
    bands: list[RubricBandOut] = Field(default_factory=list)
    dimensions: list[RubricDimensionOut] = Field(default_factory=list)

    @model_validator(mode="after")
    def _invariants(self) -> "RubricOut":
        """
        機械不變量。文件 16 §4.1：這一層攔截率最高且零成本，
        而且**不會有相關失效**——它不依賴任何模型判斷。
        """
        if self.mode == "BAND":
            if not self.bands:
                raise ValueError("BAND 模式必須有等第")
            bands = sorted(self.bands, key=lambda b: b.score_max, reverse=True)

            # 最高等第的上限必須等於配分
            if abs(bands[0].score_max - self.total_score) > 0.01:
                raise ValueError(
                    f"最高等第上限 {bands[0].score_max} 與配分 {self.total_score} 不符"
                )
            # 區間必須連續且不重疊
            for hi, lo in zip(bands, bands[1:]):
                if abs(hi.score_min - lo.score_max - 1) > 0.51:
                    raise ValueError(
                        f"等第 {hi.grade}({hi.score_min}) 與 {lo.grade}({lo.score_max}) "
                        f"之間不連續或重疊"
                    )
            # 必須有一個 0 分等第（空白卷、文不對題）
            if not any(b.score_max == 0 for b in bands):
                raise ValueError("缺少 0 分等第")
            if not 3 <= len(bands) <= 10:
                raise ValueError(f"等第數 {len(bands)} 超出合理範圍，疑為抽取錯誤")

        if self.mode == "DIMENSION":
            if not self.dimensions:
                raise ValueError("DIMENSION 模式必須有評分維度")
            total = sum(d.max_score for d in self.dimensions)
            if abs(total - self.total_score) > 0.01:
                raise ValueError(f"各維度上限加總 {total} 與配分 {self.total_score} 不符")

        return self
