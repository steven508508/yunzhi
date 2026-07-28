"""
數學版面重建的測試。

這一段的錯誤特別隱蔽：分數沒組起來的話，下游收到的是
`－3－（－1）＝－7` 這種看得懂字、看不懂意思的碎片，
而模型會盡力理解然後給出合理但錯誤的結果。沒有任何錯誤訊息。

所有案例的幾何都照抄自真實講義的座標（翰林《互動式教學講義·
數學(1)》4-1、4-3），包括那些一眼看不出問題的形狀。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline.mathlayout import (  # noqa: E402
    Frag,
    Rule,
    apply_scripts,
    build_fractions,
    build_overlines,
    classify_rules,
    group_lines,
    wrap_math,
)


def frag(text, x0, base, size=9.92, x1=None, ink="000000"):
    return Frag(
        text=text,
        x0=x0,
        x1=x1 if x1 is not None else x0 + size * (1.0 if len(text) == 1 else len(text)),
        base=base,
        size=size,
        ink=ink,
    )


def render(frags):
    return "".join(f.text for f in sorted(frags, key=lambda f: f.x0))


# ── 細線的角色 ───────────────────────────────────────────────────


def test_rule_with_text_above_and_below_is_a_fraction():
    chars = [frag("7", 250, 205.74), frag("2", 250, 220.62)]
    rules = classify_rules([Rule(x0=245, x1=265, y=209.37)], chars)
    assert rules[0].role == "frac"


def test_rule_with_text_only_below_is_an_overline():
    """線段 AB 上面那一橫。只有下面有字。"""
    chars = [frag("O", 149, 166.06), frag("P", 156, 166.06)]
    rules = classify_rules([Rule(x0=149.1, x1=162.4, y=157.55)], chars)
    assert rules[0].role == "overline"


def test_rule_with_text_only_above_is_a_blank():
    """填空題的作答線。上面有字（題目），下面沒有。"""
    chars = [frag("為", 100, 200)]
    rules = classify_rules([Rule(x0=98, x1=140, y=203)], chars)
    assert rules[0].role == "underline"


def test_isolated_rule_is_decoration():
    rules = classify_rules([Rule(x0=100, x1=400, y=500)], [frag("字", 100, 100)])
    assert rules[0].role == "none"


# ── 分數 ─────────────────────────────────────────────────────────


def _slope_line():
    """
    真實座標：4-1 範例 1 的
        m＝(－5－2)/(－3－(－1))＝(－7)/(－2)＝7/2
    """
    chars = [
        frag("m", 156.3, 213.18),
        frag("＝", 166.0, 213.18),
        # 第一個分數
        frag("－5－2", 190.8, 205.74, x1=220.5),
        frag("－3－（－1）", 180.8, 220.62, x1=235.5),
        frag("＝", 235.4, 213.18),
        # 第二個
        frag("－7", 247.8, 205.74, x1=262.7),
        frag("－2", 247.8, 220.62, x1=262.7),
        frag("＝", 265.2, 213.18),
        # 第三個
        frag("7", 277.6, 205.74, x1=282.6),
        frag("2", 277.6, 220.62, x1=282.6),
    ]
    rules = [
        Rule(x0=175.9, x1=235.4, y=209.37),
        Rule(x0=245.3, x1=265.2, y=209.37),
        Rule(x0=275.1, x1=285.0, y=209.37),
    ]
    return chars, classify_rules(rules, chars)


def test_fractions_are_rebuilt():
    chars, rules = _slope_line()
    frags, made = build_fractions(chars, rules)
    assert made == 3
    text = render(frags)
    assert r"\frac{-5-2}{-3-(-1)}" in text
    assert r"\frac{-7}{-2}" in text
    assert r"\frac{7}{2}" in text


def test_fraction_parts_end_up_on_one_line():
    """
    分子、分母、主行的基線各差幾個點，PyMuPDF 會把它們切成四個區塊。
    重組之後必須回到同一行，否則切題會把算式當成獨立的段落。
    """
    chars, rules = _slope_line()
    frags, _ = build_fractions(chars, rules)
    lines = group_lines(frags)
    assert len(lines) == 1, [[f.text for f in ln] for ln in lines]


def test_incomplete_fraction_is_left_alone():
    """
    只有分子沒有分母時不要硬組。半個分數比沒有分數更難查——
    它看起來是對的。
    """
    chars = [frag("7", 250, 205.74)]
    rules = [Rule(x0=245, x1=265, y=209.37, role="frac")]
    frags, made = build_fractions(chars, rules)
    assert made == 0
    assert render(frags) == "7"


# ── 上劃線 ───────────────────────────────────────────────────────


def test_overline_becomes_latex():
    """
    `\\overline{AB}` 與 `AB` 在文字上一樣，但一個是線段、
    一個是兩個變數相乘。不轉的話這個區別就永遠消失了。
    """
    chars = [frag("O", 149.1, 166.06, x1=156.3), frag("P", 156.3, 166.06, x1=162.4)]
    rules = classify_rules([Rule(x0=149.1, x1=162.4, y=157.55)], chars)
    frags, made = build_overlines(chars, rules)
    assert made == 1
    assert render(frags) == r"\overline{OP}"


# ── 上下標 ───────────────────────────────────────────────────────


def test_superscript_attaches_to_its_base():
    """真實座標：4-3 的 (x－h)²＋(y－k)²＝r²，本文 12.05pt、上標 7.02pt。"""
    chars = [
        frag("）", 88, 150.0, size=12.05, x1=98),
        frag("2", 98, 144.1, size=7.02, x1=102),
        frag("＋", 102, 150.0, size=12.05, x1=112),
    ]
    frags, made = apply_scripts(chars)
    assert made == 1
    assert render(frags) == "）^{2}＋"


def test_subscript_attaches_to_its_base():
    chars = [
        frag("L", 100, 213.18, x1=106),
        frag("1", 106, 215.0, size=7.0, x1=110),
    ]
    frags, made = apply_scripts(chars)
    assert made == 1
    assert render(frags) == "L_{1}"


def test_scripts_must_run_before_line_grouping():
    """
    上標的基線比本文高約 0.5em，已經超過同一行的容差。
    先分行的話，`x²` 的 `2` 會被歸到上一行——實測一份講義，
    這個順序搞錯會讓題目單位從 43 個掉到 25 個。
    """
    chars = [
        frag("x", 100, 150.0, size=12.05, x1=108),
        frag("2", 108, 144.1, size=7.02, x1=112),
        frag("＝", 112, 150.0, size=12.05, x1=124),
    ]
    # 先接上下標 → 一行
    frags, _ = apply_scripts([Frag(**vars(c)) for c in chars])
    assert len(group_lines(frags)) == 1

    # 先分行 → 上標自成一行，這正是要避免的
    assert len(group_lines(chars)) == 2


def test_fraction_is_not_a_script_base():
    """
    分數的基線設在分數線上（比主行高），所以緊接其後、位在主行的
    「＝」看起來就像下標。實測會產生 `\\frac{-4}{1}_{=-4}` 這種東西。
    """
    frac = Frag(text=r"\frac{-4}{1}", x0=180, x1=235, base=209.37, size=9.92, composed=True)
    eq = frag("＝", 235.4, 213.18)
    frags, made = apply_scripts([frac, eq])
    assert made == 0
    assert "_" not in render(frags)


def test_large_char_next_to_small_one_is_not_a_script():
    """字級沒有變小就不是上下標，即使基線有位移。"""
    chars = [frag("A", 100, 200.0), frag("B", 110, 202.0)]
    _, made = apply_scripts(chars)
    assert made == 0


# ── $…$ 的包裹 ───────────────────────────────────────────────────


def test_math_is_wrapped_but_chinese_is_not():
    out = wrap_math(r"（1）連線AB的斜率m＝\frac{-5-2}{-3-(-1)}，如圖（一）")
    assert r"$m=\frac{-5-2}{-3-(-1)}$" in out
    assert "，如圖（一）" in out
    assert "連線AB的斜率" in out.split("$")[0]


def test_cjk_is_never_swallowed_into_math():
    """
    Python 的 '過'.isalnum() 是 True。照 isalnum 判斷會把中文吸進
    數學區間，變成 `$_{2}過點$`，KaTeX 會把整句話當符號排。
    """
    out = wrap_math(r"∵L_{2}過點（1﹐2）")
    assert "過點" not in out.split("$")[1]
    assert out.count("$") == 2


def test_plain_text_is_untouched():
    text = "沒有任何數學結構的一句話。"
    assert wrap_math(text) == text


def test_full_width_operators_become_latex_inside_math():
    out = wrap_math(r"m_{1}＝1")
    assert "$m_{1}=1$" == out


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
            traceback.print_exc(limit=2)
    print(f"\n{len(fns) - failed}/{len(fns)} 通過")
    sys.exit(1 if failed else 0)
