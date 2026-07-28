"""
雲端智學 — 模型供應者抽象層

支援三種 provider，切換不需要改任何呼叫端程式碼：

  anthropic  Anthropic Messages API 協定
  openai     OpenAI Chat Completions 協定（含所有相容閘道）
  mock       不呼叫外部服務，回傳結構正確的假資料

三者都接受自訂 Base URL，所以可以接：
  - 官方端點
  - 企業閘道／代理（LiteLLM、one-api、Cloudflare AI Gateway…）
  - 自架推論服務（vLLM、Ollama、LocalAI…）

設計上的三個決定值得說明。

第一，**回傳型別統一**。呼叫端拿到的永遠是 Completion，不必知道
底下是哪一種協定。這樣分級路由、重試、成本記錄都只要寫一份。

第二，**token 用量一律回報，拿不到就估算**。有些相容閘道不回傳
usage 欄位，若讓它變成 None，成本歸因與月度預算就會有破洞 ——
寧可用字元數粗估並標記 estimated=True，也不要留空。

第三，**錯誤分類而非直接往上拋**。上游的失敗有三種性質完全不同的
情況：可重試（429、5xx、逾時）、不可重試（401、400）、以及內容
被拒（安全過濾）。混在一起會讓重試邏輯在認證錯誤上白白重試三次，
每次等 180 秒。
"""

from __future__ import annotations

import abc
import base64
import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

log = logging.getLogger("yunzhi.ai.providers")

Tier = Literal["HIGH", "MID", "LIGHT"]


# ─────────────────────────────────────────────────────────────────
# 型別
# ─────────────────────────────────────────────────────────────────


class ProviderError(Exception):
    """上游呼叫失敗的基底。"""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


class RetryableError(ProviderError):
    """限流、暫時性伺服器錯誤、逾時 —— 值得重試。"""


class FatalError(ProviderError):
    """認證失敗、請求格式錯誤、模型不存在 —— 重試沒有意義。"""


class ContentRefused(ProviderError):
    """上游的安全過濾拒絕了這次請求。"""


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    # 上游沒回報 usage 時為 True，成本數字僅供參考
    estimated: bool = False


@dataclass
class Completion:
    text: str
    model: str
    provider: str
    usage: Usage
    latency_ms: int
    raw: dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass
class ProviderConfig:
    provider: str
    api_key: str
    base_url: str
    models: dict[str, str]
    timeout: float = 180.0
    max_retries: int = 3
    max_concurrency: int = 4


def _estimate_tokens(text: str) -> int:
    """
    粗估。中文約 1 字 ≈ 1 token，英文約 4 字元 ≈ 1 token。
    只在上游不回報 usage 時使用，且結果會被標記為 estimated。
    """
    if not text:
        return 0
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
    other = len(text) - cjk
    return cjk + max(1, other // 4)


# ─────────────────────────────────────────────────────────────────
# 基底
# ─────────────────────────────────────────────────────────────────


class BaseProvider(abc.ABC):
    name: str = "base"
    default_base_url: str = ""

    def __init__(self, cfg: ProviderConfig):
        self.cfg = cfg
        self.base_url = (cfg.base_url or self.default_base_url).rstrip("/")
        self._sem = asyncio.Semaphore(cfg.max_concurrency)
        self._client: httpx.AsyncClient | None = None

    async def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.cfg.timeout, connect=15.0),
                # 自架閘道常常是單機且連線數有限，不要開太多
                limits=httpx.Limits(max_connections=self.cfg.max_concurrency * 2),
                follow_redirects=False,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def model_for(self, tier: Tier) -> str:
        return self.cfg.models[tier]

    @abc.abstractmethod
    async def _call(
        self,
        *,
        model: str,
        system: str,
        user: str,
        max_tokens: int,
        temperature: float,
        images: list[bytes] | None = None,
    ) -> Completion: ...

    async def complete(
        self,
        *,
        tier: Tier = "MID",
        system: str = "",
        user: str,
        max_tokens: int = 4096,
        temperature: float = 0.0,
        images: list[bytes] | None = None,
    ) -> Completion:
        """
        帶重試與併發控制的呼叫入口。

        退避採指數加抖動。固定間隔的重試在限流情境下會讓所有
        worker 同時再打一次，把限流變成自我維持的迴圈。
        """
        model = self.model_for(tier)
        last: Exception | None = None

        for attempt in range(self.cfg.max_retries + 1):
            try:
                async with self._sem:
                    return await self._call(
                        model=model,
                        system=system,
                        user=user,
                        max_tokens=max_tokens,
                        temperature=temperature,
                        images=images,
                    )
            except FatalError:
                raise
            except ContentRefused:
                raise
            except (RetryableError, httpx.TimeoutException, httpx.TransportError) as e:
                last = e
                if attempt >= self.cfg.max_retries:
                    break
                delay = min(2**attempt, 30) + (time.time() % 1)
                log.warning(
                    "AI 呼叫失敗，%.1f 秒後重試（第 %d/%d 次）：%s",
                    delay,
                    attempt + 1,
                    self.cfg.max_retries,
                    e,
                )
                await asyncio.sleep(delay)

        raise RetryableError(f"重試 {self.cfg.max_retries} 次後仍失敗：{last}")

    @staticmethod
    def _classify(status: int, body: str) -> ProviderError:
        if status in (408, 409, 425, 429) or status >= 500:
            return RetryableError(f"上游回應 {status}：{body[:300]}", status=status)
        if status in (401, 403):
            return FatalError(
                f"上游拒絕認證（{status}）。請檢查 AI_API_KEY 是否正確、"
                f"以及 AI_BASE_URL 是否指向對應的服務。原始回應：{body[:200]}",
                status=status,
            )
        if status == 404:
            return FatalError(
                f"端點或模型不存在（404）。接自訂閘道時，請確認 AI_BASE_URL "
                f"已包含正確的路徑前綴（OpenAI 協定通常需要以 /v1 結尾），"
                f"且模型名稱是該閘道認得的名稱。原始回應：{body[:200]}",
                status=status,
            )
        return FatalError(f"上游回應 {status}：{body[:300]}", status=status)



def _image_mime(data: bytes) -> str:
    """
    以魔術位元組判定影像型態。

    寫死成 image/png 是很容易犯的錯：管線第一階段的產出確實是 PNG，
    但老師直接上傳的照片是 JPEG 或 HEIC，而上游會依 media_type 解碼——
    宣告錯了會得到一個看起來像模型能力不足的失敗（「看不懂這張圖」），
    實際上是格式標錯。
    """
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:3] == b"GIF":
        return "image/gif"
    # HEIC 兩家上游都不收，呼叫端應在正規化階段就轉成 PNG。
    # 走到這裡代表有人繞過了正規化，讓它以明確的錯誤現形。
    if data[4:8] == b"ftyp":
        raise FatalError(
            "HEIC／HEIF 影像不能直接送給模型，請先經過 normalize 階段轉檔。"
        )
    raise FatalError(f"無法辨識的影像格式，前 8 個位元組：{data[:8]!r}")


# ─────────────────────────────────────────────────────────────────
# Anthropic Messages API
# ─────────────────────────────────────────────────────────────────


class AnthropicProvider(BaseProvider):
    name = "anthropic"
    default_base_url = "https://api.anthropic.com"

    async def _call(
        self, *, model, system, user, max_tokens, temperature, images=None
    ) -> Completion:
        client = await self.client()
        t0 = time.perf_counter()

        # 影像放在文字之前。這不是風格問題——兩種協定的官方指引都
        # 說影像在前的辨識品質較好，而版面分析整個階段都靠它。
        content: list[dict[str, Any]] = [
            {
                "type": "image",
                "source": {"type": "base64", "media_type": _image_mime(img),
                           "data": base64.b64encode(img).decode()},
            }
            for img in (images or [])
        ]
        content.append({"type": "text", "text": user})

        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [{"role": "user", "content": content}],
        }
        if system:
            payload["system"] = system

        try:
            r = await client.post(
                f"{self.base_url}/v1/messages",
                headers={
                    "x-api-key": self.cfg.api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json=payload,
            )
        except httpx.HTTPError as e:
            raise RetryableError(f"連線失敗：{e}") from e

        if r.status_code != 200:
            raise self._classify(r.status_code, r.text)

        data = r.json()

        if data.get("stop_reason") == "refusal":
            raise ContentRefused("上游的安全過濾拒絕了這次請求")

        text = "".join(
            b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
        )
        u = data.get("usage") or {}
        usage = Usage(
            input_tokens=int(u.get("input_tokens", 0)),
            output_tokens=int(u.get("output_tokens", 0)),
        )
        if not u:
            usage = Usage(_estimate_tokens(system + user), _estimate_tokens(text), True)

        return Completion(
            text=text,
            model=data.get("model", model),
            provider=self.name,
            usage=usage,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            raw=data,
        )


# ─────────────────────────────────────────────────────────────────
# OpenAI Chat Completions（含所有相容閘道）
# ─────────────────────────────────────────────────────────────────


class OpenAIProvider(BaseProvider):
    name = "openai"
    default_base_url = "https://api.openai.com/v1"

    async def _call(
        self, *, model, system, user, max_tokens, temperature, images=None
    ) -> Completion:
        client = await self.client()
        t0 = time.perf_counter()

        messages: list[dict[str, Any]] = []
        if system:
            messages.append({"role": "system", "content": system})

        if images:
            parts: list[dict[str, Any]] = [
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{_image_mime(img)};base64,{base64.b64encode(img).decode()}",
                        # 版面分析要看得清題號與選項標記，不能用低解析模式
                        "detail": "high",
                    },
                }
                for img in images
            ]
            parts.append({"type": "text", "text": user})
            messages.append({"role": "user", "content": parts})
        else:
            messages.append({"role": "user", "content": user})

        try:
            r = await client.post(
                f"{self.base_url}/chat/completions",
                headers={
                    "authorization": f"Bearer {self.cfg.api_key}",
                    "content-type": "application/json",
                },
                json={
                    "model": model,
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                },
            )
        except httpx.HTTPError as e:
            raise RetryableError(f"連線失敗：{e}") from e

        if r.status_code != 200:
            raise self._classify(r.status_code, r.text)

        data = r.json()
        choices = data.get("choices") or []
        if not choices:
            raise FatalError(f"回應中沒有 choices：{json.dumps(data)[:300]}")

        choice = choices[0]
        if choice.get("finish_reason") == "content_filter":
            raise ContentRefused("上游的內容過濾拒絕了這次請求")

        text = (choice.get("message") or {}).get("content") or ""

        u = data.get("usage") or {}
        if u:
            usage = Usage(
                input_tokens=int(u.get("prompt_tokens", 0)),
                output_tokens=int(u.get("completion_tokens", 0)),
            )
        else:
            # 不少相容閘道省略 usage。估算而非留空 —— 見檔頭說明。
            usage = Usage(_estimate_tokens(system + user), _estimate_tokens(text), True)

        return Completion(
            text=text,
            model=data.get("model", model),
            provider=self.name,
            usage=usage,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            raw=data,
        )


# ─────────────────────────────────────────────────────────────────
# Mock
#
# 存在的理由不是「先做個假的」，而是三個實際用途：
#   1. 安裝驗證 —— 沒有 key 也能確認整條管線接得起來
#   2. CI —— 測試不該依賴外部服務與花錢
#   3. 降級演練 —— 驗證 AI 掛掉時考試是否照常運作
# 所以它會回傳結構正確、可通過 schema 驗證的資料。
# ─────────────────────────────────────────────────────────────────


class MockProvider(BaseProvider):
    name = "mock"
    default_base_url = "mock://local"

    async def _call(
        self, *, model, system, user, max_tokens, temperature, images=None
    ) -> Completion:
        t0 = time.perf_counter()
        await asyncio.sleep(0.05)  # 模擬網路延遲，讓時序問題在測試中就浮現

        text = _mock_reply(system, user)

        return Completion(
            text=text,
            model=f"mock/{model}",
            provider=self.name,
            usage=Usage(_estimate_tokens(user), _estimate_tokens(text), True),
            latency_ms=int((time.perf_counter() - t0) * 1000),
            raw={"mock": True},
        )



# ─────────────────────────────────────────────────────────────────
# Mock 的回應內容
#
# 這一段刻意寫得認真：回傳「{"mock": true}」這種東西的話，
# 上游的 _structured 會驗證失敗、重試三次、然後拋錯——於是
# 「用 mock 驗證整條管線接得起來」這個用途根本達不到，
# 而那正是 mock 存在的第一個理由。
#
# 所以它要依系統提示判斷對方在問什麼，回傳**能通過該 schema
# 驗證**的假資料。資料內容明顯是假的（題幹寫明「這是假資料」），
# 不會有人誤以為是真的解析結果。
# ─────────────────────────────────────────────────────────────────

_MOCK_NOTE = "（AI_PROVIDER=mock 產生的假資料，僅供安裝驗證）"


def _mock_reply(system: str, user: str) -> str:
    s = system or ""

    # 整頁閱讀。要排在「版面分析」之前判斷——兩者的提示詞都提到
    # 版面，而這一支回的是完整的題目而不只是區塊。
    if "題本的判讀器" in s:
        return json.dumps(
            {
                "genre": "worksheet",
                "blocks": [
                    {
                        "type": "STEM",
                        "bbox": {"page": 1, "x0": 0.08, "y0": 0.12, "x1": 0.92, "y1": 0.18},
                        "text": f"1. 這是 mock 讀出來的題幹。{_MOCK_NOTE}",
                    },
                    {
                        "type": "FIGURE",
                        "bbox": {"page": 1, "x0": 0.60, "y0": 0.30, "x1": 0.92, "y1": 0.55},
                        "text": "假的坐標圖",
                    },
                ],
                "questions": [
                    {
                        "question_no": "1",
                        "label": "範例 1",
                        "type": "SINGLE_CHOICE",
                        "content": f"這是 mock 讀出來的題幹，不是真的題目。{_MOCK_NOTE}",
                        "options": [
                            {"order": 1, "label": "(1)", "content": "假選項一"},
                            {"order": 2, "label": "(2)", "content": "假選項二"},
                            {"order": 3, "label": "(3)", "content": "假選項三"},
                        ],
                        "printed_answer_keys": [2],
                        "explanation": f"這是 mock 的假詳解。{_MOCK_NOTE}",
                        "source_bbox": {"page": 1, "x0": 0.08, "y0": 0.12, "x1": 0.92, "y1": 0.55},
                        "confidence": 0.35,
                        "confidence_reasons": [
                            {
                                "code": "mock_provider",
                                "detail": f"AI_PROVIDER=mock，這一題的內容是假的，不可入庫。{_MOCK_NOTE}",
                                "severity": "error",
                            }
                        ],
                    }
                ],
                "materials": [
                    {"title": f"假的觀念頁{_MOCK_NOTE}", "body": "這裡本來會是講義的文法表格或公式整理。"}
                ],
                "unsure": [f"整份都是 mock 產生的，沒有任何內容經過辨識。{_MOCK_NOTE}"],
            },
            ensure_ascii=False,
        )

    if "版面分析" in s:
        return json.dumps(
            {
                "blocks": [
                    {
                        "type": "SECTION_HEADER",
                        "bbox": {"page": 1, "x0": 0.08, "y0": 0.05, "x1": 0.92, "y1": 0.09},
                        "text": f"一、單選題（占 10 分）{_MOCK_NOTE}",
                    },
                    {
                        "type": "STEM",
                        "bbox": {"page": 1, "x0": 0.08, "y0": 0.12, "x1": 0.92, "y1": 0.18},
                        "text": f"1. 這是 mock 產生的題幹。{_MOCK_NOTE}",
                    },
                    {
                        "type": "OPTION",
                        "bbox": {"page": 1, "x0": 0.12, "y0": 0.20, "x1": 0.92, "y1": 0.23},
                        "text": "(1) 假選項一",
                    },
                    {
                        "type": "OPTION",
                        "bbox": {"page": 1, "x0": 0.12, "y0": 0.24, "x1": 0.92, "y1": 0.27},
                        "text": "(2) 假選項二",
                    },
                ],
                "group_ranges": [],
            },
            ensure_ascii=False,
        )

    if "結構化" in s or "StructuredQuestion" in s:
        return json.dumps(
            {
                "questions": [
                    {
                        "question_no": "1",
                        "type": "SINGLE_CHOICE",
                        "content": f"這是 mock 產生的題目，不是真的題幹。{_MOCK_NOTE}",
                        "options": [
                            {"order": 1, "label": "1", "content": "假選項一"},
                            {"order": 2, "label": "2", "content": "假選項二"},
                            {"order": 3, "label": "3", "content": "假選項三"},
                            {"order": 4, "label": "4", "content": "假選項四"},
                            {"order": 5, "label": "5", "content": "假選項五"},
                        ],
                        "score": 5,
                        "confidence": 0.5,
                        "confidence_reasons": [
                            {
                                "code": "mock_provider",
                                "detail": "目前使用 mock provider，此候選題為假資料，不可入庫。",
                                "severity": "error",
                            }
                        ],
                    }
                ]
            },
            ensure_ascii=False,
        )

    if "推導" in s or "solve" in s.lower():
        return json.dumps(
            {
                "approach": "mock",
                "reasoning": f"mock provider 不做真的推導。{_MOCK_NOTE}",
                "answer_keys": [1],
                "answer_slots": [],
                "answer_text": None,
                "confidence": 0.1,
            },
            ensure_ascii=False,
        )

    if "知識點" in s:
        # 明確表態「沒有合適候選」而不是硬挑一個：mock 沒有能力
        # 判斷知識點，假裝有反而會讓安裝驗證通過一個壞掉的設定。
        return json.dumps(
            {
                "picks": [],
                "no_suitable_candidate": True,
                "difficulty": 0.5,
                "bloom_level": "UNDERSTAND",
                "bloom_level_legacy": "COMPREHENSION",
                "est_time_seconds": 90,
            },
            ensure_ascii=False,
        )

    if "評分原則" in s or "rubric" in s.lower():
        return json.dumps(
            {
                "name": f"假評分原則{_MOCK_NOTE}",
                "mode": "BAND",
                "total_score": 25,
                "dimensions": [],
                "bands": [
                    {"grade": "A", "score_max": 25, "score_min": 19,
                     "descriptor": f"假等第描述 A。{_MOCK_NOTE}"},
                    {"grade": "B", "score_max": 18, "score_min": 12,
                     "descriptor": "假等第描述 B。"},
                    {"grade": "C", "score_max": 11, "score_min": 1,
                     "descriptor": "假等第描述 C。"},
                    {"grade": "0", "score_max": 0, "score_min": 0,
                     "descriptor": "未作答或完全離題。"},
                ],
            },
            ensure_ascii=False,
        )

    if "json" in user.lower() or "schema" in user.lower():
        return json.dumps(
            {"mock": True, "note": f"未辨識的 schema。{_MOCK_NOTE}"}, ensure_ascii=False
        )

    return f"（AI_PROVIDER=mock）此為假回應，用於安裝驗證與降級演練。{_MOCK_NOTE}"


# ─────────────────────────────────────────────────────────────────
# 工廠
# ─────────────────────────────────────────────────────────────────

_REGISTRY: dict[str, type[BaseProvider]] = {
    "anthropic": AnthropicProvider,
    "openai": OpenAIProvider,
    "mock": MockProvider,
}


def build_provider(environ: dict[str, str] | None = None) -> BaseProvider:
    e = environ if environ is not None else dict(os.environ)
    name = (e.get("AI_PROVIDER") or "mock").strip().lower()

    if name not in _REGISTRY:
        raise FatalError(
            f"AI_PROVIDER='{name}' 不認得。可用值：{', '.join(sorted(_REGISTRY))}"
        )

    api_key = (e.get("AI_API_KEY") or "").strip()
    if name != "mock" and not api_key:
        raise FatalError(
            f"AI_PROVIDER={name} 需要 AI_API_KEY。"
            f"若只是要驗證安裝，把 AI_PROVIDER 設為 mock。"
        )

    cfg = ProviderConfig(
        provider=name,
        api_key=api_key,
        base_url=(e.get("AI_BASE_URL") or "").strip(),
        models={
            "HIGH": e.get("AI_MODEL_HIGH") or "claude-opus-4-20250514",
            "MID": e.get("AI_MODEL_MID") or "claude-sonnet-4-20250514",
            "LIGHT": e.get("AI_MODEL_LIGHT") or "claude-haiku-4-20250514",
        },
        timeout=float(e.get("AI_TIMEOUT_SECONDS") or 180),
        max_retries=int(e.get("AI_MAX_RETRIES") or 3),
        max_concurrency=int(e.get("AI_MAX_CONCURRENCY") or 4),
    )

    provider = _REGISTRY[name](cfg)
    log.info(
        "AI provider = %s，base_url = %s，模型 HIGH/MID/LIGHT = %s / %s / %s",
        name,
        provider.base_url,
        cfg.models["HIGH"],
        cfg.models["MID"],
        cfg.models["LIGHT"],
    )
    return provider
