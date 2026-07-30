"""
雲端智學 — Python AI 服務

只做兩件事：
  1. 對主應用暴露統一的 AI 呼叫介面（分級路由、重試、用量回報）
  2. 提供健康與就緒探測，讓部署層知道它活著

題本解析、評分、解析生成等管線依規格書文件 03 分階段加入，
它們全部走這裡的 provider 抽象，不各自接 API。

啟動時會做一次 provider 自檢：設定錯了要在啟動時炸掉，
而不是等到老師上傳了一份 200 頁的題本才失敗。
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import storage
from providers import (
    BaseProvider,
    ContentRefused,
    FatalError,
    ProviderError,
    RetryableError,
    build_provider,
)
from routes_advice import build_advice_router
from routes_grading import build_grading_router
from routes_import import build_router
from routes_tutor import build_tutor_router

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "info").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("yunzhi.ai")

APP_VERSION = os.getenv("APP_VERSION", "dev")
STARTED_AT = time.time()

_provider: BaseProvider | None = None
_provider_error: str | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _provider, _provider_error
    try:
        _provider = build_provider()
        log.info("AI 服務啟動完成（版本 %s）", APP_VERSION)
    except ProviderError as e:
        # 不直接退出。退出會讓容器進入重啟迴圈，維運人員只看得到
        # 「一直在重啟」而看不到原因。改為啟動成功但 readyz 回 503，
        # 並在 /healthz 的回應中說明是什麼設定錯了。
        _provider_error = str(e)
        log.error("AI provider 初始化失敗：%s", e)
    yield
    if _provider is not None:
        await _provider.aclose()


def _get_provider() -> BaseProvider | None:
    """給匯入管線的端點用。單例，不是每次請求都建。"""
    return _provider


app = FastAPI(
    title="雲端智學 AI 服務",
    version=APP_VERSION,
    lifespan=lifespan,
    docs_url=None if os.getenv("NODE_ENV") == "production" else "/docs",
    redoc_url=None,
)


app.include_router(build_router(_get_provider))
# 智慧老師。與匯入同一個 provider 單例——引導式教學的每一輪都是一次
# 模型呼叫，走同一條路才會被同一份重試、參數協商與用量回報涵蓋。
app.include_router(build_tutor_router(_get_provider))
# 升學建議。同一個 provider 單例——它與智慧老師的差別在提示詞與版本號，
# 不在傳輸層（見 routes_advice.py 的檔頭）。
app.include_router(build_advice_router(_get_provider))
# 非選題閱卷。同上，而且它是三者中唯一會對同一份輸入呼叫多次的
# （評 N 次量離散度），所以走同一個 provider 單例特別重要——各自建
# client 的話，那 N 次會繞過 BaseProvider 的併發訊號量。
app.include_router(build_grading_router(_get_provider))


# ─────────────────────────────────────────────────────────────────
# 探測
# ─────────────────────────────────────────────────────────────────


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    """存活。不打上游，永遠回 200 除非行程死了。"""
    return {
        "alive": True,
        "version": APP_VERSION,
        "uptimeSec": int(time.time() - STARTED_AT),
        "providerConfigured": _provider is not None,
        "providerError": _provider_error,
    }


@app.get("/readyz")
async def readyz() -> JSONResponse:
    """
    就緒。provider 設定正確才算就緒。

    刻意**不**在這裡呼叫上游 —— 那會讓每 30 秒一次的探測變成
    每 30 秒一次的付費呼叫。上游是否真的通，用 /selftest 手動驗。
    """
    # 物件儲存要納入就緒條件：沒有它，匯入的第一階段就會失敗，
    # 而那個失敗要花好幾秒才浮現（老師已經把 80 MB 傳完了）。
    # head_bucket 是一次極輕的呼叫，值得每次探測都做。
    storage_ok, storage_error = storage.healthy()

    ready = _provider is not None and storage_ok
    return JSONResponse(
        {
            "ready": ready,
            "provider": _provider.name if _provider else None,
            "baseUrl": _provider.base_url if _provider else None,
            "storage": {"ok": storage_ok, "error": storage_error},
            "error": _provider_error,
        },
        status_code=200 if ready else 503,
    )


@app.post("/selftest")
async def selftest() -> dict[str, Any]:
    """
    實際打一次上游，確認 key、base URL、模型名稱三者都對。

    安裝腳本會在最後呼叫它，把「設定看起來對」升級為「設定真的對」。
    這是很划算的一步：設定錯誤在這裡發現的成本，遠低於在第一次
    匯入題本時發現。
    """
    if _provider is None:
        raise HTTPException(503, detail=f"provider 未就緒：{_provider_error}")

    results: dict[str, Any] = {}
    for tier in ("LIGHT", "MID", "HIGH"):
        try:
            c = await _provider.complete(
                tier=tier,  # type: ignore[arg-type]
                user="請只回覆兩個字：正常",
                max_tokens=16,
            )
            results[tier] = {
                "ok": True,
                "model": c.model,
                "latencyMs": c.latency_ms,
                "text": c.text[:50],
                "tokensEstimated": c.usage.estimated,
            }
        except ProviderError as e:
            results[tier] = {"ok": False, "error": str(e), "type": type(e).__name__}

    all_ok = all(r.get("ok") for r in results.values())
    return {
        "ok": all_ok,
        "provider": _provider.name,
        "baseUrl": _provider.base_url,
        "tiers": results,
    }


# ─────────────────────────────────────────────────────────────────
# 呼叫介面
# ─────────────────────────────────────────────────────────────────


class CompleteRequest(BaseModel):
    tier: Literal["HIGH", "MID", "LIGHT"] = "MID"
    system: str = ""
    user: str = Field(min_length=1)
    max_tokens: int = Field(default=4096, ge=1, le=200_000)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    # 供用量記錄歸因，對應 AiUsageLog.purpose / refType / refId
    purpose: str = "OTHER"
    ref_type: str | None = None
    ref_id: str | None = None


class CompleteResponse(BaseModel):
    text: str
    model: str
    provider: str
    input_tokens: int
    output_tokens: int
    tokens_estimated: bool
    latency_ms: int


@app.post("/v1/complete", response_model=CompleteResponse)
async def complete(req: CompleteRequest) -> CompleteResponse:
    if _provider is None:
        raise HTTPException(503, detail=f"provider 未就緒：{_provider_error}")

    try:
        c = await _provider.complete(
            tier=req.tier,
            system=req.system,
            user=req.user,
            max_tokens=req.max_tokens,
            temperature=req.temperature,
        )
    except ContentRefused as e:
        # 422 而非 500：這不是系統故障，呼叫端要據此換一種問法或轉人工。
        raise HTTPException(422, detail=str(e)) from e
    except FatalError as e:
        raise HTTPException(502, detail=str(e)) from e
    except RetryableError as e:
        # 503 讓上游的佇列知道「稍後再試」是合理的
        raise HTTPException(503, detail=str(e)) from e

    return CompleteResponse(
        text=c.text,
        model=c.model,
        provider=c.provider,
        input_tokens=c.usage.input_tokens,
        output_tokens=c.usage.output_tokens,
        tokens_estimated=c.usage.estimated,
        latency_ms=c.latency_ms,
    )
