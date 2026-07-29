"""
智慧老師的 HTTP 介面。

# 這一支只做一件事：組提示詞、呼叫模型、把文字原樣回去

**它不判斷輸出有沒有洩漏答案。** 那道閘門在 Node 端
（`apps/web/lib/tutorGuard.mjs`），而且刻意只有一份實作。

理由是分岐。洩漏偵測要能跟著題型演進（多選、選填、非選各有不同的
「答案長什麼樣子」），而兩份實作只要有一份先改，症狀就是
「某些題型的洩漏擋得住、某些擋不住」——那種缺口不會有人回報，
因為畫面上看起來只是 AI 講得比較清楚。

代價是重新生成要多一次 HTTP 往返。那是內網的一次往返，
換一份唯一的、被 40 幾個測試釘住的規則，很划算。

# 為什麼不用 /v1/complete 就好

因為提示詞的組裝要有版本號，而版本號要跟著回應一起回去寫進
`TutorMessage.promptVersion`。讓 Node 端自己組提示詞的話，
提示詞就散在兩個語言、兩個 repo 位置裡，而改提示詞的人只會改到
一邊。這一支是 `/v1/complete` 外面的一層薄殼：provider 抽象、
重試、參數協商全部沿用底下那一套，沒有第二個 HTTP 客戶端。
"""

from __future__ import annotations

import logging
import time
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from providers import (
    BaseProvider,
    ContentRefused,
    FatalError,
    ProviderError,
    RetryableError,
)
from pipeline.tutor_prompts import (
    OPENING_CHOICES,
    OPENING_QUESTION,
    TUTOR_PROMPT_VERSION,
    tutor_system,
    tutor_user,
)

log = logging.getLogger("yunzhi.ai.tutor")

TutorMode = Literal["AUTO", "SMALL_TIP", "STEP_BY_STEP", "BASIC_TOPIC"]


# ─────────────────────────────────────────────────────────────────
# 請求
# ─────────────────────────────────────────────────────────────────


class TutorOption(BaseModel):
    """
    一個選項。

    **沒有 `correct` 欄位。** 正確答案只走 `correct_answer_text` 一條路，
    而那一欄在提示詞裡是被框起來、放在最後、附帶「不可揭露」聲明的。
    若選項也能帶正確標記，組提示詞的地方就有兩處要記得處理它，
    而漏掉的那一處會讓「(3) …（正確）」直接混進選項清單裡。
    """

    label: str = ""
    content: str = ""
    picked: bool = False


class TutorKp(BaseModel):
    name: str = ""
    description: str | None = None
    #: 0–1。沒有能力快照時為 None，提示詞就不提掌握度——
    #: 給一個編出來的數字比不給更糟，模型會照著它調整深淺。
    mastery: float | None = None


class TutorHistoryItem(BaseModel):
    role: Literal["STUDENT", "TUTOR"]
    content: str


class TutorTurnRequest(BaseModel):
    subject: str = ""
    question_type: str = ""
    stem: str = ""
    options: list[TutorOption] = Field(default_factory=list)
    my_answer_text: str = ""
    verdict: str = ""
    knowledge_points: list[TutorKp] = Field(default_factory=list)
    prerequisites: list[TutorKp] = Field(default_factory=list)
    #: 老師自編解析的方法結構（不是原文）。見文件 03 §5.3。
    method_basis: str | None = None
    #: 學生自陳的卡點。引導的起點。
    stuck_at: str | None = None
    #: 正確答案。模型看得到，學生看不到——這是整個請求裡唯一敏感的欄位，
    #: 而它**不會出現在回應裡**（見 TutorTurnResponse 的註解）。
    correct_answer_text: str = ""
    history: list[TutorHistoryItem] = Field(default_factory=list)
    mode: TutorMode = "AUTO"
    turn: int = Field(default=1, ge=1, le=100)
    #: 重新生成的第幾次。> 0 時提高溫度並附上一句「上一次違規了」，
    #: 否則同樣的輸入會產生同樣的輸出，重試三次是白花三次錢。
    retry: int = Field(default=0, ge=0, le=5)
    tier: Literal["HIGH", "MID", "LIGHT"] = "MID"


class TutorTurnResponse(BaseModel):
    """
    回應。

    **刻意沒有任何欄位攜帶正確答案。** 呼叫端只拿得到 `text`，
    而 `text` 要通過 Node 端的閘門才會落到學生畫面上。若這裡多回一個
    「本題答案」欄位（例如為了讓前端顯示），那條路會繞過閘門，
    而繞過閘門的路只要存在就會有人走。
    """

    text: str
    model: str
    provider: str
    input_tokens: int
    output_tokens: int
    tokens_estimated: bool
    latency_ms: int
    prompt_version: str
    #: 實際套用的教學模式。AUTO 會原樣回 AUTO——模型心裡選了哪一種
    #: 我們無從得知，而編一個回去會讓老師端的統計說謊。
    mode: str


class TutorOpeningResponse(BaseModel):
    """開場白。不呼叫模型，理由見 tutor_prompts.py 的最後一段。"""

    question: str
    choices: list[str]
    prompt_version: str


# ─────────────────────────────────────────────────────────────────


def _provider_or_503(get_provider) -> BaseProvider:
    p = get_provider()
    if p is None:
        raise HTTPException(503, detail="AI provider 未就緒，請檢查設定後重啟服務")
    return p


_RETRY_NOTE = """
（系統提醒：你上一次的回應因為洩漏了答案或講得太完整而被擋下來，
沒有送給學生。這一次請只問一個問題，不要出現任何形式的最終答案，
不要一次講完所有步驟。）
""".strip()


def build_tutor_router(get_provider) -> APIRouter:
    """
    與 routes_import 同一種工廠寫法：provider 是行程層級的單例，
    用 Depends 的話啟動失敗時給的訊息對維運人員沒有幫助。
    """
    r = APIRouter(prefix="/v1/tutor", tags=["tutor"])

    @r.get("/opening", response_model=TutorOpeningResponse)
    async def _opening() -> TutorOpeningResponse:  # noqa: ANN202
        return TutorOpeningResponse(
            question=OPENING_QUESTION,
            choices=list(OPENING_CHOICES),
            prompt_version=TUTOR_PROMPT_VERSION,
        )

    @r.post("/turn", response_model=TutorTurnResponse)
    async def _turn(req: TutorTurnRequest) -> TutorTurnResponse:  # noqa: ANN202
        provider = _provider_or_503(get_provider)

        ctx: dict[str, Any] = {
            "subject": req.subject,
            "question_type": req.question_type,
            "stem": req.stem,
            "options": [o.model_dump() for o in req.options],
            "my_answer_text": req.my_answer_text,
            "verdict": req.verdict,
            "knowledge_points": [k.model_dump() for k in req.knowledge_points],
            "prerequisites": [k.model_dump() for k in req.prerequisites],
            "method_basis": req.method_basis,
            "stuck_at": req.stuck_at,
            "correct_answer_text": req.correct_answer_text,
            "history": [h.model_dump() for h in req.history],
            "turn": req.turn,
        }

        system = tutor_system(req.mode)
        user = tutor_user(ctx)
        if req.retry > 0:
            user = f"{user}\n\n{_RETRY_NOTE}"

        t0 = time.perf_counter()
        try:
            c = await provider.complete(
                tier=req.tier,
                system=system,
                user=user,
                # 150 字的目標值再加上算式與標點的餘裕。給得太寬的話，
                # 模型會把它當成可以用完的額度然後開始講解。
                max_tokens=700,
                # 第一次要穩定（同樣的卡點給同樣的引導），重試要不一樣
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
            "tutor turn=%s mode=%s retry=%s tokens=%s/%s",
            req.turn,
            req.mode,
            req.retry,
            c.usage.input_tokens,
            c.usage.output_tokens,
        )

        return TutorTurnResponse(
            text=c.text.strip(),
            model=c.model,
            provider=c.provider,
            input_tokens=c.usage.input_tokens,
            output_tokens=c.usage.output_tokens,
            tokens_estimated=c.usage.estimated,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            prompt_version=TUTOR_PROMPT_VERSION,
            mode=req.mode,
        )

    return r
