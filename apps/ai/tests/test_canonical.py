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
# 七、理科：化學與生物
# ─────────────────────────────────────────────────────────────────


def test_chemistry_notation_is_accepted():
    """
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
