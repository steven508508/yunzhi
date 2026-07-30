"""
學習歷程輔助的 HTTP 介面。

# 這一支只做一件事：依 feature 選提示詞、呼叫模型、把文字原樣回去

**它不判斷輸出有沒有代寫。** 那道閘門在 Node 端
（`apps/web/lib/portfolioGuard.mjs`），而且刻意只有一份實作。

理由與前三支相同（見 routes_tutor.py、routes_advice.py）：規則要跟著
代寫的花樣演進（第一人稱長段、「你可以這樣寫」的框、用「本人」寫的
第三人稱、拿掉主詞的段落各有各的樣子），而兩份實作只要有一份先改，
症狀就是「某些形式的代寫擋得住、某些擋不住」——那種缺口不會有人回報，
因為畫面上看起來只是 AI 那一天寫得比較好用。

而且這一層有一個 Python 端做不到的判斷：**引用學生自己寫的東西不算
代寫**，而要判斷「這段話是不是他自己寫的」需要拿到他的原文與素材，
那些在 Postgres 裡，只有 Node 端拿得到。把閘門放在這裡就得把整份
自述再傳一次，然後兩邊各自維護一份比對邏輯。

# 揭露聲明與回饋共用一個端點，但**系統提示是兩套**

共用端點是因為它們的呼叫形狀一樣（一段脈絡進去、一段文字出來），
而且 Node 端的重試迴圈只有一份。

系統提示分兩套是因為它們的規則**互斥**：回饋那一套禁止任何第一人稱
敘述，而聲明那一套要求用第一人稱寫。合併之後模型會在寫回饋的時候
套用聲明那一套，結果是每一次回饋都被閘門擋掉、重試三次、退回罐頭
——一個功能把自己擋掉，而症狀只是它比較慢。
"""

from __future__ import annotations

import logging
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
from pipeline.portfolio_prompts import (
    COACH_FEATURES,
    DISCLOSURE_FEATURE,
    PORTFOLIO_PROMPT_VERSION,
    portfolio_system,
    portfolio_user,
)

log = logging.getLogger("yunzhi.ai.portfolio")


# ─────────────────────────────────────────────────────────────────
# 請求
# ─────────────────────────────────────────────────────────────────


class PortfolioItemCtx(BaseModel):
    """
    一件素材。

    **沒有 `storage_key` 也沒有檔案內容。** 模型要判斷的是「這幾件呈現
    的是不是同一種能力」，那看標題、學期與能力面向就夠了。把檔案本身
    傳進去只會多一條學生的作品外流的路徑，而它對這個判斷沒有幫助。
    """

    code: str = ""
    title: str = ""
    semester: str | None = None
    ability_tags: list[str] = Field(default_factory=list)
    selected_for: list[str] = Field(default_factory=list)


class PortfolioEssayCtx(BaseModel):
    kind: str = ""
    body: str = ""


class RuleCheckCtx(BaseModel):
    code: str = ""
    ok: bool = True
    detail: str = ""


class GradeMoveCtx(BaseModel):
    """成績的**變化**，不是每一次的成績。理由見 portfolio_prompts 的提示詞。"""

    subject: str = ""
    field_from: int | None = Field(default=None, alias="from")
    to: int | None = None
    span: str = ""

    model_config = {"populate_by_name": True}


class AbilityCtx(BaseModel):
    name: str = ""
    mastery: float | None = None


class DisclosureNoteCtx(BaseModel):
    feature: str = ""
    nature: str = ""


class PortfolioRequest(BaseModel):
    #: 哪一個功能。**決定用哪一套系統提示**，也決定 Node 端用哪一組
    #: 後處理規則。認不得的值在下面會被打成 422 而不是預設成回饋——
    #: 預設的話，一個打錯字的 feature 會拿到回饋的提示詞去寫聲明。
    feature: str = "WRITING_FEEDBACK"

    essay: PortfolioEssayCtx | None = None
    items: list[PortfolioItemCtx] = Field(default_factory=list)
    rule_checks: list[RuleCheckCtx] = Field(default_factory=list)
    grade_trace: list[GradeMoveCtx] = Field(default_factory=list)
    ability_trace: list[AbilityCtx] = Field(default_factory=list)
    program_ref: str | None = None
    question: str = ""

    #: 揭露聲明用的：每一類互動的次數與性質摘要。
    counts: dict[str, int] = Field(default_factory=dict)
    total: int = 0
    first_at: str | None = None
    last_at: str | None = None
    ai_level: int | None = None
    notes: list[DisclosureNoteCtx] = Field(default_factory=list)

    #: 重新生成的第幾次。> 0 時提高溫度並附上一句「上一次違規了」，
    #: 否則同樣的輸入會產生同樣的輸出，重試三次是白花三次錢。
    retry: int = Field(default=0, ge=0, le=5)
    tier: str = "MID"


class PortfolioResponse(BaseModel):
    """
    回應。

    **刻意沒有任何欄位攜帶「可以直接使用的文字」。** 呼叫端只拿得到
    `text`，而 `text` 要通過 Node 端的閘門才會落到學生畫面上。若這裡
    多回一個 `suggested_paragraph` 或 `revised_text` 欄位（例如為了讓
    前端做「並排比對」），那條路會繞過閘門，而繞過閘門的路只要存在
    就會有人走——而這一次走過去的東西是一段代寫。
    """

    text: str
    model: str
    provider: str
    input_tokens: int
    output_tokens: int
    tokens_estimated: bool
    latency_ms: int
    prompt_version: str


# ─────────────────────────────────────────────────────────────────


def _provider_or_503(get_provider) -> BaseProvider:
    p = get_provider()
    if p is None:
        raise HTTPException(503, detail="AI provider 未就緒，請檢查設定後重啟服務")
    return p


ALLOWED_FEATURES = (*COACH_FEATURES, DISCLOSURE_FEATURE)


def build_portfolio_router(get_provider) -> APIRouter:
    """與 routes_advice 同一種工廠寫法：provider 是行程層級的單例。"""
    r = APIRouter(prefix="/v1/portfolio", tags=["portfolio"])

    @r.post("/coach", response_model=PortfolioResponse)
    async def _coach(req: PortfolioRequest) -> PortfolioResponse:  # noqa: ANN202
        if req.feature not in ALLOWED_FEATURES:
            # 打成 422 而不是預設成回饋。預設的話，一個打錯字的 feature
            # 會拿到回饋的提示詞去寫揭露聲明——而那份聲明會被 Node 端
            # 的另一組規則擋下三次，看起來像模型壞了。
            raise HTTPException(422, detail=f"不認得的 feature：{req.feature}")

        provider = _provider_or_503(get_provider)

        ctx: dict[str, Any] = {
            "feature": req.feature,
            "essay": req.essay.model_dump() if req.essay else None,
            "items": [x.model_dump() for x in req.items],
            "rule_checks": [x.model_dump() for x in req.rule_checks],
            "grade_trace": [x.model_dump(by_alias=True) for x in req.grade_trace],
            "ability_trace": [x.model_dump() for x in req.ability_trace],
            "program_ref": req.program_ref,
            "question": req.question,
            "counts": dict(req.counts),
            "total": req.total,
            "first_at": req.first_at,
            "last_at": req.last_at,
            "ai_level": req.ai_level,
            "notes": [x.model_dump() for x in req.notes],
            "retry": req.retry,
        }

        t0 = time.perf_counter()
        try:
            c = await provider.complete(
                tier=req.tier if req.tier in ("HIGH", "MID", "LIGHT") else "MID",
                system=portfolio_system(req.feature),
                user=portfolio_user(ctx),
                # 揭露聲明給得比回饋少：它有 150 字的目標，而給得太寬的話
                # 模型會開始解釋教育部的規定，然後那份聲明長得像一篇短文。
                max_tokens=400 if req.feature == DISCLOSURE_FEATURE else 800,
                # 第一次要穩定，重試要不一樣——溫度不動的話，重試三次會
                # 拿到三段幾乎相同的違規輸出。
                temperature=0.2 + 0.25 * req.retry,
            )
        except ContentRefused as e:
            raise HTTPException(422, detail=str(e)) from e
        except FatalError as e:
            raise HTTPException(502, detail=str(e)) from e
        except RetryableError as e:
            raise HTTPException(503, detail=str(e)) from e
        except ProviderError as e:  # 防守：新的錯誤子類別不要變成 500
            raise HTTPException(502, detail=str(e)) from e

        log.info(
            "portfolio feature=%s items=%s retry=%s tokens=%s/%s",
            req.feature,
            len(req.items),
            req.retry,
            c.usage.input_tokens,
            c.usage.output_tokens,
        )

        return PortfolioResponse(
            text=c.text.strip(),
            model=c.model,
            provider=c.provider,
            input_tokens=c.usage.input_tokens,
            output_tokens=c.usage.output_tokens,
            tokens_estimated=c.usage.estimated,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            prompt_version=PORTFOLIO_PROMPT_VERSION,
        )

    return r
