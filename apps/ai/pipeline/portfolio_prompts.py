"""
雲端智學 — 學習歷程輔助與揭露聲明的提示詞

# 這一組的風險：代寫

智慧老師的風險是**洩漏答案**（模型知道答案，學生想要）。
升學建議的風險是**假的精確度**（模型不知道，但學生要一個數字）。
這裡的風險是第三種：**學生要一段可以貼進去的文字。**

而且這裡的對手最積極。問智慧老師「直接告訴我答案」是偷懶；問這裡
「幫我寫」是他真的寫不出來、離截止日剩三天、而且他覺得別人一定
也在用 AI 寫。那個處境下他會一直換說法。

代寫的失效方式也最安靜：學生貼上去、送出去、上榜或沒上榜，整個過程
沒有任何一個時點會有人發現。唯一的症狀是他失去了那個回顧與反思的
過程——而那正是學習歷程檔案存在的全部理由（規格書 §9.1）。

# 真正守住的不是這裡

與前三組同一個結構。提示層擋得住第一次，擋不住第三次；學生連問兩次
「你就給我一個範例嘛」，模型十之八九會給，而且會很自然地包成
「你可以這樣寫：……」。

守住的是 Node 端 `apps/web/lib/portfolioGuard.mjs` 的確定性閘門：
它看完整段輸出，用規則判斷有沒有連續的第一人稱敘述、有沒有「你可以
這樣寫」這一類的框、有沒有一段可以整段貼走的陳述，命中就整段丟掉
重新生成，重試用完就退回一份由程式組出來的制度檢查結果。

所以這裡的措辭以「讓正常情況下的回饋品質好」為目標，不是以「窮盡
所有繞過方式」為目標。後者做不到。

# 揭露聲明是這一支唯一被允許寫第一人稱的路徑

而且它**必須**寫成第一人稱——那是一份要貼進學習歷程檔案、由學生
具名負責的聲明（規格書 §9.2）。它同時必須**隨互動性質變化、不能寫死
成樣板**（§9.6 的驗收準則），所以它非由模型生成不可。

Node 端對這一個 feature 走另一組後處理規則（比對聲明內容與
`AiDisclosureLog` 的實際記錄是否相符），而不是檢查人稱與長度。
若不排除，這個功能會被自己的閘門無限重試——一個功能把自己擋掉。

所以下面的 `_DISCLOSURE_RULES` 與 `_COACH_RULES` 是**兩套互斥的
系統提示**，由 feature 決定用哪一套。混在一起寫的話，模型會在寫回饋
的時候套用聲明那一套的「你可以用第一人稱」。
"""

from __future__ import annotations

import re

# 提示詞版本。改了這個字串，就是承認舊的回饋是用另一套規則產生的。
PORTFOLIO_PROMPT_VERSION = "2026-07-30.1"

#: mock provider 靠它認出「這是學習歷程的請求」。改字串要同步改
#: providers.py 的 `_mock_reply`，否則 AI_PROVIDER=mock 的安裝驗證會
#: 拿到一段通用假回應，然後被閘門擋下三次——看起來像功能壞了。
PORTFOLIO_MARKER = "（學習歷程回饋）"
DISCLOSURE_MARKER = "（AI 使用揭露聲明）"

COACH_FEATURES = ("WRITING_FEEDBACK", "MATERIAL_HINT", "SELECTION_DISCUSS")
DISCLOSURE_FEATURE = "DISCLOSURE_STATEMENT"


# ─────────────────────────────────────────────────────────────────
# 回饋（撰寫回饋、素材提示、選件討論）
# ─────────────────────────────────────────────────────────────────

_COACH_RULES = f"""
你是一位帶過很多屆高三的輔導老師{PORTFOLIO_MARKER}。學生正在準備學習
歷程檔案，他把自己寫的東西與整理好的素材給你看。

# 最重要的一條

**你不可以代替他寫任何一段可以貼進檔案的文字。** 這包含：

· 不寫任何一段第一人稱的敘述。「我從小就對……」「我在高二參加了……」
  不管有沒有加引號、有沒有說「這只是範例」、有沒有加粗，都不行。
· 不用「你可以這樣寫」「參考範例」「修改後的版本」「以下是為你撰寫的」
  「幫你潤飾如下」「草稿如下」這一類句型。**框起來的代寫還是代寫。**
· 不把他的句子改寫成另一個版本給他。潤飾就是代寫的一種——那句話
  最後會出現在他的檔案裡，而它不是他寫的。
· 不用「貴系」「貴校」「綜上所述」「由此可見」這種寫給招生委員看的
  措辭。你是在對學生說話，不是在寫那份文件。

理由要說得出來，因為他一定會再要一次：招生單位重視資料真實性與學生
自主準備；教育部 113 年 12 月 13 日函文要求 AI 使用須誠實揭露並在檔案
中標註；而最根本的是**學習歷程的意義就在於他自己回顧與反思的過程**，
由 AI 代寫等於把那個過程刪掉，只剩一份文件。

他再要一次的時候，用一句話說明，然後**改成問他問題**。

# 你要做的三件事

**一、具體性檢查。** 引用他寫的那一句，指出它沒有落點，然後問。
「你寫『我從社團中學到很多』，但沒有說是什麼事情讓你學到什麼——
那三年裡最卡的一次是什麼？」**引用他自己的原話是可以的而且應該的**，
那不是代寫，那是讓他看見自己寫了什麼。

**二、一致性檢查。** 把他的就讀動機與他挑的成果放在一起看。
「你的動機提到對資料科學有興趣，但三件課程學習成果都是實驗報告——
這中間的連結你要不要說明一下？」

**三、制度檢查。** 字數、必要子項、額外規定。這一項系統已經算好了
（`rule_checks`），你只要把它用人話講出來，**不要自己重算**。

# 素材提示：用他自己的學習軌跡問他

系統會給你他的成績變化與知識點掌握度。用它來問，不要用它來下結論。
「你在高二下的物理從 8 級分到 11 級分，那段時間發生了什麼？這可能是
一個值得寫的轉折。」——這不是代寫，是幫他想起自己的經歷。

**不要說「這代表你很努力」這類的話。** 那是在替他解釋他自己的人生。

# 選件討論：分析與提問，不要幫他選

「你選的三件都是實驗報告，這個系的建議方向提到重視文字表達與團隊
合作，你有沒有其他類型的成果可以考慮？」——問完就停，不要接
「我建議你換成第二件」。

# 形式

· 300 字以內，**至少要有一個問句**，而且問句要具體到他今天晚上就答得出來。
· 用「你」稱呼他。不要用條列式的完整句子——那種格式最容易變成可以
  整段貼走的文字。
· 不要客套、不要鼓勵的話。「加油」「相信你可以的」對他沒有用，
  而且會佔掉他讀那個問題的注意力。
"""


def coach_system() -> str:
    return _COACH_RULES.strip()


def _fmt_items(items: list[dict]) -> str:
    if not items:
        return "（還沒有整理任何素材）"
    lines = []
    for i in items[:30]:
        tags = "、".join(i.get("ability_tags") or []) or "沒有標能力面向"
        sel = "、".join(i.get("selected_for") or []) or "還沒為任何校系勾選"
        lines.append(
            f"· [{i.get('code')}] {i.get('title')}"
            f"（{i.get('semester') or '沒有標學期'}；{tags}；{sel}）"
        )
    return "\n".join(lines)


def _fmt_rule_checks(checks: list[dict]) -> str:
    if not checks:
        return "（沒有制度檢查結果）"
    return "\n".join(
        f"· {'通過' if c.get('ok') else '沒過'}：{c.get('detail')}" for c in checks[:12]
    )


def _fmt_trace(grades: list[dict], abilities: list[dict]) -> str:
    lines = []
    for g in grades[:8]:
        lines.append(
            f"· {g.get('subject')}：{g.get('from')} 級分 → {g.get('to')} 級分"
            f"（{g.get('span')}）"
        )
    for a in abilities[:8]:
        lines.append(f"· 知識點「{a.get('name')}」掌握度 {a.get('mastery')}")
    return "\n".join(lines) or "（沒有可用的學習軌跡）"


_FEATURE_TASK = {
    "WRITING_FEEDBACK": (
        "這一次要做的是**撰寫回饋**：具體性、一致性、制度三類各看一遍，"
        "挑最值得講的一兩件講，不要把三類都寫完。"
    ),
    "MATERIAL_HINT": (
        "這一次要做的是**素材提示**：從他的學習軌跡裡挑一個變化，問他那段時間"
        "發生了什麼。**不要看他的草稿內容**，這一次的任務是幫他想起經歷。"
    ),
    "SELECTION_DISCUSS": (
        "這一次要做的是**選件討論**：看他挑的那幾件呈現的是不是同一種能力，"
        "以及那與目標校系的建議方向合不合。分析與提問，不要幫他選。"
    ),
}


def coach_user(ctx: dict) -> str:
    feature = ctx.get("feature") or "WRITING_FEEDBACK"
    essay = ctx.get("essay") or None
    parts = [_FEATURE_TASK.get(feature, _FEATURE_TASK["WRITING_FEEDBACK"]), ""]

    if feature != "MATERIAL_HINT" and essay:
        parts += [
            f"# 他寫的（{essay.get('kind')}）",
            "",
            str(essay.get("body") or "（還是空白的）"),
            "",
        ]

    parts += [
        "# 他整理的素材",
        "",
        _fmt_items(ctx.get("items") or []),
        "",
        "# 制度檢查的結果（系統算的，不要重算）",
        "",
        _fmt_rule_checks(ctx.get("rule_checks") or []),
        "",
    ]

    if feature == "MATERIAL_HINT":
        parts += [
            "# 他自己的學習軌跡",
            "",
            _fmt_trace(ctx.get("grade_trace") or [], ctx.get("ability_trace") or []),
            "",
        ]

    if ctx.get("program_ref"):
        parts += [f"# 目標校系\n\n{ctx['program_ref']}", ""]

    if ctx.get("question"):
        parts += [f"# 他問的\n\n{ctx['question']}", ""]

    if int(ctx.get("retry") or 0) > 0:
        # 重試時要說清楚上一次為什麼被擋，否則模型會再寫一次一樣的東西。
        # **不要把被擋的原文貼回去**——那會讓它以為那段文字是可用的脈絡。
        parts += [
            "# 注意",
            "",
            "上一次的回覆因為出現了可以被直接貼進檔案的文字而被系統擋下來了。"
            "這一次**完全不要寫任何一段第一人稱的敘述**，改成引用他自己的句子"
            "然後問他問題。",
            "",
        ]

    return "\n".join(parts).strip()


# ─────────────────────────────────────────────────────────────────
# 揭露聲明
#
# 這一段是整個檔案裡唯一允許（而且要求）第一人稱的地方，理由見檔頭。
# ─────────────────────────────────────────────────────────────────

_DISCLOSURE_RULES = f"""
你要寫的是一份**AI 使用揭露聲明**{DISCLOSURE_MARKER}，由學生具名貼進他的
學習歷程檔案。教育部 113 年 12 月 13 日函文要求學生標註 AI 的使用與來源，
所以這份聲明不是加分項，是及格線。

# 這一份要用第一人稱寫，而且要短

它是學生要負責的文件，所以主詞是「本人」。150 字以內，一段就好。

# 它必須對得回記錄，而那是這份聲明唯一的價值

系統會給你這位學生**實際發生過**的每一類 AI 互動與次數。你的聲明：

· **每一類發生過的互動都要提到。** 漏掉任何一類，這份聲明就不是揭露
  而是遺漏——招生委員讀到的會是「這位學生沒有用 AI」，而那與事實不符。
· **不可以提到沒有發生過的互動。** 多說與少說一樣是不符。
· **不可以寫「未使用 AI 輔助工具」**，除非記錄真的是空的。
· **要寫總次數的話，只加「要寫進聲明」那幾行的次數。** 標成
  「（不必寫進聲明）」的那幾類不算——其中一類是**你現在正在寫的
  這份聲明的草擬**，把它加進去的話，學生每按一次「重新產生」數字
  就漲一，而列舉的類別一個都沒有多。不確定的時候寧可不寫總數，
  類別列全比數字漂亮重要。
· **一定要寫「未使用 AI 生成內容」**（或同義的說法），因為這是真的：
  本系統的學習歷程功能不代寫，防代寫閘門擋著。
· 一定要寫出「本文之構思與撰寫由本人完成」這件最重要的事。

# 依實際互動變化，不要套樣板

只用了制度檢查的學生，聲明就這樣寫；用了很多次撰寫回饋的，聲明也要
反映。**每一份都不一樣**——一份看起來像樣板的聲明，招生委員一眼就
知道他沒有認真看待這件事。

# 不要做的事

· 不要解釋 AI 是什麼、不要說明教育部的規定。招生委員知道。
· 不要辯解、不要強調自己很誠實。寫出事實就是誠實。
· 不要用條列式。這是一段要放在文件末尾的話。
"""


def disclosure_system() -> str:
    return _DISCLOSURE_RULES.strip()


#: 記錄裡的功能代號 → 寫進聲明時的說法。與 Node 端
#: `lib/portfolio.mjs` 的 `AI_FEATURE_DISCLOSURE_PHRASES` 對應；
#: 兩邊各有一份是刻意的，因為 Node 端那一份還要餵給退路版本的
#: `safeStatement()`，而這一份是給模型看的脈絡。
_FEATURE_NAMES = {
    "WRITING_FEEDBACK": "撰寫回饋（文字具體性與邏輯一致性）",
    "MATERIAL_HINT": "素材提示（從個人學習紀錄回想經歷）",
    "SELECTION_DISCUSS": "選件討論（成果組合）",
    "INTERVIEW_FEEDBACK": "面試回答的結構回饋",
    "RULE_CHECK": "制度檢查（字數與件數，純規則不含生成）",
    "DISCLOSURE_STATEMENT": "本聲明的草擬",
}

#: 這幾類**必須**出現在聲明裡。`RULE_CHECK` 與 `DISCLOSURE_STATEMENT`
#: 不在裡面，理由見 Node 端 `portfolioGuard.mjs` 的 `MUST_DISCLOSE`：
#: 前者純規則不呼叫模型，後者是這份聲明自己。
_MUST_DISCLOSE = ("WRITING_FEEDBACK", "MATERIAL_HINT", "SELECTION_DISCUSS", "INTERVIEW_FEEDBACK")


def disclosure_user(ctx: dict) -> str:
    counts: dict = ctx.get("counts") or {}
    must = [(k, v) for k, v in counts.items() if k in _MUST_DISCLOSE and v]
    other = [(k, v) for k, v in counts.items() if k not in _MUST_DISCLOSE and v]

    lines = ["# 這位學生實際發生過的 AI 互動", ""]
    if not must and not other:
        lines.append("（一次都沒有。聲明要明確寫出未使用 AI 輔助工具。）")
    else:
        for k, v in must:
            lines.append(f"· **要寫進聲明**　{_FEATURE_NAMES.get(k, k)}：{v} 次")
        for k, v in other:
            lines.append(f"· （不必寫進聲明）　{_FEATURE_NAMES.get(k, k)}：{v} 次")

    if ctx.get("first_at") and ctx.get("last_at"):
        lines += ["", f"期間：{str(ctx['first_at'])[:10]} 到 {str(ctx['last_at'])[:10]}"]

    if ctx.get("ai_level"):
        lines += ["", f"他的班級適用的 AI 使用層級：第 {ctx['ai_level']} 級"]

    notes = ctx.get("notes") or []
    if notes:
        lines += ["", "# 互動的性質（供你寫得具體一點）", ""]
        for n in notes[:12]:
            lines.append(f"· {n.get('nature')}")

    if int(ctx.get("retry") or 0) > 0:
        lines += [
            "",
            "# 注意",
            "",
            "上一次的聲明與實際記錄對不起來（漏掉了發生過的互動，或提到了"
            "沒有發生的互動）被系統擋下來了。這一次**照上面那份清單逐項確認**。",
        ]

    return "\n".join(lines).strip()


def portfolio_system(feature: str) -> str:
    """
    依 feature 選系統提示。

    **兩套是互斥的，不可以合併。** 合併之後模型會在寫回饋的時候套用
    聲明那一套的「這一份要用第一人稱寫」，而那正好是防代寫閘門要擋的
    東西——結果是回饋永遠被擋、重試三次、退回罐頭。
    """
    return disclosure_system() if feature == DISCLOSURE_FEATURE else coach_system()


def portfolio_user(ctx: dict) -> str:
    feature = ctx.get("feature") or "WRITING_FEEDBACK"
    return disclosure_user(ctx) if feature == DISCLOSURE_FEATURE else coach_user(ctx)


# ─────────────────────────────────────────────────────────────────
# mock 的回應
#
# 寫在這裡而不是 providers.py，理由與 grading_prompts.mock_grading_reply
# 相同：假回應要通得過 Node 端的閘門，而閘門的規則與這裡的提示詞是
# 同一套。格式改了、假回應跟著改，兩件事在同一個檔案裡看得到。
# ─────────────────────────────────────────────────────────────────


def mock_portfolio_reply(system: str, user: str) -> str:
    """
    通得過閘門的假回應。

    回饋那一支刻意寫成：沒有任何一段第一人稱敘述、沒有代寫的框、
    有問句。聲明那一支則要對得回記錄，所以它從 user 提示裡把
    「要寫進聲明」的那幾行讀回來——寫死一段的話，記錄裡有互動時
    它會因為漏掉而被擋下三次，而 AI_PROVIDER=mock 的安裝驗證就看不出
    這條路徑到底通不通。

    **次數也一起寫出來，而且只加「要寫進聲明」那幾行。** 這一段的
    數字有一個真的失效方式：`DISCLOSURE_STATEMENT`（草擬這份聲明
    本身）也會進記錄，把它加進去的話，一位只用過 3 次撰寫回饋、
    按了 4 次「重新產生」的學生會拿到「共 7 次」，而列舉的類別只有
    一種。招生委員查不出來，系統查得出來（`portfolioGuard.mjs` 的
    「三之二、次數對不對」）。

    早先這裡不寫數字，於是這條路徑上**唯一有真實失效方式的欄位**
    正好是假回應避開的那一個——閘門的那條規則永遠沒有被端到端跑過。
    假回應的用途是證明這條路通，避開最難的一段就不算通。
    """
    if DISCLOSURE_MARKER in system:
        used = []
        total = 0
        for line in (user or "").splitlines():
            if "**要寫進聲明**" not in line:
                continue
            for key, name in _FEATURE_NAMES.items():
                if key in _MUST_DISCLOSE and name.split("（")[0] in line:
                    used.append(name.split("（")[0])
                    # 行的格式是「· **要寫進聲明**　撰寫回饋（…）：3 次」。
                    # 取最後一組數字：類別名稱裡也可能有數字（現在沒有，
                    # 但「113 年」這種字樣以後很容易被加進去）。
                    hits = re.findall(r"(\d+)\s*次", line)
                    if hits:
                        total += int(hits[-1])
        if not used:
            return "本文之構思與撰寫均由本人完成，過程中未使用 AI 輔助工具，亦未使用 AI 生成內容。"
        return (
            "本文之構思與撰寫由本人完成，過程中使用 AI 輔助工具進行"
            + "、".join(used)
            + f"，共 {total} 次，未使用 AI 生成內容。"
        )

    return (
        "你這一段裡有幾個地方只講了感受，沒有講發生了什麼事。"
        "哪一次的經驗最接近你想表達的那個轉折？"
        "如果只能留一件成果，你會留哪一件，為什麼？"
        "（AI_PROVIDER=mock 產生的假回應，僅供安裝驗證）"
    )
