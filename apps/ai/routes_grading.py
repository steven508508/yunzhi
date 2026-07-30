"""
非選題閱卷的 HTTP 介面。

# 這一支只做兩件事：把同一份答案評 N 次，把結果原樣回去

**它不判斷評分合不合規。** 那道閘門在 Node 端
（`apps/web/lib/gradingProposal.mjs`），而且刻意只有一份實作。

理由與智慧老師、升學建議那兩支相同（見 routes_tutor.py、routes_advice.py），
但這裡有兩個 Python 端**做不到**的判斷：

  · **理由裡有沒有引用學生答案裡一段題幹與規準都沒有的原文。** 這件事
    要拿三段文字（答案、題幹、規準）互相比對，而規準在 Postgres 裡，
    要一起判斷還得知道 `Rubric.internalOnly`。
  · **老師最後給了幾分。** 誤差、採用率、被改最多的面向都只算得出來
    在有資料庫的那一側。

把閘門放這裡就得把整份規準與答案再傳一次，然後兩邊各自維護一份比對
邏輯——而兩份實作只要有一份先改，症狀是「某些形式的空話擋得住、
某些擋不住」，那種缺口不會有人回報。

# 為什麼是評 N 次而不是一次

因為**單次評分的分數看不出它有多不確定**。同一篇作文評三次拿到
12、12、13 與拿到 9、12、15 是兩件完全不同的事，而只評一次的話兩者
在畫面上都是「建議 12 分」。第二種的老師必須自己重看一遍。

N 次**用同一個溫度**，而且是正式參數的那個溫度。刻意調高溫度再說
「離散度很大」，量到的是自己調的參數而不是模型的判斷穩定性。

離散度怎麼折成信心、挑哪一份當代表，在 Node 端
（`aggregateSamples`）——那一段是純函式，有單元測試。

# 為什麼不重用 /v1/tutor/turn 或 /v1/admission/advice

因為提示詞不一樣，而且**版本號要分開**。共用端點的話，改閱卷的提示詞
會讓智慧老師的 `promptVersion` 也跳號，於是事後追溯「這一筆建議當時的
規則是什麼」就對不上了。三組提示詞的風險模型完全不同（洩漏答案／
假精確度／評文采而不是評給分要點），共用一個系統提示只會讓三邊都變鈍。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from providers import (
    BaseProvider,
    ContentRefused,
    FatalError,
    ProviderError,
    RetryableError,
)
from pipeline.grading_prompts import (
    GRADING_PROMPT_VERSION,
    grading_system,
    grading_user,
)

log = logging.getLogger("yunzhi.ai.grading")


# ─────────────────────────────────────────────────────────────────
# 請求
# ─────────────────────────────────────────────────────────────────


class GradingQuestion(BaseModel):
    type: str = "ESSAY"
    stem: str = ""
    #: 這一題在**這份卷子上**的配分（版面快照），不是題庫裡的原始配分。
    #: 兩者可能不同，而學生當時看到的是前者。
    score: float = 0
    subject: str | None = None


class GradingDimension(BaseModel):
    id: str = ""
    name: str = ""
    max_score: float = 0
    descriptor: str | None = None


class GradingBand(BaseModel):
    grade: str = ""
    score_min: float = 0
    score_max: float = 0
    descriptor: str = ""
    dimension_name: str | None = None


class GradingRubric(BaseModel):
    name: str = ""
    total_score: float = 0
    mode: str = "BAND"
    dimensions: list[GradingDimension] = Field(default_factory=list)
    bands: list[GradingBand] = Field(default_factory=list)


class GradingRequest(BaseModel):
    question: GradingQuestion
    #: 沒有規準時是 None。**這一層不補一個預設規準**——那會讓
    #: 「有規準」與「沒有規準」在建議上看起來一樣可信。
    rubric: GradingRubric | None = None
    answer: str = ""
    #: 評幾次。上限 5：再多的邊際資訊很小，而成本是線性的。
    samples: int = Field(default=3, ge=1, le=5)
    #: 重新生成的第幾次。> 0 時提高溫度並附上上一次的違規類別。
    retry: int = Field(default=0, ge=0, le=5)
    #: 上一次被閘門擋下的理由。原樣寫進提示詞——不說出來的話，
    #: 模型會用同樣的方式再寫一次。
    violations: str = ""
    tier: str = "MID"


class GradingSample(BaseModel):
    score: float
    dimensions: list[dict[str, Any]] = Field(default_factory=list)
    rationale: str = ""
    confidence: float | None = None


class GradingResponse(BaseModel):
    """
    回應。

    **刻意沒有任何欄位攜帶「最終分數」或「已核准」的意思。** 呼叫端
    拿到的是 N 份平行的建議，挑哪一份、要不要用，全部在 Node 端決定。
    這裡若多回一個 `final_score` 或 `approved` 欄位（例如為了讓前端
    少算一次），那條路會繞過閘門與老師——而繞過去的路只要存在就會
    有人走。
    """

    samples: list[GradingSample]
    #: 有幾次的輸出連 JSON 都解不出來。**要回報而不是吞掉**：
    #: 它突然變多多半代表模型或閘道換了版本。
    parse_failures: int = 0
    model: str
    provider: str
    input_tokens: int
    output_tokens: int
    tokens_estimated: bool
    latency_ms: int
    prompt_version: str


# ─────────────────────────────────────────────────────────────────
# 解析
# ─────────────────────────────────────────────────────────────────

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def _parse(text: str) -> dict[str, Any]:
    """
    模型偶爾把 JSON 包在 markdown 圍籬裡，或在前後加一句說明。
    與其在提示詞裡一再強調「只輸出 JSON」，不如在這裡容錯——
    前者不可靠，後者是確定的。（與 pipeline/stages.py 的 `_parse_json`
    同一個做法；沒有共用是因為那一支綁在匯入管線的 StageError 上。）
    """
    t = (text or "").strip()
    if m := _FENCE.search(t):
        t = m.group(1).strip()
    if not t.startswith("{"):
        i = t.find("{")
        if i < 0:
            raise ValueError("回應裡找不到 JSON")
        t = t[i:]
    j = t.rfind("}")
    if j > 0:
        t = t[: j + 1]
    out = json.loads(t)
    if not isinstance(out, dict):
        raise ValueError("JSON 不是物件")
    return out


def _sample_of(raw: dict[str, Any]) -> GradingSample:
    """
    把一份輸出折成固定形狀。

    **這裡只做結構上的整理，不做任何合規判斷。** 分數超過配分、面向
    加不起來、理由是空話，全部原樣送回 Node 端——由那一層判斷並記錄
    被擋下的原因。在這裡先丟掉的那幾份，`AnswerGradeProposal` 上就
    看不到「AI 差一點給了什麼」，而那是唯一能看出它準不準的資料。
    """
    dims: list[dict[str, Any]] = []
    for d in raw.get("dimensions") or []:
        if not isinstance(d, dict):
            continue
        # 欄位一律 snake_case，與回應信封的其餘欄位（`input_tokens`、
        # `prompt_version`）一致。Node 端的 `readSample` 兩種寫法都認得，
        # 所以這裡選一致的那一種。
        dims.append(
            {
                "dimension_id": str(d.get("dimension_id") or d.get("dimensionId") or ""),
                "name": str(d.get("name") or ""),
                "score": d.get("score"),
                "max_score": d.get("max_score", d.get("max")),
                "reason": str(d.get("reason") or ""),
            }
        )
    conf = raw.get("confidence")
    return GradingSample(
        score=float(raw.get("score")),
        dimensions=dims,
        rationale=str(raw.get("rationale") or ""),
        confidence=float(conf) if isinstance(conf, (int, float)) else None,
    )


# ─────────────────────────────────────────────────────────────────

#: 正式參數。**N 次抽樣一律用這個溫度**，理由見檔頭。
#: 0.3 而不是 0：閱卷要的是一個穩定的判斷，但 0 在多數閘道上也不是
#: 真的確定性，而它會讓「量離散度」這件事量到一個假的 0。
GRADING_TEMPERATURE = 0.3

#: 一份建議的輸出上限。300 字的理由加上逐面向的說明，1200 token 有餘。
#: 給得太寬的話，模型會把它當成可以用完的額度然後開始寫一份評析報告，
#: 而那份報告裡一定有一段是空話。
GRADING_MAX_TOKENS = 1200


def _provider_or_503(get_provider) -> BaseProvider:
    p = get_provider()
    if p is None:
        raise HTTPException(503, detail="AI provider 未就緒，請檢查設定後重啟服務")
    return p


def build_grading_router(get_provider) -> APIRouter:
    """與 routes_tutor / routes_advice 同一種工廠寫法：provider 是行程層級的單例。"""
    r = APIRouter(prefix="/v1/grading", tags=["grading"])

    @r.post("/score", response_model=GradingResponse)
    async def _score(req: GradingRequest) -> GradingResponse:  # noqa: ANN202
        provider = _provider_or_503(get_provider)

        ctx: dict[str, Any] = {
            "question": req.question.model_dump(),
            "rubric": req.rubric.model_dump() if req.rubric else None,
            "answer": req.answer,
            "retry": req.retry,
            "violations": req.violations,
        }
        system = grading_system()
        user = grading_user(ctx)

        # 重試時把溫度往上帶。溫度不動的話，重試三次會拿到三份幾乎
        # 相同的違規輸出——花三倍的錢買同一個錯誤。
        temperature = min(0.9, GRADING_TEMPERATURE + 0.2 * req.retry)

        t0 = time.perf_counter()
        try:
            # 併發送出。provider 自己有訊號量（`BaseProvider._sem`）控制
            # 對上游的併發，所以這裡不必再限一次——限兩次的結果是
            # 兩個上限互相打，而且沒有人看得出實際併發是多少。
            completions = await asyncio.gather(
                *(
                    provider.complete(
                        tier=req.tier if req.tier in ("HIGH", "MID", "LIGHT") else "MID",
                        system=system,
                        user=user,
                        max_tokens=GRADING_MAX_TOKENS,
                        temperature=temperature,
                    )
                    for _ in range(req.samples)
                )
            )
        except ContentRefused as e:
            raise HTTPException(422, detail=str(e)) from e
        except FatalError as e:
            raise HTTPException(502, detail=str(e)) from e
        except RetryableError as e:
            raise HTTPException(503, detail=str(e)) from e
        except ProviderError as e:  # 防守：新的錯誤子類別不要變成 500
            raise HTTPException(502, detail=str(e)) from e

        samples: list[GradingSample] = []
        failures = 0
        tokens_in = 0
        tokens_out = 0
        estimated = False
        for c in completions:
            tokens_in += c.usage.input_tokens
            tokens_out += c.usage.output_tokens
            estimated = estimated or c.usage.estimated
            try:
                samples.append(_sample_of(_parse(c.text)))
            except Exception as e:  # JSON 壞掉、score 不是數字
                failures += 1
                log.warning("閱卷輸出解析失敗：%s｜%s", e, (c.text or "")[:200])

        if not samples:
            # 一份都解不出來。**回 502 而不是回空陣列**：空陣列在呼叫端
            # 長得像「AI 覺得這一份沒問題」，而它其實是這條路整段壞了。
            raise HTTPException(
                502,
                detail=f"連續 {req.samples} 次都拿不到可以解析的評分輸出，這一題請人工閱卷",
            )

        log.info(
            "grading samples=%s/%s rubric=%s retry=%s tokens=%s/%s",
            len(samples),
            req.samples,
            "yes" if req.rubric else "no",
            req.retry,
            tokens_in,
            tokens_out,
        )

        return GradingResponse(
            samples=samples,
            parse_failures=failures,
            model=completions[0].model,
            provider=completions[0].provider,
            input_tokens=tokens_in,
            output_tokens=tokens_out,
            tokens_estimated=estimated,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            prompt_version=GRADING_PROMPT_VERSION,
        )

    return r
