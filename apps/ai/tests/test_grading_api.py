"""
非選題閱卷的提示詞組裝與端點契約。

# 這一支測什麼

**不測「這個分數評得準不準」**——那件事測不了（要真的呼叫模型，而且
一篇作文的分數沒有任何可稽核的基準），而且判斷它可不可用的是 Node 端的
閘門（`apps/web/lib/gradingProposal.mjs`，那裡有八十幾個案例）。

這裡測的是四件在 Python 這一側**會靜靜壞掉**的事：

  一、**規準有沒有真的進到提示詞裡。** 少了它，模型評的是「這篇文章
      好不好」而不是「照這份標準值幾分」，而輸出的形狀完全一樣——
      畫面上看不出差別，只有分數會偏。

  二、**回應裡沒有任何欄位攜帶「最終分數」。** 多一個 `final_score`
      或 `approved`，Node 端的閘門與老師的那一步就繞得過去，
      而繞得過去的路只要存在就會有人走。

  三、**samples 真的送出 N 次呼叫。** 離散度是這個功能判斷「哪幾份
      可以直接採用」的依據，而只呼叫一次的話它永遠是 0——一份擲骰子
      擲出來的分數會標著「很穩」。

  四、**mock provider 回得出通得過閘門的假評分。** 回一段通用評語的話，
      `AI_PROVIDER=mock` 的安裝驗證會看到每一份都被擋下，看起來像功能
      壞了。這一條要求 mock 從答案裡真的複製一段原文。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("AI_PROVIDER", "mock")
os.environ.setdefault("S3_BUCKET", "test")
os.environ.setdefault("S3_ENDPOINT", "http://localhost:9000")

from fakestore import install  # noqa: E402

_FAKE = install()

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
from pipeline.grading_prompts import (  # noqa: E402
    GRADING_MARKER,
    GRADING_PROMPT_VERSION,
    grading_system,
    grading_user,
)

client = TestClient(main.app)
client.__enter__()


ANSWER = (
    "我認為最能說明這件事的是魚市場的清晨。"
    "凌晨三點，攤販把冰塊鋪在木箱上，燈泡一盞一盞亮起來，那時候還沒有任何客人。"
)

RUBRIC = {
    "name": "國寫情意題評分原則",
    "total_score": 25,
    "mode": "BAND",
    "dimensions": [],
    "bands": [
        {
            "grade": "A+",
            "score_min": 22,
            "score_max": 25,
            "descriptor": "經驗寫得具體而且看得出是自己的事，感受與經驗對得起來。",
        },
        {"grade": "0", "score_min": 0, "score_max": 9, "descriptor": "空白或文不對題。"},
    ],
}

REQ = {
    "question": {"type": "ESSAY", "stem": "請說明你對「準備」的理解。", "score": 25, "subject": "CHINESE"},
    "rubric": RUBRIC,
    "answer": ANSWER,
    "samples": 3,
}


def _check(name, cond, detail=""):
    if not cond:
        raise AssertionError(f"{name} 失敗　{detail}")
    print(f"   ✓ {name}")


# ── 一、系統提示 ────────────────────────────────────────────────


def test_system_prompt_states_the_three_hard_rules():
    """
    三條硬規則要在系統提示裡：一字不差的引用、不評文采、不評價學生本人。

    它們不是客套話——閘門真的會擋，而模型看不到規則的時候會寫出
    通得不過的輸出，於是每一份都要重生成三次（三倍的錢，同一個結果）。
    """
    s = grading_system()
    _check("marker 在裡面（mock provider 靠它分辨）", GRADING_MARKER in s)
    _check("版本號在裡面", GRADING_PROMPT_VERSION in s)
    _check("要求一字不差的引用", "一字不差" in s)
    _check("禁止評文采", "不要評文采" in s)
    _check("禁止評價學生本人", "不要評價學生本人" in s)
    _check("說出建議不是分數", "你給的不是分數，是建議" in s)
    _check("有提示注入的防線", "當成作答內容評分" in s)


# ── 二、使用者訊息 ──────────────────────────────────────────────


def test_rubric_goes_into_the_prompt_before_the_answer():
    """
    規準要在答案**前面**。

    反過來的話，模型會先對答案形成一個整體印象，然後拿規準去合理化
    那個印象——那正是「評文采而不是評給分要點」的來源。
    """
    u = grading_user(REQ)
    _check("等第的分數帶在裡面", "22–25 分" in u)
    _check("等第的描述在裡面", RUBRIC["bands"][0]["descriptor"] in u)
    _check("學生的答案在裡面", "魚市場的清晨" in u)
    _check("規準排在答案前面", u.index("評分規準") < u.index("學生的作答"))
    _check("有叫它不要照抄規準", "不要照抄進理由" in u)


def test_no_rubric_says_so_and_asks_for_lower_confidence():
    """
    沒有規準時要**說出來**，而且要求壓低信心。

    這一段不寫的話，模型會用一套自己想的標準評分，而輸出看起來與
    有規準時一模一樣——老師沒有任何線索知道那個分數的依據是什麼。
    """
    u = grading_user(dict(REQ, rubric=None))
    _check("說了沒有規準", "沒有評分規準" in u)
    _check("要求壓低信心", "confidence` 要壓低" in u or "confidence 要壓低" in u)
    _check("要求 dimensions 是空陣列", "空陣列" in u)


def test_blank_answer_is_told_to_be_zero():
    u = grading_user(dict(REQ, answer="   "))
    _check("說了它是空白的", "整題空白" in u)
    _check("要求給 0 分", "分數一律 0" in u)


def test_retry_tells_the_model_what_was_blocked():
    """
    重試要說出上一次違規的類別。不說的話，它會用同樣的方式再寫一次。
    """
    u = grading_user(dict(REQ, retry=1, violations="GENERIC_RATIONALE：整段理由沒有引用"))
    _check("違規的類別進了提示詞", "GENERIC_RATIONALE" in u)
    _check("點出最常犯的那兩條", "一字不差" in u and "加起來等於總分" in u)


# ── 三、端點契約 ────────────────────────────────────────────────


def test_endpoint_returns_n_samples_and_no_final_score():
    r = client.post("/v1/grading/score", json=REQ)
    _check("端點可用", r.status_code == 200, r.text)
    body = r.json()
    _check("回了三份平行的建議", len(body["samples"]) == 3, json.dumps(body)[:300])
    _check("帶得出提示詞版本", body["prompt_version"] == GRADING_PROMPT_VERSION)
    _check("回報 token 用量", body["input_tokens"] > 0 and body["output_tokens"] > 0)
    # **這一條是這一支最重要的斷言。**
    for banned in ("final_score", "approved", "earned_score", "accepted"):
        _check(f"回應裡沒有 {banned}", banned not in body)
    for s in body["samples"]:
        for banned in ("final_score", "approved", "accepted"):
            _check(f"樣本裡沒有 {banned}", banned not in s)


def test_mock_reply_quotes_the_answer_so_it_passes_the_node_gate():
    """
    mock 的假評分要**真的引用一段原文**。

    Node 端的閘門要求「理由裡出現學生答案中連續六個字、而題幹與規準都
    沒有的文字」。回一段通用評語的話，安裝驗證會看到每一份都被擋下三次
    然後記成 BLOCKED——而那看起來像功能壞了。
    """
    r = client.post("/v1/grading/score", json=REQ)
    body = r.json()
    for s in body["samples"]:
        _check("引用了答案裡的原文", "魚市場的清晨" in s["rationale"], s["rationale"])
        _check("說明自己是假資料", "mock" in s["rationale"])
        _check("分數在配分裡面", 0 <= s["score"] <= 25)
        _check("信心壓得很低", s["confidence"] is not None and s["confidence"] <= 0.3)


def test_mock_gives_zero_to_a_blank_answer():
    r = client.post("/v1/grading/score", json=dict(REQ, answer="", samples=1))
    body = r.json()
    _check("空白卷是 0 分", body["samples"][0]["score"] == 0)
    _check("理由說明它是空白的", "空白" in body["samples"][0]["rationale"])


def test_dimensions_add_up_to_the_total():
    """
    分面向時，逐面向加起來要等於總分——那是閘門一定會驗的一條，
    而 mock 過不了的話，安裝驗證會在有規準的題目上全部失敗。
    """
    dim_rubric = {
        "name": "英文作文評分面向",
        "total_score": 20,
        "mode": "DIMENSION",
        "bands": [],
        "dimensions": [
            {"id": "d1", "name": "內容", "max_score": 5, "descriptor": "切題"},
            {"id": "d2", "name": "組織", "max_score": 5, "descriptor": "段落"},
            {"id": "d3", "name": "文法", "max_score": 5, "descriptor": "時態"},
            {"id": "d4", "name": "字彙", "max_score": 5, "descriptor": "用字"},
        ],
    }
    r = client.post(
        "/v1/grading/score",
        json={
            "question": {"type": "ESSAY", "stem": "Write about preparation.", "score": 20},
            "rubric": dim_rubric,
            "answer": ANSWER,
            "samples": 1,
        },
    )
    body = r.json()
    s = body["samples"][0]
    _check("四個面向都評了", len(s["dimensions"]) == 4, json.dumps(s, ensure_ascii=False))
    total = round(sum(d["score"] for d in s["dimensions"]), 2)
    _check("加起來等於總分", abs(total - s["score"]) < 0.011, f"{total} != {s['score']}")
    for d in s["dimensions"]:
        _check(f"{d['name']} 沒有超過上限", d["score"] <= d["max_score"])
        _check(f"{d['name']} 帶得出規準的 id", d["dimension_id"] in ("d1", "d2", "d3", "d4"))


def test_samples_is_bounded():
    """
    上限 5。沒有上限的話，一個打錯的請求就是幾百次模型呼叫。
    """
    r = client.post("/v1/grading/score", json=dict(REQ, samples=9))
    _check("超過上限被擋在 422", r.status_code == 422, r.text)


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(list(globals().items())):
        if not name.startswith("test_") or not callable(fn):
            continue
        print(f"\n── {name}")
        try:
            fn()
        except AssertionError as e:
            print(f"   ✗ {e}")
            failures += 1
    print(f"\n{'失敗 ' + str(failures) if failures else '全部通過'}")
    sys.exit(1 if failures else 0)
