"""
升學建議的 HTTP 介面。

# 這一支只做一件事：組提示詞、呼叫模型、把文字原樣回去

**它不判斷輸出有沒有製造假的精確度。** 那道閘門在 Node 端
（`apps/web/lib/adviceGuard.mjs`），而且刻意只有一份實作。

理由與智慧老師那一支相同（見 routes_tutor.py）：規則要跟著資料種類演進
（繁星第一輪門檻、第二輪缺額、個申篩選級分各有各的「數字長什麼樣子」），
而兩份實作只要有一份先改，症狀就是「某些形式的機率擋得住、某些擋不住」
——那種缺口不會有人回報，因為畫面上看起來只是 AI 那一天講得比較有信心。

而且這一層有一個 Python 端做不到的判斷：**建議裡的每一個數字都必須對得
回一筆 `AdmissionReference`**。那份資料在 Postgres 裡，只有 Node 端拿得到。
把閘門放在這裡就得把整份參考資料再傳一次，然後兩邊各自維護一份比對邏輯。

# 為什麼不重用 /v1/tutor/turn

因為提示詞不一樣，而且**版本號要分開**。共用一個端點的話，改升學建議的
提示詞會讓智慧老師的 `promptVersion` 也跳號，於是事後追溯「這段對話當時
的規則是什麼」就對不上了。兩組提示詞的風險模型也完全不同（洩漏答案 vs
製造假精確度），共用一個系統提示只會讓兩邊都變鈍。
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
from pipeline.advice_prompts import (
    ADVICE_PROMPT_VERSION,
    advice_system,
    advice_user,
)

log = logging.getLogger("yunzhi.ai.advice")


# ─────────────────────────────────────────────────────────────────
# 請求
# ─────────────────────────────────────────────────────────────────


class AdviceReference(BaseModel):
    """
    學生查到的一筆資料。

    **`source_label`、`source_ref`、`looked_up_at` 沒有預設值可以省略的
    意思**——它們是 schema 的 NOT NULL 欄位，而提示詞要求模型把來源與
    日期一起講出來。這裡收成必填以外的形式（空字串）只是為了不讓一筆
    舊資料把整個請求打成 422，但空字串會直接出現在建議裡，很難看，
    所以呼叫端不會送空的。
    """

    kind: str = ""
    kind_label: str = ""
    institution_name: str = ""
    program_name: str | None = None
    star_group: int | None = None
    year: int | None = None
    value_text: str = ""
    source_label: str = ""
    source_ref: str = ""
    looked_up_at: str = ""
    trust_label: str = ""
    stale: bool = False


class AdviceWish(BaseModel):
    channel: str = ""
    channel_label: str = ""
    rank: int | None = None
    institution_name: str = ""
    program_name: str | None = None
    star_group: int | None = None
    interest_tag: str | None = None


class AdviceStarPosition(BaseModel):
    """
    校內序位。**沒有任何其他學生的欄位，也沒有參與人數。**

    這個形狀是 `lib/star.mjs` 的 `studentView()` 裁切之後的樣子，而它
    刻意在這裡也寫成一個窄的模型：多一個 `cohort` 欄位就會被寫進提示詞，
    然後出現在建議裡——「你這個位置有 5 個人在搶」是全校資料，不是他的。
    """

    institution_name: str = ""
    star_group: int | None = None
    order: int | None = None
    is_first: bool = False
    nominated: bool = False
    first_round: bool = False


class AdviceGap(BaseModel):
    text: str = ""
    url: str | None = None


class AdviceRequest(BaseModel):
    year: int | None = None
    references: list[AdviceReference] = Field(default_factory=list)
    wishes: list[AdviceWish] = Field(default_factory=list)
    star_positions: list[AdviceStarPosition] = Field(default_factory=list)
    #: 管道資格的判定結果，已經是人話。**不要讓模型重新推導制度規則**
    #: ——那三條規則的方向不對稱，模型會推錯，而 lib/admission.mjs 有
    #: 384 種組合的測試。
    blockers: list[str] = Field(default_factory=list)
    #: 資料缺口。由 Node 端算出來（adviceBasis 的 gaps），當成事實餵進來。
    gaps: list[AdviceGap] = Field(default_factory=list)
    #: 官方（教務處匯入）與學生自填的在校百分比。分兩欄，理由見提示詞。
    official_percentile: float | None = None
    self_percentile: float | None = None
    question: str = ""
    #: 重新生成的第幾次。> 0 時提高溫度並附上一句「上一次違規了」，
    #: 否則同樣的輸入會產生同樣的輸出，重試三次是白花三次錢。
    retry: int = Field(default=0, ge=0, le=5)
    tier: str = "MID"


class AdviceResponse(BaseModel):
    """
    回應。

    **刻意沒有任何欄位攜帶結論或分數。** 呼叫端只拿得到 `text`，而
    `text` 要通過 Node 端的閘門才會落到學生畫面上。若這裡多回一個
    「建議等級」或「風險分數」欄位（例如為了讓前端上色），那條路會繞過
    閘門，而繞過閘門的路只要存在就會有人走。
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


def build_advice_router(get_provider) -> APIRouter:
    """與 routes_tutor 同一種工廠寫法：provider 是行程層級的單例。"""
    r = APIRouter(prefix="/v1/admission", tags=["admission"])

    @r.post("/advice", response_model=AdviceResponse)
    async def _advice(req: AdviceRequest) -> AdviceResponse:  # noqa: ANN202
        provider = _provider_or_503(get_provider)

        ctx: dict[str, Any] = {
            "year": req.year,
            "references": [x.model_dump() for x in req.references],
            "wishes": [x.model_dump() for x in req.wishes],
            "star_positions": [x.model_dump() for x in req.star_positions],
            "blockers": list(req.blockers),
            "gaps": [x.model_dump() for x in req.gaps],
            "official_percentile": req.official_percentile,
            "self_percentile": req.self_percentile,
            "question": req.question,
            "retry": req.retry,
        }

        t0 = time.perf_counter()
        try:
            c = await provider.complete(
                tier=req.tier if req.tier in ("HIGH", "MID", "LIGHT") else "MID",
                system=advice_system(),
                user=advice_user(ctx),
                # 300 字的目標值再加上來源與日期的餘裕。給得太寬的話，
                # 模型會把它當成可以用完的額度然後開始寫一份分析報告，
                # 而那份報告裡一定會有一個編出來的數字。
                max_tokens=900,
                # 第一次要穩定（同樣的資料給同樣的建議），重試要不一樣
                # ——溫度不動的話，重試三次會拿到三段幾乎相同的違規輸出。
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
            "advice refs=%s gaps=%s retry=%s tokens=%s/%s",
            len(req.references),
            len(req.gaps),
            req.retry,
            c.usage.input_tokens,
            c.usage.output_tokens,
        )

        return AdviceResponse(
            text=c.text.strip(),
            model=c.model,
            provider=c.provider,
            input_tokens=c.usage.input_tokens,
            output_tokens=c.usage.output_tokens,
            tokens_estimated=c.usage.estimated,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            prompt_version=ADVICE_PROMPT_VERSION,
        )

    return r
