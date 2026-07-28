"""
第三方 OpenAI 相容閘道的參數協商。

「OpenAI 相容」不是一個規格，是一個大致的方向。同樣是
`/v1/chat/completions`，不同閘道與不同世代的模型對參數的要求會
互相矛盾，而且全部是 400、只有真的送出請求之後才知道：

  · 舊模型吃 max_tokens；新一代推理模型只吃 max_completion_tokens
  · 舊模型吃任意 temperature；推理模型只接受預設值
  · 有些閘道不認得 image_url.detail

要求使用者自己查「我的閘道屬於哪一種」不合理——他們手上通常只有
一個網址、一把金鑰、一個模型名稱。所以協商由程式做。

這一支用假的 HTTP 用戶端驗協商邏輯，不需要網路也不花錢。
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import providers as P  # noqa: E402


def _ok_body() -> str:
    return json.dumps(
        {
            "choices": [{"message": {"content": "好"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 3},
            "model": "test-model",
        }
    )


class _Resp:
    def __init__(self, status: int, text: str) -> None:
        self.status_code, self.text = status, text

    def json(self):
        return json.loads(self.text)


class _Client:
    """依序回傳預先排好的回應，並記下每一次送出的 body。"""

    def __init__(self, script: list[tuple[int, str]]) -> None:
        self.script = script
        self.sent: list[dict] = []

    async def post(self, url, headers=None, json=None):  # noqa: A002
        self.sent.append(json)
        i = min(len(self.sent) - 1, len(self.script) - 1)
        return _Resp(*self.script[i])


def _provider(script):
    cfg = P.ProviderConfig(
        provider="openai",
        api_key="not-a-real-key",
        base_url="https://example.invalid/v1",
        models={"MID": "test-model"},
    )
    p = P.OpenAIProvider(cfg)
    fake = _Client(script)

    async def _client():
        return fake

    p.client = _client  # type: ignore[method-assign]
    return p, fake


def _call(p, **kw):
    kw.setdefault("model", "test-model")
    kw.setdefault("system", "s")
    kw.setdefault("user", "u")
    kw.setdefault("max_tokens", 100)
    kw.setdefault("temperature", 0.0)
    return asyncio.run(p._call(**kw))


def test_switches_to_max_completion_tokens():
    """
    新一代模型拒絕 max_tokens。這是接 gpt-5 系列閘道時第一個會撞到的
    東西，而錯誤訊息長得像「參數不支援」，不像「你要換一個參數名」。
    """
    p, fake = _provider([
        (400, '{"error":{"message":"Unsupported parameter: \'max_tokens\' is not supported with this model. Use \'max_completion_tokens\' instead."}}'),
        (200, _ok_body()),
    ])
    out = _call(p)
    assert out.text == "好"
    assert "max_completion_tokens" in fake.sent[-1]
    assert "max_tokens" not in fake.sent[-1]


def test_drops_temperature_when_rejected():
    """推理模型只接受預設 temperature。給 0.0 也會被拒。"""
    p, fake = _provider([
        (400, '{"error":{"message":"Unsupported value: \'temperature\' does not support 0.0 with this model. Only the default (1) value is supported."}}'),
        (200, _ok_body()),
    ])
    _call(p)
    assert "temperature" not in fake.sent[-1]


def test_negotiates_both_in_one_call():
    """兩個都要換時，一次呼叫內解決，不要讓使用者跑三次才成功。"""
    p, fake = _provider([
        (400, '{"error":{"message":"Unsupported parameter: use max_completion_tokens"}}'),
        (400, '{"error":{"message":"Unsupported value: temperature"}}'),
        (200, _ok_body()),
    ])
    out = _call(p)
    assert out.text == "好"
    assert "max_completion_tokens" in fake.sent[-1]
    assert "temperature" not in fake.sent[-1]


def test_remembers_the_result():
    """
    協商一次就好。每次呼叫都先撞一次 400 的話，題本有幾頁就多付
    幾次失敗的請求，而且延遲加倍。
    """
    p, fake = _provider([
        (400, '{"error":{"message":"use max_completion_tokens"}}'),
        (200, _ok_body()),
    ])
    _call(p)
    n = len(fake.sent)
    _call(p)
    assert len(fake.sent) == n + 1, "第二次呼叫又試錯了一遍"
    assert "max_completion_tokens" in fake.sent[-1]


def test_a_real_400_still_raises():
    """
    協商只處理「參數形狀」這一類。其他 400（模型名稱錯、內容過長）
    要照樣往上拋——把真的錯誤吞掉，症狀會變成無盡重試。
    """
    p, _ = _provider([(400, '{"error":{"message":"model \'nope\' does not exist"}}')])
    try:
        _call(p)
        raise AssertionError("真的錯誤沒有拋出來")
    except P.ProviderError as e:
        assert "nope" in str(e) or "400" in str(e)


def test_image_detail_is_dropped_when_unsupported():
    """有些閘道不認得 image_url.detail。認不得就不要送。"""
    p, fake = _provider([
        (400, '{"error":{"message":"Invalid image_url: unknown field \'detail\'"}}'),
        (200, _ok_body()),
    ])
    _call(p, images=[b"\x89PNG\r\n\x1a\n" + b"\x00" * 32])
    parts = fake.sent[-1]["messages"][-1]["content"]
    img = [x for x in parts if x.get("type") == "image_url"][0]
    assert "detail" not in img["image_url"]


def test_images_are_sent_as_data_urls():
    """基本形狀：圖要在 user 訊息裡，而且是 data URL。"""
    p, fake = _provider([(200, _ok_body())])
    _call(p, images=[b"\x89PNG\r\n\x1a\n" + b"\x00" * 32])
    parts = fake.sent[-1]["messages"][-1]["content"]
    img = [x for x in parts if x.get("type") == "image_url"][0]
    assert img["image_url"]["url"].startswith("data:image/png;base64,")
    assert any(x.get("type") == "text" for x in parts), "圖旁邊要有文字指示"
