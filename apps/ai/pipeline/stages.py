"""
雲端智學 — 匯入管線各階段

每階段的產出都持久化，任何階段失敗可以從該點重跑而不必從頭來過。
一份 200 頁的題本解析到第 7 階段才失敗時，這件事的價值很明顯。

階段：
  1 正規化   PDF/DOCX/影像 → 頁面影像 ＋ 可選文字層
  2 切題     版面分析，跨頁合併，題組識別
  3 結構化   → StructuredQuestion
  4 答案     隨附／獨立答案卷對齊／AI 自答（self-consistency）
  5 解析     見文件 03 §2.5，本檔不含
  6 標註     知識點（先檢索後選擇）、難度、Bloom
  7 去重     雜湊 ＋ 向量相似度
  8 校對入庫 由 Web 端進行
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from collections import Counter
from dataclasses import dataclass
from typing import Any

from providers import BaseProvider, ContentRefused, FatalError, ProviderError

from .prompts import (
    ANNOTATE_SYSTEM,
    PROMPT_VERSION,
    RUBRIC_SYSTEM,
    SOLVE_APPROACHES,
    SOLVE_SYSTEM,
    STRUCTURE_SYSTEM,
    annotate_user,
    rubric_user,
    solve_user,
    structure_user,
)
from .schemas import (
    CHOICE,
    OPEN_ENDED,
    AnnotateResult,
    AnswerSlot,
    ExtractResult,
    QuestionType,
    RubricOut,
    SolveAttempt,
    SolveResult,
    StructuredQuestion,
)

log = logging.getLogger("yunzhi.ai.pipeline")


class StageError(Exception):
    """階段失敗。帶著階段名稱，讓重跑知道從哪裡開始。"""

    def __init__(self, stage: str, message: str, *, retryable: bool = True):
        super().__init__(f"[{stage}] {message}")
        self.stage = stage
        self.retryable = retryable


# ─────────────────────────────────────────────────────────────────
# 結構化輸出的取得與驗證
# ─────────────────────────────────────────────────────────────────

_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def _parse_json(text: str) -> Any:
    """
    模型偶爾會把 JSON 包在 markdown 圍籬裡，或在前後加一句說明。
    與其在提示詞裡一再強調「只輸出 JSON」，不如在這裡容錯——
    前者不可靠，後者是確定的。
    """
    text = text.strip()
    if m := _JSON_FENCE.search(text):
        text = m.group(1).strip()
    if not text.startswith(("{", "[")):
        start = min(
            (i for i in (text.find("{"), text.find("[")) if i >= 0),
            default=-1,
        )
        if start < 0:
            raise ValueError(f"回應中找不到 JSON：{text[:200]}")
        text = text[start:]
    # 尾端可能有多餘文字，從最後一個閉合括號截斷
    for close in ("}", "]"):
        idx = text.rfind(close)
        if idx > 0:
            try:
                return json.loads(text[: idx + 1])
            except json.JSONDecodeError:
                continue
    return json.loads(text)


async def _structured(
    provider: BaseProvider,
    *,
    model_cls,
    system: str,
    user: str,
    tier: str = "MID",
    max_tokens: int = 8192,
    temperature: float = 0.0,
    attempts: int = 3,
    images: list[bytes] | None = None,
):
    """
    要求結構化輸出並驗證。驗證失敗時把錯誤訊息回饋給模型再試——
    這比單純重試有效得多，因為模型看得到自己哪裡不合規。
    """
    last_err: str | None = None
    for i in range(attempts):
        prompt = user
        if last_err:
            prompt = (
                f"{user}\n\n"
                f"你上一次的輸出未通過驗證，錯誤如下：\n{last_err}\n"
                f"請修正後重新輸出完整的 JSON。"
            )
        completion = await provider.complete(
            tier=tier,  # type: ignore[arg-type]
            system=system,
            user=prompt,
            max_tokens=max_tokens,
            temperature=temperature if i == 0 else min(0.3, temperature + 0.1 * i),
            images=images,
        )
        try:
            return model_cls.model_validate(_parse_json(completion.text)), completion
        except Exception as e:  # pydantic ValidationError 或 JSON 錯誤
            last_err = str(e)[:600]
            log.warning("結構化輸出驗證失敗（第 %d/%d 次）：%s", i + 1, attempts, last_err)
    raise StageError("structured", f"連續 {attempts} 次未能取得合規輸出：{last_err}")


# ─────────────────────────────────────────────────────────────────
# 階段三：內容結構化
# ─────────────────────────────────────────────────────────────────


@dataclass
class SectionContext:
    """
    本節的體例。從「一、單選題（占 30 分）」與其下的「說明：…」抽出，
    用來推定該節題目的題型與配分——原稿常常不逐題標配分。
    """

    title: str = ""
    note: str = ""
    default_type: QuestionType | None = None
    default_score: float | None = None
    #: 節總分，供「各題配分加總 = 節總分」的機械檢核
    section_total: float | None = None

    def as_prompt(self) -> str:
        parts = []
        if self.title:
            parts.append(f"節標題：{self.title}")
        if self.note:
            parts.append(f"節說明：{self.note}")
        if self.default_type:
            parts.append(f"本節題型推定：{self.default_type.value}")
        if self.default_score is not None:
            parts.append(f"本節每題配分推定：{self.default_score}")
        return "\n".join(parts) or "（無節資訊）"


_SECTION_TYPE = [
    (re.compile(r"單選"), QuestionType.SINGLE_CHOICE),
    (re.compile(r"多選"), QuestionType.MULTI_CHOICE),
    (re.compile(r"選填"), QuestionType.FILL_SLOT),
    (re.compile(r"混合題|非選擇題"), QuestionType.SHORT_ANSWER),
]
#: 每題配分。真實題本的寫法變化很多，逐一列出而不是用一個寬鬆的
#: 正則——寬鬆的會把「（占 30 分）」（節總分）或「有 5 個選項」
#: 誤抓成每題配分。依優先序比對，先命中者為準。
_SCORE_PER_PATTERNS = [
    re.compile(r"每題\s*([0-9]+(?:\.[0-9]+)?)\s*分"),                    # 每題 2 分
    re.compile(r"每題[^，。；]{0,14}?給\s*([0-9]+(?:\.[0-9]+)?)\s*分"),   # 每題完全答對給 5 分
    re.compile(r"每題[^，。；]{0,14}?得\s*([0-9]+(?:\.[0-9]+)?)\s*分"),
    re.compile(r"各題[^，。；]{0,14}?得\s*(?:該題)?\s*([0-9]+(?:\.[0-9]+)?)\s*分"),  # 各題答對者，得 5 分
    re.compile(r"答對者?[，、]?\s*得\s*(?:該題)?\s*([0-9]+(?:\.[0-9]+)?)\s*分"),
]
#: 節總分「（占 85 分）」。供加總檢核，不是每題配分。
_SECTION_TOTAL = re.compile(r"占\s*([0-9]+(?:\.[0-9]+)?)\s*分")


def parse_section(title: str, note: str) -> SectionContext:
    """
    純程式解析節標題與說明。這些是高度規則化的文字，
    用正則比呼叫模型準確也便宜——**能用程式做的就不要用 AI**。
    """
    ctx = SectionContext(title=title.strip(), note=note.strip())
    blob = f"{title} {note}"
    for pat, qt in _SECTION_TYPE:
        if pat.search(blob):
            ctx.default_type = qt
            break
    for pat in _SCORE_PER_PATTERNS:
        if m := pat.search(blob):
            ctx.default_score = float(m.group(1))
            break
    # 節總分只從標題抓，不從說明抓——說明裡的「分」多半是計分規則
    if m := _SECTION_TOTAL.search(title):
        ctx.section_total = float(m.group(1))
    return ctx


def check_section_totals(
    section: SectionContext, questions: list[StructuredQuestion]
) -> str | None:
    """
    機械不變量：各題配分加總必須等於節總分。

    零成本、且**不會有相關失效**（文件 16 §4.1）——它不依賴任何模型
    判斷，純粹是算術。OCR 把配分讀錯或漏切一題時，加總就對不起來。
    """
    if section.section_total is None:
        return None
    total = sum(q.score or 0 for q in questions)
    if abs(total - section.section_total) < 0.01:
        return None
    return (
        f"本節各題配分加總為 {total:g}，與節標題所載「占 {section.section_total:g} 分」不符"
        f"（差 {section.section_total - total:+g}）。可能有題目的配分讀錯，或有題目未被切出。"
    )


async def structure_questions(
    provider: BaseProvider, blocks_text: str, section: SectionContext
) -> tuple[ExtractResult, Any]:
    result, completion = await _structured(
        provider,
        model_cls=ExtractResult,
        system=STRUCTURE_SYSTEM,
        user=structure_user(blocks_text, section.as_prompt()),
        tier="MID",
        max_tokens=16384,
    )
    # 節資訊補洞：原稿常常不逐題標配分，靠節說明推定
    for q in result.questions:
        if q.score is None and section.default_score is not None:
            q.score = section.default_score
            q.confidence_reasons.append(
                type(q.confidence_reasons[0])(
                    code="score_inferred",
                    detail=f"本題配分未於原稿標示，依節說明「{section.note[:24]}…」推定為 {section.default_score} 分",
                    severity="info",
                )
                if q.confidence_reasons
                else _reason(
                    "score_inferred",
                    f"本題配分未於原稿標示，依節說明推定為 {section.default_score} 分",
                    "info",
                )
            )
    return result, completion


def _reason(code: str, detail: str, severity: str = "warn"):
    from .schemas import ConfidenceReason

    return ConfidenceReason(code=code, detail=detail, severity=severity)  # type: ignore[arg-type]


# ─────────────────────────────────────────────────────────────────
# 階段四：AI 自答（self-consistency 投票）
# ─────────────────────────────────────────────────────────────────


def _norm_answer(a: SolveAttempt) -> str:
    """把一次推導的答案正規化成可比對的鍵。"""
    if a.answer_keys:
        return "K:" + ",".join(str(k) for k in sorted(a.answer_keys))
    if a.answer_slots:
        return "S:" + ",".join(f"{s.slot}={s.value}" for s in a.answer_slots)
    if a.answer_text:
        # 數學等價的正規化：去空白、統一常見寫法。
        # 完整的等價判定用 SymPy，這裡只做便宜的前處理。
        t = re.sub(r"\s+", "", a.answer_text)
        t = t.replace("×", "*").replace("÷", "/")
        return "T:" + t
    return "EMPTY"


def votes_needed(qtype: QuestionType) -> int:
    """
    投票次數依題型。選擇題答案空間小，3 次的判別力已足夠；
    計算與非選題答案空間大，需要 5 次。
    這一項對成本影響不小（見文件 05 §5）。
    """
    if qtype in CHOICE:
        return 3
    if qtype in OPEN_ENDED:
        return 0  # 非選題沒有標準答案，不投票
    return 5


async def solve_question(
    provider: BaseProvider, q: StructuredQuestion, *, n: int | None = None
) -> SolveResult | None:
    """
    多次獨立推導後投票。**每次換一個切入角度**——相同提示重複問只會
    得到相同的錯誤，那是相關失效，投票就失去意義了。
    """
    votes = n if n is not None else votes_needed(q.type)
    if votes <= 0:
        return None

    opts = "\n".join(f"({o.order}) {o.content}" for o in q.options)

    async def one(idx: int) -> SolveAttempt | None:
        _, hint = SOLVE_APPROACHES[idx % len(SOLVE_APPROACHES)]
        try:
            attempt, _ = await _structured(
                provider,
                model_cls=SolveAttempt,
                system=SOLVE_SYSTEM,
                user=solve_user(q.content, opts, hint),
                tier="HIGH",  # 答錯會汙染題庫，錯誤代價最高
                max_tokens=4096,
                temperature=0.3,  # 需要一點多樣性，否則投票沒有意義
                attempts=2,
            )
            return attempt
        except (StageError, ProviderError) as e:
            log.warning("自答第 %d 次失敗：%s", idx + 1, e)
            return None

    attempts = [a for a in await asyncio.gather(*(one(i) for i in range(votes))) if a]
    if not attempts:
        return None

    tally = Counter(_norm_answer(a) for a in attempts)
    top, count = tally.most_common(1)[0]
    consistency = count / len(attempts)

    winner = next(a for a in attempts if _norm_answer(a) == top)
    return SolveResult(
        attempts=attempts,
        consistency=consistency,
        consensus_keys=winner.answer_keys if top.startswith("K:") else [],
        consensus_slots=winner.answer_slots if top.startswith("S:") else [],
        consensus_text=winner.answer_text if top.startswith("T:") else None,
    )


def apply_solve(q: StructuredQuestion, sr: SolveResult | None) -> dict[str, Any]:
    """
    把自答結果套用到候選題上，並產生對校對者有用的理由。

    一致率低於 0.6 時**不填入任何答案**，而是把所有候選與各自的推導
    並列呈現。老師看到「五次推導中兩次得 (1)、兩次得 (3)、分歧點在
    第二步的取值範圍」會立刻警覺這題有陷阱；看到單一答案則可能誤信。
    """
    if sr is None:
        return {"answerOrigin": None}

    out: dict[str, Any] = {
        "answerOrigin": "AI_SOLVED",
        "selfConsistency": sr.consistency,
        "solveTrace": [a.model_dump() for a in sr.attempts],
    }
    if sr.should_autofill:
        out["answerKeys"] = sr.consensus_keys
        out["answerSlots"] = [s.model_dump() for s in sr.consensus_slots]
        out["answerText"] = sr.consensus_text

    if sr.tier == "high":
        out["reason"] = _reason(
            "solve_high",
            f"題本未附答案，由 AI 獨立推導 {len(sr.attempts)} 次，結果完全一致。",
            "info",
        )
    elif sr.tier == "mid":
        alts = Counter(_norm_answer(a) for a in sr.attempts)
        out["reason"] = _reason(
            "solve_mid",
            f"AI 推導 {len(sr.attempts)} 次，一致率 {sr.consistency:.0%}"
            f"（分布 {dict(alts)}）。已填入多數答案，少數派的推導保留在下方供對照。",
            "warn",
        )
    else:
        out["reason"] = _reason(
            "solve_low",
            f"AI 推導 {len(sr.attempts)} 次未形成共識（一致率 {sr.consistency:.0%}），"
            f"**未填入答案**。各次推導並列於下方，請裁決。",
            "error",
        )
    return out


def cross_check_answer(
    q: StructuredQuestion, provided_keys: list[int], sr: SolveResult | None
) -> Any | None:
    """
    題本有附答案時，仍然跑一次自答做交叉驗證。

    成本很低但價值很高：不符時要嘛是答案欄讀錯，要嘛是題本本身印錯
    （實務上比想像中常見）。兩種都值得標記給老師看。
    """
    if sr is None or not provided_keys or not sr.consensus_keys:
        return None
    if sorted(provided_keys) == sorted(sr.consensus_keys):
        return None
    return _reason(
        "answer_conflict",
        f"題本所附答案為 {provided_keys}，但 AI 獨立推導得到 {sr.consensus_keys}"
        f"（一致率 {sr.consistency:.0%}）。可能是答案欄辨識錯誤，也可能是題本印錯，請確認。",
        "error",
    )


# ─────────────────────────────────────────────────────────────────
# 階段六：知識點標註
# ─────────────────────────────────────────────────────────────────


async def annotate(
    provider: BaseProvider,
    q: StructuredQuestion,
    subject_name: str,
    candidates: list[dict],
) -> AnnotateResult | None:
    """
    先檢索後選擇。候選由呼叫端以向量相似度取回前 20 個，
    模型只能從中挑選，不能自由生成——理由見 prompts.py。
    """
    if not candidates:
        return None
    try:
        result, _ = await _structured(
            provider,
            model_cls=AnnotateResult,
            system=ANNOTATE_SYSTEM,
            user=annotate_user(q.content, subject_name, candidates),
            tier="LIGHT",  # 這是分類任務，快且便宜比聰明重要
            max_tokens=2048,
        )
        valid = {c["id"] for c in candidates}
        # 即使提示詞說了只能從候選選，仍要在程式層驗一次。
        # 提示詞是請求，程式檢查才是保證。
        bad = [p.kp_id for p in result.picks if p.kp_id not in valid]
        if bad:
            raise StageError("annotate", f"挑出了不在候選中的知識點：{bad}")
        return result
    except (StageError, ProviderError) as e:
        log.warning("知識點標註失敗：%s", e)
        return None


# ─────────────────────────────────────────────────────────────────
# 階段七：去重
# ─────────────────────────────────────────────────────────────────

_NORM = re.compile(r"[\s　]+")
#: 全形與半形標點都要移除。只列全形是不夠的——同一份題本裡中文用
#: 「？」而數學式後面用「?」的情況非常普遍，漏掉半形會讓明明重複的
#: 題目算出不同雜湊，去重就靜默失效了。
_PUNCT = re.compile(r"[，。、；：！？「」『』（）〔〕【】·…—,.;:!?\"'()\[\]{}]")
#: 全形英數轉半形。題本經 OCR 後全半形常常混用，同一個 f(x) 可能
#: 被讀成 ｆ（ｘ）。
_WIDTH = str.maketrans(
    "０１２３４５６７８９"
    "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ"
    "ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ"
    "＋－＝＜＞／＊",
    "0123456789"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "+-=<>/*",
)


def content_hash(stem: str, options: list[str]) -> str:
    """
    第一層去重：內容雜湊。正規化後完全相同即為重複。

    正規化必須夠強，否則「同一題但排版不同」會被當成兩題——
    而那正是題庫最容易累積冗餘的來源（同一題出現在三本講義裡）。
    """
    text = stem + "|" + "|".join(options)
    # 題號可能是「1.」「1、」「１．」「(1)」等寫法
    text = re.sub(r"^[\s　]*[（(]?[0-9０-９]+[）)]?[.、．,]?[\s　]*", "", text)
    text = text.translate(_WIDTH)
    text = _PUNCT.sub("", text)
    text = _NORM.sub("", text)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


DUPLICATE_THRESHOLD = 0.92


def dedupe_reason(similarity: float, existing_ref: str) -> Any:
    return _reason(
        "possible_duplicate",
        f"與既有題目「{existing_ref}」相似度 {similarity:.2f}，可能重複。"
        f"合併時會保留兩邊的來源記錄——「這題在三本講義都出現」本身就是重要性的訊號。",
        "warn",
    )


# ─────────────────────────────────────────────────────────────────
# 評分原則抽取與驗證（文件 16）
# ─────────────────────────────────────────────────────────────────


async def extract_rubric(
    provider: BaseProvider, text: str, expected_total: float | None = None
) -> tuple[RubricOut, list[str]]:
    """
    抽取評分原則，並回報通過了哪些機械檢查。

    RubricOut 的 model_validator 已經做了不變量檢查（區間連續、
    上限等於配分、必有 0 分等第）。這裡再做跨文件交叉驗證。
    """
    result, _ = await _structured(
        provider,
        model_cls=RubricOut,
        system=RUBRIC_SYSTEM,
        user=rubric_user(text, expected_total),
        tier="HIGH",
        max_tokens=8192,
    )

    passed = ["schema_invariants"]  # 能建構成功就代表不變量通過了
    if expected_total is not None:
        if abs(result.total_score - expected_total) > 0.01:
            raise StageError(
                "rubric",
                f"評分原則所載配分 {result.total_score} 與試題卷所載 {expected_total} 不符。"
                f"兩份獨立文件對不起來，必有一份抽錯。",
                retryable=False,
            )
        passed.append("cross_document")
    return result, passed


def compare_extractions(a: RubricOut, b: RubricOut) -> list[str]:
    """
    兩次獨立抽取的比對（文件 16 §4.4）。

    刻意**不**把第一次結果給模型看然後問「對嗎」——那會產生錨定效應，
    模型傾向同意。正確做法是獨立重抽，然後用程式比對，
    只有不一致的地方才需要人看。
    """
    diffs: list[str] = []
    if a.mode != b.mode:
        diffs.append(f"模式不一致：{a.mode} / {b.mode}")
    if abs(a.total_score - b.total_score) > 0.01:
        diffs.append(f"總分不一致：{a.total_score} / {b.total_score}")
    if len(a.bands) != len(b.bands):
        diffs.append(f"等第數不一致：{len(a.bands)} / {len(b.bands)}")
    else:
        for x, y in zip(
            sorted(a.bands, key=lambda z: -z.score_max),
            sorted(b.bands, key=lambda z: -z.score_max),
        ):
            if x.grade != y.grade or abs(x.score_max - y.score_max) > 0.01:
                diffs.append(f"等第不一致：{x.grade}({x.score_max}) / {y.grade}({y.score_max})")
    return diffs
