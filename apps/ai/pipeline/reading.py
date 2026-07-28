"""
整頁閱讀：把辨識與抽取交給模型。

# 為什麼換掉規則

原本的流程是「規則切分版面 → 模型結構化內容」，而規則那一段在
原生 PDF 上是零成本的。問題不在準確率，在**維護的形狀**：

    每加一種體例就要打一批新規則，而新規則會打壞舊的。

實例：加英文與社會的作答括號支援（`(  ) 6. It was on…`）之後，
`(A) 4.5 公尺` 這種以小數開頭的選項被判成「題號 (A) 4.」，於是
那一題少一個選項，而括號裡的「A」被當成教用版印出的答案——
**一份完全沒印答案的學生版講義，會產出標準答案然後拿去改全班的
卷子。** 五個科目、四家出版社、教用版與學生版，那是打不完的組合。

模型讀整頁不會有這個問題：它看到的是人看到的東西。

# 但規則沒有被刪掉

規則路徑照跑，只是改當**交叉驗證**。兩邊不一致的題目自動標成存疑，
校對者優先看那幾題。規則是純程式，多跑一次的成本是零，換到的是
「模型抽錯時有人會發現」。

沒有 AI 可用（金鑰沒設、超出預算、上游故障）時，規則路徑就是
降級路徑——匯入仍然做得完，只是品質說明會講明它是怎麼來的。

# 一個順帶的好處

`glyphmap.py` 存在的理由是出版社的自製符號字型：文字層裡的
`（1）` 其實是 ASCII 的 `1`。那是**文字層在說謊**，而渲染出來的
影像沒有這個問題——模型看到的圓圈裡的 1 就是 ①。文字層仍然有用
（字元沒有辨識誤差），但只當比對用，衝突時以影像為準。
"""

from __future__ import annotations

import logging

from providers import BaseProvider

from .prompts import READ_SYSTEM, read_user
from .canonical import ASSET_REF, PageReading, Question
from .schemas import BlockType

log = logging.getLogger("yunzhi.ai.reading")

#: 送進模型的影像長邊上限。
#:
#: 上游協定本來就會把超過 1568 px 的影像縮下來，送更大的只是浪費
#: 頻寬與時間。實測 A4 頁面在這個尺寸下約 3,100 個影像 token，
#: 而 300 dpi 原圖是 12,400——四倍的價差，辨識品質沒有相應的差別
#: （印刷字在 150 dpi 已經很清楚）。
#:
#: 頁面影像仍然以 300 dpi 保存，因為附圖是從那一份裁的。
_LONG_EDGE = 1568

#: 文字層提示的長度上限。整頁抄進去通常一兩千字，超過這個長度
#: 多半是抓到了整份文件而不是單頁，那時候寧可不給。
_TEXT_HINT_MAX = 6000


def prepare_image(png: bytes, long_edge: int = _LONG_EDGE) -> bytes:
    """把頁面影像縮到模型讀得夠、又不浪費 token 的尺寸。"""
    try:
        import cv2
        import numpy as np
    except ImportError:  # pragma: no cover - 部署環境一定有
        return png

    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return png
    h, w = img.shape[:2]
    scale = long_edge / max(h, w)
    if scale >= 1.0:
        return png
    resized = cv2.resize(
        img, (max(1, int(w * scale)), max(1, int(h * scale))),
        interpolation=cv2.INTER_AREA,
    )
    # JPEG 而不是 PNG：文字頁面在 q=88 下看不出差別，位元組數少一半以上，
    # 而上游是按**像素**計費不是按位元組，所以省的是傳輸時間。
    ok, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return buf.tobytes() if ok else png


def text_hint(text_blocks: list[dict] | None) -> str:
    """
    把原生 PDF 的文字層整理成給模型比對用的提示。

    只有原生 PDF 有。它的字元沒有辨識誤差，但**可能被自製符號字型
    污染**，而且沒有可靠的閱讀順序——所以提示詞裡明講「衝突時以
    影像為準」。
    """
    if not text_blocks:
        return ""
    lines = [b.get("text", "").strip() for b in text_blocks]
    joined = "\n".join(ln for ln in lines if ln)
    if len(joined) > _TEXT_HINT_MAX:
        joined = joined[:_TEXT_HINT_MAX] + "\n…（過長，已截斷）"
    return joined


async def read_page(
    provider: BaseProvider,
    *,
    page_index: int,
    image: bytes,
    next_image: bytes | None = None,
    text_blocks: list[dict] | None = None,
    tier: str = "MID",
) -> tuple[PageReading, dict]:
    """
    讀一頁，回傳 (結果, 用量)。

    一次送**連續兩頁**（第二頁只是上下文），讓模型看得到跨頁的接續：
    「這一題的選項在哪裡」在只給一頁時是無解的。提示詞要求只輸出
    本頁開始的題目——次頁自己也會被讀一次，兩邊都輸出的話同一題
    會進題庫兩次。
    """
    from .stages import _structured  # 延後匯入，避免循環相依

    images = [prepare_image(image)]
    note = f"這是第 {page_index} 頁"
    if next_image is not None:
        images.append(prepare_image(next_image))
        note = f"第一張是第 {page_index} 頁，第二張是第 {page_index + 1} 頁（僅供判斷接續）"

    result, completion = await _structured(
        provider,
        model_cls=PageReading,
        system=READ_SYSTEM,
        user=read_user(note, text_hint(text_blocks)),
        tier=tier,
        max_tokens=16384,
        images=images,
    )
    u = getattr(completion, "usage", None)
    usage = {
        "input_tokens": getattr(u, "input_tokens", 0),
        "output_tokens": getattr(u, "output_tokens", 0),
        "estimated": getattr(u, "estimated", False),
    }

    # 模型看到兩頁，回報的 page 可能是 1 或 2。換算回真實頁碼，
    # 然後**只留本頁**——次頁的內容由它自己那一次呼叫負責。兩邊都留
    # 的話，第 2 頁起每一頁的內容都會進題庫兩次。
    def fix(items: list) -> list:
        out = []
        for it in items:
            pl = it.placement
            pl.page = page_index if pl.page <= 1 else page_index + (pl.page - 1)
            if pl.bbox:
                pl.bbox.page = pl.page
            if pl.page == page_index:
                out.append(it)
        return out

    result.assets = fix(result.assets)
    result.sections = fix(result.sections)
    result.groups = fix(result.groups)
    result.questions = fix(result.questions)
    result.materials = fix(result.materials)
    for i in result.issues:
        if i.page is None or i.page <= 1:
            i.page = page_index
        elif i.page == 2:
            i.page = page_index + 1

    return result, usage


# ─────────────────────────────────────────────────────────────────
# 交叉驗證
#
# 規則路徑照跑，但不再負責抽取，改成**第二個意見**。
# 兩邊不一致的題目自動標成存疑，讓校對者優先看那幾題。
#
# 這一段刻意不做「誰對誰錯」的裁決——它做不到，也不該做。
# 它只負責指出「這裡兩個方法看法不同」，然後交給人。
# ─────────────────────────────────────────────────────────────────


def _norm(text: str) -> str:
    """比對用的正規化：拿掉空白與全半形差異，只留下實質內容。"""
    import re
    import unicodedata

    t = unicodedata.normalize("NFKC", text or "")
    t = re.sub(r"\s+", "", t)
    # 數學區間的分隔符與 LaTeX 命令不參與比對——兩邊的重建方式
    # 本來就不同，比那個只會製造假警報。
    t = re.sub(r"\$[^$]*\$", "§", t)
    t = re.sub(r"[，。、；：？！,.;:?!（）()「」\[\]【】]", "", t)
    return t


def _similar(a: str, b: str) -> float:
    from difflib import SequenceMatcher

    na, nb = _norm(a), _norm(b)
    if not na and not nb:
        return 1.0
    if not na or not nb:
        return 0.0
    return SequenceMatcher(None, na, nb).ratio()


#: 題幹相似度低於這個值就算「兩邊看到的不是同一題」。
#: 訂得寬鬆：規則路徑保留原始標點與版面殘留，模型會清理掉，
#: 兩者本來就不會逐字相同。要抓的是「整段內容不一樣」。
_STEM_MATCH = 0.62


def cross_check(
    model_questions: list[Question],
    rule_blocks: list,
) -> list[dict]:
    """
    比對模型的抽取與規則路徑的切分，回傳不一致的清單。

    回傳的每一項會變成候選題上的 `confidenceReasons`，校對介面
    據此把該題排到前面。

    比對三件事，都是「錯了會讓學生成績錯」的那一類：

      題數    規則切出 40 題而模型讀出 32 題 → 有 8 題被誰漏掉了
      題幹    兩邊對同一題的內容差太多 → 至少有一邊切錯了邊界
      答案    兩邊都讀到印出來的答案卻不一樣 → 一定有一邊是錯的
    """
    issues: list[dict] = []

    rule_stems = [
        b.text for b in rule_blocks
        if getattr(b, "type", None) in (BlockType.QUESTION_NO, BlockType.STEM)
        and (b.text or "").strip()
    ]
    rule_answers = [
        a for b in rule_blocks for a in (getattr(b, "answers", None) or [])
    ]

    # ── 題數 ────────────────────────────────────────────────────
    n_model, n_rule = len(model_questions), len(rule_stems)
    if n_rule and abs(n_model - n_rule) > max(2, n_rule * 0.25):
        issues.append({
            "scope": "job",
            "code": "count_mismatch",
            "severity": "warn",
            "detail": (
                f"模型讀出 {n_model} 題，規則切出 {n_rule} 題。"
                f"差距超過四分之一，代表至少有一邊漏了整段——"
                f"請先確認頁數與題號是否連續。"
            ),
        })

    # ── 逐題題幹 ────────────────────────────────────────────────
    unmatched: list[str] = []
    pool = list(rule_stems)
    for q in model_questions:
        best, best_i = 0.0, -1
        for i, s in enumerate(pool):
            r = _similar(q.stem, s)
            if r > best:
                best, best_i = r, i
        if best >= _STEM_MATCH:
            pool.pop(best_i)
        else:
            unmatched.append(q.number or q.label or q.stem[:20])

    if unmatched and rule_stems:
        issues.append({
            "scope": "job",
            "code": "stem_mismatch",
            "severity": "warn",
            "detail": (
                f"這 {len(unmatched)} 題在規則路徑裡找不到對應的內容："
                f"{'、'.join(unmatched[:8])}"
                f"{'…' if len(unmatched) > 8 else ''}。"
                f"可能是模型讀錯，也可能是規則沒認出這種體例——"
                f"請對照原稿確認題幹的起訖。"
            ),
        })

    # ── 印出來的答案 ────────────────────────────────────────────
    #
    # 這一項最要緊。規則路徑抓答案靠顏色與版面（零推論），模型靠
    # 閱讀。兩邊都抓到卻不一樣，一定有一邊錯，而錯的那一邊會讓
    # 一整班的成績是錯的。
    from .canonical import AnswerSource

    model_has_answer = sum(
        1 for q in model_questions if q.answer.source is AnswerSource.PRINTED
    )
    if rule_answers and not model_has_answer:
        issues.append({
            "scope": "job",
            "code": "answers_missing",
            "severity": "error",
            "detail": (
                f"規則路徑在原稿上找到 {len(rule_answers)} 處印出來的答案，"
                f"模型一個都沒讀到。這份多半是教用版而模型當成了學生版——"
                f"**入庫前務必確認答案**，否則整批題目會沒有標準答案。"
            ),
        })
    elif model_has_answer and rule_answers and not _answers_overlap(
        model_questions, rule_answers
    ):
        issues.append({
            "scope": "job",
            "code": "answers_disagree",
            "severity": "error",
            "detail": (
                "模型讀到的答案與規則從版面顏色抓到的答案完全對不上。"
                "顏色是排版時就決定好的事實，兩者衝突時請以原稿為準逐題確認。"
            ),
        })

    return issues


def _answers_overlap(model_questions: list[Question], rule_answers: list[str]) -> bool:
    """兩邊的答案集合有沒有交集。完全沒有交集才算「對不上」。"""
    pool = {_norm(a) for a in rule_answers if a}
    if not pool:
        return True
    for q in model_questions:
        for k in q.answer.keys:
            label = q.options[k - 1].label if 0 < k <= len(q.options) else str(k)
            if any(_norm(label) in a or a in _norm(label) for a in pool if a):
                return True
        if q.answer.text and _norm(q.answer.text) in pool:
            return True
        for slot in q.answer.slots:
            if _norm(slot.value) in pool:
                return True
    return False
