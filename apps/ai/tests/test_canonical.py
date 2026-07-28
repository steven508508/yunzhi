"""
標準題目交換格式（QIF v1）。

每個老師丟進來的東西都不一樣：翰林的數學教用版、南一的英文學生版、
自己出的段考卷、手機拍的一頁社會講義。這個格式是**所有那些東西被
理解之後的共同終點**——下游只認這個形狀，永遠不必知道原稿是哪一家
出版社的。

這一支測三件事，依重要性排：

  一、**格式吃不下的東西不准被硬塞。** 音樂科的五線譜、化學的結構
      式、某家出版社獨有的題型一定會出現。硬塞的代價不是資料難看，
      是沒有人會發現。
  二、**事實與推論分開。** 答案只收原稿印的，推導的走另一條路。
  三、跨物件的完整性：參照解得開、id 不重複、統計對得上。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pydantic  # noqa: E402

from pipeline.canonical import (  # noqa: E402
    Answer,
    AnswerSlot,
    AnswerSource,
    Asset,
    AssetKind,
    Confidence,
    ConfidenceReason,
    DocumentMeta,
    Edition,
    Explanation,
    Genre,
    Group,
    GroupKind,
    ImportDocument,
    Issue,
    Material,
    Option,
    PageReading,
    Placement,
    Provenance,
    Question,
    QuestionKind,
    SCHEMA_VERSION,
    Section,
    Severity,
    SubjectCode,
    assemble,
    finalize,
    json_schema,
)
from pipeline.schemas import BBox  # noqa: E402


def box(page=1, y0=0.1):
    return BBox(page=page, x0=0.08, y0=y0, x1=0.92, y1=y0 + 0.1)


def q(qid="q1", kind=QuestionKind.SINGLE_CHOICE, n=3, **kw):
    kw.setdefault("stem", "下列敘述何者正確？")
    kw.setdefault("placement", Placement(page=1, bbox=box()))
    kw.setdefault("confidence", Confidence(score=0.9))
    if kind in {QuestionKind.SINGLE_CHOICE, QuestionKind.MULTI_CHOICE} and "options" not in kw:
        kw["options"] = [
            Option(order=i + 1, label=f"({i + 1})", content=f"選項{i + 1}")
            for i in range(n)
        ]
    return Question(id=qid, kind=kind, **kw)


# ─────────────────────────────────────────────────────────────────
# 一、吃不下的東西不准硬塞
# ─────────────────────────────────────────────────────────────────


def test_unsupported_content_must_keep_the_original():
    """
    **這一條是整個格式的安全閥。**

    只說「有東西讀不懂」而不留下那是什麼，等於把它丟掉——而丟掉
    這件事本身也沒有人會發現。
    """
    try:
        Issue(code="unsupported_content", detail="這一區看不懂是什麼")
        raise AssertionError("沒有留下原文卻通過了驗證")
    except pydantic.ValidationError as e:
        assert "保留原文" in str(e)

    ok = Issue(code="unsupported_content", detail="第 5 題是一段五線譜，格式吃不下",
               raw="（五線譜影像）", page=5)
    assert ok.raw


def test_other_kind_requires_an_explanation():
    """
    `OTHER` 是逃生口。用了卻不說明它是什麼，等於在題庫裡放了一顆
    沒有標籤的東西——半年後沒有人知道那一題是怎麼回事。
    """
    doc = ImportDocument(questions=[q("q1", QuestionKind.OTHER)])
    doc = finalize(doc)
    codes = [i.code for i in doc.issues]
    assert "other_without_issue" in codes, codes
    assert any(i.severity is Severity.ERROR for i in doc.issues)


def test_other_kind_with_an_explanation_is_accepted():
    doc = ImportDocument(
        questions=[q("q1", QuestionKind.OTHER)],
        issues=[Issue(code="unsupported_content", question_id="q1",
                      detail="這是一題音樂科的旋律聽寫，格式吃不下",
                      raw="（五線譜）")],
    )
    doc = finalize(doc)
    assert "other_without_issue" not in [i.code for i in doc.issues]
    assert doc.stats.unsupported == 1


def test_unsupported_shows_up_in_the_stats():
    """校對介面第一眼要看得到「這一份有幾個東西沒吃進來」。"""
    doc = finalize(ImportDocument(issues=[
        Issue(code="unsupported_content", detail="第 3 頁有一張心智圖，格式吃不下", raw="（心智圖）"),
        Issue(code="unsupported_content", detail="第 7 題是化學結構式，格式吃不下", raw="（結構式）"),
    ]))
    assert doc.stats.unsupported == 2


# ─────────────────────────────────────────────────────────────────
# 二、事實與推論分開
# ─────────────────────────────────────────────────────────────────


def test_no_answer_means_no_answer():
    """
    `source=NONE` 卻帶著答案，就是把推導出來的東西混進了「原稿印的」。
    混在一起之後，半年後沒有人分得出哪個是題本印的、哪個是系統猜的，
    而那兩者的可信度差了一個量級。
    """
    try:
        Answer(source=AnswerSource.NONE, keys=[2])
        raise AssertionError("NONE 帶著答案卻通過了驗證")
    except pydantic.ValidationError as e:
        assert "不進這個格式" in str(e)


def test_printed_must_actually_have_something():
    try:
        Answer(source=AnswerSource.PRINTED)
        raise AssertionError("PRINTED 沒有內容卻通過了")
    except pydantic.ValidationError:
        pass


def test_answer_outside_the_options_is_rejected():
    """
    答案指向不存在的選項是最危險的一種錯：題目看起來完全正常，
    只是每個答對的學生都會被判錯。
    """
    try:
        q(answer=Answer(source=AnswerSource.PRINTED, keys=[7]), n=3)
        raise AssertionError("超出範圍的答案通過了")
    except pydantic.ValidationError as e:
        assert "超出選項範圍" in str(e)


def test_single_choice_cannot_have_two_answers():
    try:
        q(kind=QuestionKind.SINGLE_CHOICE,
          answer=Answer(source=AnswerSource.PRINTED, keys=[1, 2]))
        raise AssertionError("單選題有兩個答案卻通過了")
    except pydantic.ValidationError as e:
        assert "單選題" in str(e)


def test_slots_must_exist_in_the_stem():
    """學測選填的答案要填進題幹標示的格位。填到沒有的格位是抽錯了。"""
    try:
        Question(
            id="q1", kind=QuestionKind.FILL_SLOT,
            stem="求 x 的值，填入 {{slot:⑬}}",
            answer=Answer(source=AnswerSource.PRINTED,
                          slots=[AnswerSlot(slot="⑭", value="3")]),
            placement=Placement(page=1), confidence=Confidence(score=0.9),
        )
        raise AssertionError("答案填在不存在的格位卻通過了")
    except pydantic.ValidationError as e:
        assert "沒有標示的格位" in str(e)


# ─────────────────────────────────────────────────────────────────
# 三、涵蓋五科
# ─────────────────────────────────────────────────────────────────


def test_covers_every_subject_shape():
    """
    五科各挑一種最不像的題型，確認格式吃得下而且不必變形。
    這一條是「標準化格式」這個承諾的實際內容。
    """
    doc = ImportDocument(
        document=DocumentMeta(subject=SubjectCode.SOCIAL, genre=Genre.WORKSHEET,
                              edition=Edition.TEACHER, language="mixed"),
        assets=[
            Asset(id="tbl", kind=AssetKind.TABLE, placement=Placement(page=1, bbox=box()),
                  alt="西班牙流感各都市死亡人數", table_markdown="| 都市 | 死亡人數 |\n|---|---|\n| 費城 | 7024 |"),
            Asset(id="vid", kind=AssetKind.VIDEO_LINK, placement=Placement(page=1, bbox=box()),
                  alt="解題影音", url="https://example.invalid/v/1"),
        ],
        groups=[Group(id="g1", kind=GroupKind.PASSAGE, lead="請問 9～10 題",
                      stimulus="下列為一段文言文選段…", placement=Placement(page=1, bbox=box()))],
        questions=[
            # 國文：排序
            q("q1", QuestionKind.ORDERING, group_id="g1", n=4),
            # 英文：中譯英
            Question(id="q2", kind=QuestionKind.TRANSLATION,
                     stem="請將下列中文譯成英文：他昨天去了圖書館。",
                     answer=Answer(source=AnswerSource.PRINTED,
                                   text="He went to the library yesterday."),
                     placement=Placement(page=1, bbox=box()), confidence=Confidence(score=0.9)),
            # 數學：選填格位
            Question(id="q3", kind=QuestionKind.FILL_SLOT,
                     stem="求 $k$ 的值，填入 {{slot:⑬}}{{slot:⑭}}",
                     answer=Answer(source=AnswerSource.PRINTED,
                                   slots=[AnswerSlot(slot="⑬", value="1"),
                                          AnswerSlot(slot="⑭", value="3")]),
                     placement=Placement(page=1, bbox=box()), confidence=Confidence(score=0.9)),
            # 社會：作答格 ＋ 引用表格
            Question(id="q4", kind=QuestionKind.MATCHING,
                     stem="依下表判斷各都市的疫情等級 ![[a:tbl]]",
                     asset_ids=["tbl"],
                     placement=Placement(page=1, bbox=box()), confidence=Confidence(score=0.8)),
            # 自然：要寫過程的計算
            Question(id="q5", kind=QuestionKind.CALCULATION,
                     stem="試求該反應的平衡常數，並寫出推導過程。",
                     placement=Placement(page=1, bbox=box()), confidence=Confidence(score=0.9)),
        ],
        materials=[Material(id="m1", title="使用時機", body="that／this 用於較近的人或物",
                            placement=Placement(page=1, bbox=box()))],
    )
    doc = finalize(doc)
    errors = [i for i in doc.issues if i.severity is Severity.ERROR]
    assert not errors, [i.detail for i in errors]
    assert doc.stats.questions == 5
    assert doc.stats.groups == 1
    assert doc.stats.materials == 1


# ─────────────────────────────────────────────────────────────────
# 四、跨物件的完整性
# ─────────────────────────────────────────────────────────────────


def test_dangling_references_are_caught():
    doc = finalize(ImportDocument(questions=[
        q("q1", group_id="nope", asset_ids=["missing"]),
    ]))
    codes = [i.code for i in doc.issues]
    assert "dangling_group" in codes and "dangling_asset" in codes, codes


def test_asset_referenced_in_text_must_be_listed():
    """
    `asset_ids` 與內文的 `![[a:id]]` 冗餘是刻意的（下游要查「哪些
    題目用到這張圖」）。冗餘就會不同步，而不同步的症狀是「刪掉
    一張圖之後有幾題出現破圖，卻查不到是哪幾題」。
    """
    doc = finalize(ImportDocument(
        assets=[Asset(id="f1", kind=AssetKind.FIGURE, placement=Placement(page=1), alt="圖")],
        questions=[q("q1", stem="如圖 ![[a:f1]]")],   # 沒有列進 asset_ids
    ))
    assert "asset_not_listed" in [i.code for i in doc.issues]


def test_unbalanced_math_delimiter_is_caught():
    """落單的 $ 會讓後面整段被當成數學式，KaTeX 排出亂碼卻不報錯。"""
    doc = finalize(ImportDocument(questions=[q("q1", stem="求 $x 的值")]))
    assert "content_markup" in [i.code for i in doc.issues]


def test_orphan_group_is_caught():
    """共用素材抽出來了但題目沒接上，學生會看到一段沒有問題的文章。"""
    doc = finalize(ImportDocument(groups=[
        Group(id="g1", stimulus="一段閱讀素材", placement=Placement(page=1)),
    ]))
    assert "orphan_group" in [i.code for i in doc.issues]


def test_duplicate_ids_are_caught():
    doc = finalize(ImportDocument(questions=[q("q1"), q("q1")]))
    assert "duplicate_id" in [i.code for i in doc.issues]


def test_stats_are_computed_not_trusted():
    """統計由程式算。模型算數字會算錯，而且沒必要讓它算。"""
    doc = ImportDocument(
        questions=[
            q("q1", answer=Answer(source=AnswerSource.PRINTED, keys=[1])),
            q("q2", explanation=Explanation(body="因為…")),
        ],
        stats={"questions": 999},  # 亂填的
    )
    doc = finalize(doc)
    assert doc.stats.questions == 2
    assert doc.stats.with_printed_answer == 1
    assert doc.stats.with_explanation == 1


# ─────────────────────────────────────────────────────────────────
# 五、逐頁組裝
# ─────────────────────────────────────────────────────────────────


def test_ids_do_not_collide_across_pages():
    """
    模型是逐頁呼叫的，它不知道別頁用過什麼 id，於是每一頁都會吐出
    `q1`。不加前綴的話第 2 頁會覆蓋第 1 頁——症狀是「匯入 30 頁
    只出來 4 題」。
    """
    pages = [
        (i, PageReading(questions=[
            Question(id="q1", kind=QuestionKind.SHORT_ANSWER, stem=f"第 {i} 頁的題目",
                     placement=Placement(page=i, bbox=box(page=i)),
                     confidence=Confidence(score=0.9))
        ]))
        for i in (1, 2, 3)
    ]
    doc = assemble(pages)
    assert len({q_.id for q_ in doc.questions}) == 3
    assert doc.stats.questions == 3


def test_asset_references_are_remapped_on_assembly():
    """id 加前綴之後，內文裡的 `![[a:舊id]]` 也要跟著換。"""
    pages = [
        (i, PageReading(
            assets=[Asset(id="f1", kind=AssetKind.FIGURE,
                          placement=Placement(page=i, bbox=box(page=i)), alt="圖")],
            questions=[Question(id="q1", kind=QuestionKind.SHORT_ANSWER,
                                stem=f"第 {i} 頁 ![[a:f1]]", asset_ids=["f1"],
                                placement=Placement(page=i, bbox=box(page=i)),
                                confidence=Confidence(score=0.9))],
        ))
        for i in (1, 2)
    ]
    doc = assemble(pages)
    assert not [i for i in doc.issues if i.code.startswith("dangling")], doc.issues
    for q_ in doc.questions:
        assert q_.asset_ids[0] in q_.stem, (q_.asset_ids, q_.stem)


def test_document_meta_takes_the_majority():
    """
    一份檔案前半是講義後半是試卷時，整份的體例取多數決；
    章節取眾數——它印在每一頁的頁首，眾數就是整份的章節。
    """
    pages = [
        (1, PageReading(subject=SubjectCode.MATH_A, genre=Genre.WORKSHEET)),
        (2, PageReading(subject=SubjectCode.MATH_A, genre=Genre.WORKSHEET)),
        (3, PageReading(subject=SubjectCode.MATH_A, genre=Genre.EXAM)),
    ]
    doc = assemble(pages)
    assert doc.document.subject is SubjectCode.MATH_A
    assert doc.document.genre is Genre.WORKSHEET


def test_questions_are_sorted_by_position():
    """
    順序要與原稿一致。老師是對著紙本校對的，順序不一樣會讓每一題
    都要重新找。
    """
    pages = [
        (2, PageReading(questions=[
            Question(id="a", kind=QuestionKind.SHORT_ANSWER, stem="第二頁",
                     placement=Placement(page=2, bbox=box(page=2, y0=0.1)),
                     confidence=Confidence(score=0.9))])),
        (1, PageReading(questions=[
            Question(id="b", kind=QuestionKind.SHORT_ANSWER, stem="第一頁下方",
                     placement=Placement(page=1, bbox=box(page=1, y0=0.7)),
                     confidence=Confidence(score=0.9)),
            Question(id="c", kind=QuestionKind.SHORT_ANSWER, stem="第一頁上方",
                     placement=Placement(page=1, bbox=box(page=1, y0=0.1)),
                     confidence=Confidence(score=0.9))])),
    ]
    doc = assemble(pages)
    assert [q_.stem for q_ in doc.questions] == ["第一頁上方", "第一頁下方", "第二頁"]


# ─────────────────────────────────────────────────────────────────
# 六、格式本身
# ─────────────────────────────────────────────────────────────────


def test_schema_version_is_stamped():
    doc = finalize(ImportDocument())
    assert doc.schema_version == SCHEMA_VERSION


def test_json_schema_is_exportable():
    """
    這是「交換格式」名副其實的地方：日後要把題庫轉出去給別的系統，
    靠的是這一份而不是讀我們的原始碼。
    """
    s = json_schema()
    assert s["$schema"].startswith("https://json-schema.org/")
    assert SCHEMA_VERSION in s["$id"]
    assert "questions" in s["properties"]
    json.dumps(s)  # 必須可序列化


def test_document_round_trips_through_json():
    """存進資料庫再讀出來要是同一份東西。"""
    doc = finalize(ImportDocument(
        document=DocumentMeta(subject=SubjectCode.ENGLISH),
        questions=[q("q1", provenance=Provenance(exam="112學測", national_correct_rate=0.43),
                     confidence=Confidence(score=0.8, reasons=[
                         ConfidenceReason(code="blurry", detail="選項 (3) 的字跡黏連")]))],
    ))
    again = ImportDocument.model_validate(json.loads(doc.model_dump_json()))
    assert again.questions[0].provenance.national_correct_rate == 0.43
    assert again.questions[0].confidence.reasons[0].code == "blurry"
    assert again.stats.questions == 1


# ─────────────────────────────────────────────────────────────────
# 七、自然科：物理、化學、生物
# ─────────────────────────────────────────────────────────────────


def test_chemistry_notation_is_accepted():
    r"""
    化學式用 mhchem 的 `\ce{}`。自己拼 LaTeX 下標排出來字級與間距
    都不對，電荷、狀態、可逆箭頭更是拼不好，而且搜尋不到——
    `\ce{H2SO4}` 是穩定的字串，`H_2SO_4` 有五種寫法。
    """
    doc = finalize(ImportDocument(
        document=DocumentMeta(subject=SubjectCode.CHEMISTRY),
        questions=[q("q1", QuestionKind.CALCULATION,
                     stem=r"下列反應 $\ce{2H2 + O2 -> 2H2O}$ 中，求限量試劑。",
                     options=[])],
    ))
    assert not [i for i in doc.issues if i.code == "content_markup"], doc.issues


def test_unbalanced_chem_braces_are_caught():
    """
    少一個右括號，mhchem 會把後面整段話都當成化學式排版——
    排出來是一團看不懂的東西，而且不會報錯。
    """
    doc = finalize(ImportDocument(questions=[
        q("q1", QuestionKind.CALCULATION, options=[],
          stem=r"反應式 $\ce{2H2 + O2 -> 2H2O$，求生成物質量。"),
    ]))
    codes = [i.detail for i in doc.issues if i.code == "content_markup"]
    assert any("大括號" in c for c in codes), doc.issues


def test_science_subjects_map_to_the_combined_paper():
    """
    學測的自然與社會是合科考卷，但補習班分科教。分科要能對回合科，
    否則組一份學測模擬卷時湊不起來。
    """
    from pipeline.canonical import PARENT_SUBJECT

    assert PARENT_SUBJECT[SubjectCode.CHEMISTRY] is SubjectCode.SCIENCE
    assert PARENT_SUBJECT[SubjectCode.BIOLOGY] is SubjectCode.SCIENCE
    assert PARENT_SUBJECT[SubjectCode.GEOGRAPHY] is SubjectCode.SOCIAL
    # 合科自己不是任何科的子科
    assert SubjectCode.SCIENCE not in PARENT_SUBJECT


def test_significant_figures_and_units_are_kept():
    """
    「答案取三位有效數字」是理化的常見要求。自動改考卷時
    2.00 與 2 是不是同一個答案，取決於系統記不記得這件事。
    """
    from pipeline.canonical import Scoring

    got = q("q1", QuestionKind.CALCULATION, options=[],
            scoring=Scoring(score=4, unit="mol/L", sig_figs=3))
    assert got.scoring.unit == "mol/L"
    assert got.scoring.sig_figs == 3


def test_biology_diagram_is_a_figure_with_alt_text():
    """
    遺傳圖譜、細胞構造圖、實驗裝置圖都是圖，不要用文字描述形狀。
    替代文字要寫成完整的句子——視障學生看到的就是它。
    """
    doc = finalize(ImportDocument(
        document=DocumentMeta(subject=SubjectCode.BIOLOGY),
        assets=[Asset(id="ped", kind=AssetKind.FIGURE,
                      placement=Placement(page=1, bbox=box()),
                      alt="三代家系圖，第二代第 3 位為患者，第三代有兩位帶因者")],
        questions=[q("q1", QuestionKind.SHORT_ANSWER, options=[],
                     stem="依 ![[a:ped]] 判斷此性狀的遺傳方式。",
                     asset_ids=["ped"])],
    ))
    assert not [i for i in doc.issues if i.severity is Severity.ERROR], doc.issues
    assert doc.stats.with_assets == 1


# ── 物理：向量、單位、圖 ──────────────────────────────────────────
#
# 物理的三個要害，依「錯了會不會被發現」排序：
#
#   一、**向量的箭頭**。掉了就是另一個物理量，而題目讀起來完全通順。
#   二、**圖**。物理的圖就是題目本身，漏了那一題是零分。
#   三、**單位**。同一個單位有五種寫法，逐字比對會把對的判成錯的。


def test_vector_arrows_survive():
    r"""
    $v$ 是速率、$\vec{v}$ 是速度。箭頭是頁面上最細的一筆，
    翻拍與壓縮最容易把它抹掉，而物理大量在這個區別上出題。
    """
    doc = finalize(ImportDocument(
        document=DocumentMeta(subject=SubjectCode.PHYSICS),
        questions=[q("q1", QuestionKind.SINGLE_CHOICE, options=[
            Option(order=1, label="(1)", content=r"$\vec{v}_1 + \vec{v}_2$"),
            Option(order=2, label="(2)", content=r"$\vec{v}_1 - \vec{v}_2$"),
            Option(order=3, label="(3)", content=r"$|\vec{v}_1| + |\vec{v}_2|$"),
        ], stem=r"兩速度 $\vec{v}_1$ 與 $\vec{v}_2$ 的合成為何？")],
    ))
    assert not [i for i in doc.issues if i.code == "content_markup"], doc.issues


def test_unbalanced_vector_braces_are_caught():
    r"""少一個右括號，KaTeX 整段排不出來——畫面上是一行紅字而不是題目。"""
    doc = finalize(ImportDocument(questions=[
        q("q1", QuestionKind.CALCULATION, options=[],
          stem=r"求 $\vec{F$ 的量值。"),
    ]))
    assert any("大括號" in i.detail for i in doc.issues if i.code == "content_markup"), doc.issues


def test_options_that_became_identical_are_caught():
    r"""
    **這一支是整個物理支援的核心。**

    一題問「下列何者為合力」，四個選項本來是 $\vec{a}$、$\vec{b}$、
    $a$、$b$。翻拍把箭頭抹掉之後，選項 (1) 與 (3) 都變成 $a$。

    題目看起來完全正常：選項數量對、答案是合法的序號、校對者一眼
    掃過去不會停。但這一題已經沒有唯一解，而每一個選到「另一個
    一樣的」的學生都被判錯——**沒有任何跡象**。

    箭頭掉了我們攔不住（那要看原圖）。選項變得無法區分我們攔得住。
    """
    doc = finalize(ImportDocument(
        document=DocumentMeta(subject=SubjectCode.PHYSICS),
        questions=[q("q1", QuestionKind.SINGLE_CHOICE, options=[
            Option(order=1, label="(1)", content="$a$"),
            Option(order=2, label="(2)", content="$b$"),
            Option(order=3, label="(3)", content="$a$"),
        ], answer=Answer(source=AnswerSource.PRINTED, keys=[1]))],
    ))
    bad = [i for i in doc.issues if i.code == "duplicate_options"]
    assert bad, doc.issues
    assert bad[0].severity is Severity.ERROR
    assert "(1)" in bad[0].detail and "(3)" in bad[0].detail


def test_empty_option_is_an_error():
    """抽不到選項內容的題目不能拿去考學生。"""
    doc = finalize(ImportDocument(questions=[
        q("q1", QuestionKind.SINGLE_CHOICE, options=[
            Option(order=1, label="(1)", content="甲"),
            Option(order=2, label="(2)", content="   "),
        ]),
    ]))
    assert [i for i in doc.issues
            if i.code == "empty_option" and i.severity is Severity.ERROR], doc.issues


def test_a_question_that_says_see_the_figure_must_have_one():
    """
    「由 v–t 圖求 0 到 4 秒的位移」少了圖，學生看到的是一句「如圖」
    與一片空白，連猜都無從猜起。其他科漏一張圖多半還能作答，
    物理漏一張圖是零分。
    """
    doc = finalize(ImportDocument(
        document=DocumentMeta(subject=SubjectCode.PHYSICS),
        questions=[q("q1", QuestionKind.CALCULATION, options=[],
                     stem="由右圖之 v–t 圖，求物體在 0 到 4 秒內的位移。")],
    ))
    bad = [i for i in doc.issues if i.code == "figure_missing"]
    assert bad and bad[0].severity is Severity.ERROR, doc.issues


def test_a_figure_on_the_group_counts_for_its_children():
    """
    實驗題組的圖掛在題組上，子題的 asset_ids 是空的。
    不算進來的話，每一組實驗題的每一題都會被誤報成「圖不見了」——
    而誤報吃掉的是校對時間，那是這個系統最稀缺的資源。
    """
    doc = finalize(ImportDocument(
        assets=[Asset(id="cir", kind=AssetKind.FIGURE,
                      placement=Placement(page=1, bbox=box()),
                      alt="兩個電阻並聯後與電池串聯的電路圖")],
        groups=[Group(id="g1", kind=GroupKind.EXPERIMENT,
                      stimulus="電路如 ![[a:cir]] 所示。",
                      placement=Placement(page=1, bbox=box()))],
        questions=[q("q1", QuestionKind.CALCULATION, options=[], group_id="g1",
                     stem="依上圖求通過 R₂ 的電流。")],
    ))
    assert not [i for i in doc.issues if i.code == "figure_missing"], doc.issues


def test_an_inline_table_is_not_a_missing_figure():
    """題幹裡直接排了表格，就不算「引用了一張看不到的表」。"""
    doc = finalize(ImportDocument(questions=[
        q("q1", QuestionKind.SINGLE_CHOICE,
          stem="下表為四次測量結果：\n\n| 次數 | 時間(s) |\n| --- | --- |\n| 1 | 2.0 |\n\n由表中資料判斷。"),
    ]))
    assert not [i for i in doc.issues if i.code == "figure_missing"], doc.issues


def test_ordinary_prose_is_not_mistaken_for_a_figure_reference():
    """
    「代表中國」裡有「表中」、「以上表現」裡有「上表」。寬鬆的樣式會在
    歷史與公民的題目上大量誤報，而每一筆誤報都要老師看一眼才能排除。

    最後兩句是**真的踩到的**：翰林《數學(1)》4-3 圓與直線裡，
    「若方程式的圖形表一圓」出現 9 次——那裡的「表」是「表示」、
    「一圓」是「一個圓」，跟「表 1」無關。早期的樣式會在那一份講義上
    丟出 9 筆假警報。
    """
    for stem in (
        "下列何者可以代表中國明代的對外政策？",
        "小明以上表現優異獲選為班級代表，下列敘述何者正確？",
        "他企圖以此說服眾人，其行為屬於下列何種類型？",
        "若方程式的圖形表一圓，則 $k$ 的範圍為何？",
        "若方程式的圖形表一點，則 $k$ 之值為何？",
    ):
        doc = finalize(ImportDocument(questions=[q("q1", stem=stem)]))
        assert not [i for i in doc.issues if i.code == "figure_missing"], (stem, doc.issues)


def test_equivalent_unit_spellings_compare_equal():
    """
    m/s²、m/s^2、m·s⁻²、m s^-2 是同一個單位，出現在不同出版社的講義上。
    逐字比對會把學生寫的 `m/s^2` 判錯，而那是排版差異不是物理錯誤。
    """
    from pipeline.canonical import normalize_unit, same_unit

    for a, b in (
        ("m/s²", "m·s⁻²"),
        ("m/s^2", "m s^-2"),
        ("m/s/s", "m/s^2"),
        ("J/(kg·K)", "J·kg^-1·K^-1"),
        ("N·m", "m·N"),
        ("μm", "µm"),          # 微符號與希臘小寫 mu 是不同碼位
    ):
        assert same_unit(a, b), f"{a} 應等於 {b}（{normalize_unit(a)} vs {normalize_unit(b)}）"

    # 字首不換算：答案要求公尺就是公尺
    assert not same_unit("km", "m")
    assert not same_unit("N", "kg·m/s^2"), "不做量綱分析——題目要什麼單位就是什麼單位"
    # 沒填不等於不相等
    assert same_unit(None, "N") and same_unit("", "N")


def test_a_unit_we_cannot_read_says_so_instead_of_pretending():
    """
    看不懂的單位回傳 `?原文`，並在文件裡留一筆。**不假裝正規化成功**：
    系統看不懂那個單位，就不該在改考卷時宣稱兩種寫法等價。
    """
    from pipeline.canonical import Scoring, normalize_unit

    assert normalize_unit("每公升 3 大卡").startswith("?")

    doc = finalize(ImportDocument(questions=[
        q("q1", QuestionKind.CALCULATION, options=[],
          scoring=Scoring(score=4, unit="每公升 3 大卡")),
    ]))
    assert [i for i in doc.issues if i.code == "unit_unparsed"], doc.issues

    # 看得懂的就安靜
    ok = finalize(ImportDocument(questions=[
        q("q1", QuestionKind.CALCULATION, options=[],
          scoring=Scoring(score=4, unit="m/s²", sig_figs=3)),
    ]))
    assert not [i for i in ok.issues if i.code == "unit_unparsed"], ok.issues
    assert ok.questions[0].scoring.unit == "m/s²", "存的是原文"
    assert ok.questions[0].scoring.unit_canonical == "m·s^-2"


def test_chinese_unit_names_match_their_si_symbols():
    """
    南易《EZ 講義 物理》第 3 章：範例 5 寫「負 2 米/秒² 的定值加速度」，
    正下方的類題 5 就寫「多少 m/s²」——**同一頁、同一個概念、
    兩種單位系統**。不對應的話，學生寫 m/s² 會被判錯。
    """
    from pipeline.canonical import normalize_unit, same_unit

    for a, b in (
        ("米/秒²", "m/s^2"),
        ("公尺/秒", "m/s"),
        ("公里/小時", "km/hr"),
        ("公斤·米/秒²", "kg·m/s^2"),
        ("牛頓", "N"),
        ("莫耳/公升", "mol/L"),
        ("立方公分", "cm3"),
    ):
        assert same_unit(a, b), f"{a} 應等於 {b}（{normalize_unit(a)} vs {normalize_unit(b)}）"

    # 字首仍然不換算
    assert not same_unit("公里", "公尺")
    # 認不得的中文單位要回報看不懂，**不要猜**。「度」是角度、溫度、
    # 電度，對不出唯一解；猜錯的代價是宣稱兩個不同的答案等價。
    for unknown in ("度", "台尺", "每公升 3 大卡"):
        assert normalize_unit(unknown).startswith("?"), unknown


def test_expected_count_catches_a_misread_answer_key():
    """
    「（應選 3 項）」是原稿自己說的，所以答案數量對不上一定有一邊
    讀錯了。**這是一個免費的檢查**——不必問模型、不必自答、
    不必老師看。南易的多選題每一題都印。
    """
    from pipeline.canonical import Scoring

    doc = finalize(ImportDocument(questions=[
        q("q1", QuestionKind.MULTI_CHOICE, n=5,
          scoring=Scoring(score=4, expected_count=3, partial_credit=True),
          answer=Answer(source=AnswerSource.PRINTED, keys=[1, 4])),
    ]))
    bad = [i for i in doc.issues if i.code == "answer_count_mismatch"]
    assert bad and bad[0].severity is Severity.ERROR, doc.issues
    assert "應選 3 項" in bad[0].detail

    ok = finalize(ImportDocument(questions=[
        q("q1", QuestionKind.MULTI_CHOICE, n=5,
          scoring=Scoring(score=4, expected_count=3, partial_credit=True),
          answer=Answer(source=AnswerSource.PRINTED, keys=[1, 3, 4])),
    ]))
    assert not [i for i in ok.issues if i.code == "answer_count_mismatch"], ok.issues


def test_expected_count_does_not_fire_on_a_student_edition():
    """
    學生版沒印答案，沒有東西可以對。在那裡報錯只是噪音，
    而噪音吃掉的是校對時間。
    """
    from pipeline.canonical import Scoring

    doc = finalize(ImportDocument(questions=[
        q("q1", QuestionKind.MULTI_CHOICE, n=5,
          scoring=Scoring(expected_count=3), answer=Answer()),
    ]))
    assert not [i for i in doc.issues if i.code == "answer_count_mismatch"], doc.issues


def test_printed_cross_references_are_kept():
    """
    「〈相關題型：單元練習 3.、7.〉」——**出版社的編輯已經一題一題
    標好了題目關聯**，而智慧老師要在學生答錯時說「這個觀念這裡還有
    兩題可以練」，靠的就是它。

    存原文不存 id：那些指引指向「這一本裡的第幾題」，要等整份匯入
    完才解得開。現在不收，之後就只能重讀一次 PDF。
    """
    got = q("q1", provenance=Provenance(
        related_raw=["單元練習 3.", "單元練習 7."], badges=["素養題"]))
    assert got.provenance.related_raw == ["單元練習 3.", "單元練習 7."]
    assert got.provenance.badges == ["素養題"]


def test_a_graph_reading_question_without_its_graph_is_caught():
    """
    南易《EZ 講義 物理》3-2 單元練習第 4、5 題：「圖中 4 秒的位置為
    8 公尺」「圖中 PQ 代表切線」——共用一張 x–t 圖，題幹用「圖中」
    指它。

    實測兩份數學講義上「圖中」只出現 2 次，兩次都是真的在指圖，
    零誤報。所以這個詞收得起。
    """
    doc = finalize(ImportDocument(
        document=DocumentMeta(subject=SubjectCode.PHYSICS),
        questions=[q("q1", QuestionKind.SINGLE_CHOICE,
                     stem="圖中 4 秒的位置為 8 公尺，5 秒的位置為 15 公尺，"
                          "則 4～5 秒的平均速度為多少公尺/秒？")],
    ))
    assert [i for i in doc.issues if i.code == "figure_missing"], doc.issues


def test_physics_maps_to_the_combined_science_paper():
    """物理是分科教的，但學測考的是合科自然。組模擬卷時要湊得起來。"""
    from pipeline.canonical import PARENT_SUBJECT

    assert PARENT_SUBJECT[SubjectCode.PHYSICS] is SubjectCode.SCIENCE


# ─────────────────────────────────────────────────────────────────
# 八、出版社專屬題型：問老師一次，之後記住
# ─────────────────────────────────────────────────────────────────


def test_confirmed_custom_type_passes_clean():
    """老師確認過的題型直接可用，不再出聲。"""
    from pipeline.canonical import CustomTypeRef

    doc = finalize(ImportDocument(questions=[
        Question(id="q1", kind=QuestionKind.PUBLISHER_CUSTOM,
                 stem="觀念速記：光合作用的兩個階段是 {{blank}} 與 {{blank}}",
                 custom_type=CustomTypeRef(id="ct_1", name="觀念速記", publisher="翰林",
                                           answer_mode=QuestionKind.FILL_BLANK,
                                           confirmed=True),
                 placement=Placement(page=1, bbox=box()),
                 confidence=Confidence(score=0.9)),
    ]))
    assert doc.issues == [], doc.issues


def test_proposed_custom_type_is_flagged_for_the_teacher():
    """
    模型提議的新題型**不可自動入庫**。它要先被拿去問老師三件事：
    這是什麼、學生怎麼作答、有沒有取得出版社授權。
    """
    from pipeline.canonical import CustomTypeRef

    doc = finalize(ImportDocument(questions=[
        Question(id="q1", kind=QuestionKind.PUBLISHER_CUSTOM,
                 stem="某種沒看過的題型",
                 custom_type=CustomTypeRef(name="圖表解碼", publisher="南一",
                                           answer_mode=QuestionKind.SHORT_ANSWER,
                                           confirmed=False),
                 placement=Placement(page=1, bbox=box()),
                 confidence=Confidence(score=0.5)),
    ]))
    hit = [i for i in doc.issues if i.code == "custom_type_unconfirmed"]
    assert hit, doc.issues
    assert "圖表解碼" in hit[0].detail
    assert "授權" in hit[0].detail


def test_custom_type_without_a_description_is_an_error():
    """
    標成專屬題型卻說不出那是什麼，下游就不知道學生要怎麼作答——
    系統存得下它卻沒辦法拿它考學生，那比不支援更糟，因為老師
    以為可以用。
    """
    doc = finalize(ImportDocument(questions=[
        Question(id="q1", kind=QuestionKind.PUBLISHER_CUSTOM, stem="某題",
                 placement=Placement(page=1, bbox=box()),
                 confidence=Confidence(score=0.8)),
    ]))
    hit = [i for i in doc.issues if i.code == "custom_type_missing"]
    assert hit and hit[0].severity is Severity.ERROR, doc.issues


def test_custom_type_answer_mode_is_a_standard_one():
    """
    專屬題型無論長得多特別，**作答方式一定落在標準的那幾種**。
    這一點讓它變得可處理：系統不必懂那個題型的教學設計。
    """
    from pipeline.canonical import CustomTypeRef

    ref = CustomTypeRef(name="雙欄配對", answer_mode=QuestionKind.MATCHING)
    assert ref.answer_mode in set(QuestionKind)
    assert ref.confirmed is False, "預設必須是未確認"


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
