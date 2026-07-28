"""
自答投票的兩個安靜錯誤。

自答的用途是「題本沒附答案時系統自己解一遍」。它產出的東西會變成
**標準答案**，拿去改全班的卷子。所以這裡任何一個看起來合理的錯誤，
代價都是一整班的成績。

稽核抓到的兩個都不會報錯，而且看起來比正確的結果還可信：

  · 五票被限流打掉四票，剩下的一票就是「一致率 100%」——
    系統自動填入，理由欄還寫著「推導 1 次，結果完全一致」。
  · 提示詞明確要求「資訊不足就把 answer_keys 留空」，模型照做，
    三次都留空 → 空答案拿下全部票數 → 一致率 1.0 → 自動填入
    `answerKeys: []`，把題本原本附的答案**清掉**，而交叉驗證
    因為共識為空而靜默跳過。
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("AI_PROVIDER", "mock")
os.environ.setdefault("S3_BUCKET", "test")
os.environ.setdefault("S3_ENDPOINT", "http://localhost:9000")

from pipeline import stages  # noqa: E402
from pipeline.schemas import (  # noqa: E402
    OptionOut,
    QuestionType,
    SolveAttempt,
    StructuredQuestion,
)
from providers import RetryableError  # noqa: E402

QUESTION = StructuredQuestion(
    question_no="7",
    type=QuestionType.SINGLE_CHOICE,
    content="某商品原價 100 元，打八折後再降 10 元，售價為多少？",
    options=[
        OptionOut(order=1, label="(1)", content="60 元"),
        OptionOut(order=2, label="(2)", content="70 元"),
        OptionOut(order=3, label="(3)", content="80 元"),
        OptionOut(order=4, label="(4)", content="90 元"),
    ],
    confidence=0.9,
)


def fake_structured(script):
    """把 _structured 換掉：script 是每次呼叫要回的東西或要拋的例外。"""
    calls = {"n": 0}

    async def _fake(provider, **kw):
        i = calls["n"]
        calls["n"] += 1
        item = script[i % len(script)]
        if isinstance(item, Exception):
            raise item
        return item, {"input_tokens": 0, "output_tokens": 0}

    return _fake, calls


def run(script, votes=5):
    original = stages._structured
    stages._structured, _ = fake_structured(script)
    try:
        return asyncio.run(stages.solve_question(None, QUESTION, n=votes))
    finally:
        stages._structured = original


def attempt(keys, approach="direct"):
    return SolveAttempt(
        approach=approach, reasoning="推導過程", answer_keys=keys
    )


def test_failed_votes_count_against_consistency():
    """
    分母是**投票次數**，不是成功次數。五票只成功一票時，一致率是
    0.2 而不是 1.0——那一票可能是對的，但它不該看起來比五票一致
    還可信。
    """
    script = [
        attempt([1]),
        RetryableError("429 Too Many Requests"),
        RetryableError("429 Too Many Requests"),
        RetryableError("429 Too Many Requests"),
        RetryableError("429 Too Many Requests"),
    ]
    result = run(script, votes=5)
    assert result is not None
    assert abs(result.consistency - 0.2) < 1e-9, (
        f"一票被算成一致率 {result.consistency}"
    )
    assert result.should_autofill is False, "一票不該自動填成標準答案"
    assert result.tier == "low"


def test_all_votes_succeeding_still_reaches_one():
    """全部成功且一致時，一致率仍然是 1.0——修法不可以順便打壞正常情形。"""
    result = run([attempt([3])], votes=3)
    assert result.consistency == 1.0
    assert result.consensus_keys == [3]
    assert result.should_autofill is True


def test_partial_failure_lowers_but_does_not_zero():
    """五票成功三票且三票一致 → 0.6，剛好在自動填入的門檻上。"""
    script = [
        attempt([2]),
        attempt([2]),
        attempt([2]),
        RetryableError("timeout"),
        RetryableError("timeout"),
    ]
    result = run(script, votes=5)
    assert abs(result.consistency - 0.6) < 1e-9


def test_i_do_not_know_is_not_an_answer():
    """
    模型照提示詞說「缺圖，資訊不足」並留空 answer_keys。三次都留空
    **不是共識**——那是三次都答不出來。當成共識的話，系統會把
    `answerKeys: []` 寫回去，把題本原本印的答案清掉。
    """
    blank = SolveAttempt(
        approach="direct",
        reasoning="題幹提到「如右圖」但未提供圖片，無法確定答案。",
        answer_keys=[],
    )
    result = run([blank], votes=3)
    assert result is not None
    assert result.consensus_keys == []
    assert result.consistency == 0.0, (
        f"三次「不知道」被算成一致率 {result.consistency}"
    )
    assert result.should_autofill is False, "不知道不可以被自動填入"


def test_split_vote_is_not_autofilled():
    """兩票對兩票 → 0.4 < 0.6 → 全部候選並列給老師裁決。"""
    result = run([attempt([1]), attempt([4]), attempt([1]), attempt([4])], votes=4)
    assert result.should_autofill is False
    assert len(result.attempts) == 4


def test_no_successful_vote_returns_nothing():
    """全部失敗就回 None，不要生出一個空殼結果讓下游誤以為算過了。"""
    assert run([RetryableError("429")], votes=3) is None


if __name__ == "__main__":
    import traceback

    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ✓ {fn.__name__}")
        except Exception:
            failed += 1
            print(f"  ✗ {fn.__name__}")
            traceback.print_exc(limit=3)
    print(f"\n{len(fns) - failed}/{len(fns)} 通過")
    sys.exit(1 if failed else 0)
