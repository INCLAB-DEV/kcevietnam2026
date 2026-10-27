"""내보내기 테스트 — 핵심 AC: 보고문서에 비공개 필드가 들어가지 않는다(D6).

PDF/DOCX 가 실제로 생성되고, 본문에 AI 구조화 + 미팅 메타만 담기며, Follow-up Intent/Fit/
만족도/전사 원문 같은 비공개 데이터가 산출물에 부재함을 검증한다.
"""

from app.domain.review_capture import ReportSections
from app.services.export import ReportMeta, render_docx, render_pdf


def _report() -> ReportSections:
    return ReportSections(
        discussion=["155mm 정밀유도탄 사거리 60km 연장 요구"],
        agreements=["8월 중순까지 기술제안서 송부"],
        actions=["8월 말 소요검토 회신"],
    )


def _meta() -> ReportMeta:
    return ReportMeta(
        counterpart_org="풍산",
        meeting_datetime="2026-09-16 10:00",
        venue="비즈매칭존 T-01",
        own_org="국방기술품질원",
    )


def _docx_text(data: bytes) -> str:
    import io

    from docx import Document

    doc = Document(io.BytesIO(data))
    return "\n".join(p.text for p in doc.paragraphs)


class TestDocx:
    def test_renders_nonempty_docx(self):
        data = render_docx(_report(), _meta())
        assert data[:2] == b"PK"  # docx = zip
        assert len(data) > 500

    def test_docx_is_real_ooxml_not_html_or_text_in_disguise(self):
        # QA C2 — 과거 유사 기능(.xls export)이 실제로는 확장자만 바뀐 HTML이었던 전례가 있어
        # 진짜 OOXML(zip 안에 word/document.xml)인지 구조를 직접 열어 확인한다. 한글 본문도
        # word/document.xml 안에 원문 그대로(깨지지 않고) 들어있어야 한다(D5/D6 관련 회귀 방지).
        import io
        import zipfile

        data = render_docx(_report(), _meta())
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = zf.namelist()
            assert "word/document.xml" in names
            assert "[Content_Types].xml" in names
            xml = zf.read("word/document.xml").decode("utf-8")
        assert "<html" not in xml.lower()  # HTML 위장이 아니다
        assert "155mm 정밀유도탄 사거리 60km 연장 요구" in xml  # 한글 본문이 그대로(안 깨짐)
        assert "풍산" in xml

    def test_body_contains_sections_and_meta(self):
        text = _docx_text(render_docx(_report(), _meta()))
        assert "핵심 논의사항" in text
        assert "합의 사항" in text
        assert "후속 액션" in text
        assert "풍산" in text
        assert "155mm 정밀유도탄 사거리 60km 연장 요구" in text

    def test_docx_excludes_private_fields(self):
        # render_docx 는 ReportSections+ReportMeta 만 받으므로 비공개가 구조적으로 못 들어온다.
        # 회귀 방지: 산출물 텍스트에 비공개 흔적이 없음을 확인.
        text = _docx_text(render_docx(_report(), _meta()))
        for forbidden in ["잘맞음", "good", "follow_up", "Follow-up", "만족도", "fit", "전사"]:
            assert forbidden not in text


class TestDocxLocale:
    """``locale``은 문서의 **항목 이름**만 고른다 — 본문(회의록 문장·메타 값)은 넘겨받은 그대로다."""

    def test_english_labels_replace_korean_ones(self):
        text = _docx_text(render_docx(_report(), _meta(), locale="en"))

        for label in (
            "Meeting report",
            "Key discussion points",
            "Agreements",
            "Follow-up actions",
            "Counterpart: ",
            "Date & time: ",
            "Venue: ",
            "Prepared by: ",
        ):
            assert label in text
        for korean_label in ("미팅 보고서", "핵심 논의사항", "합의 사항", "후속 액션", "상대 기업", "일시", "작성"):
            assert korean_label not in text
        # 본문과 메타 값은 사용자가 쓴 그대로다 — 번역하지 않는다.
        assert "155mm 정밀유도탄 사거리 60km 연장 요구" in text
        assert "풍산" in text

    def test_english_empty_section_marker(self):
        report = ReportSections(discussion=["only one"], agreements=[], actions=[])
        text = _docx_text(render_docx(report, _meta(), locale="en"))
        assert text.count("(None)") == 2
        assert "(해당 없음)" not in text

    def test_default_and_unknown_locale_keep_the_korean_document(self):
        default = _docx_text(render_docx(_report(), _meta()))
        assert _docx_text(render_docx(_report(), _meta(), locale="ko")) == default
        assert _docx_text(render_docx(_report(), _meta(), locale="ja")) == default
        assert "미팅 보고서" in default

    def test_english_docx_excludes_private_fields(self):
        # 섹션 이름 "Follow-up actions"는 공개 보고문서의 일부다 — 비공개는 그 뒤의 평가 항목들이다.
        text = _docx_text(render_docx(_report(), _meta(), locale="en"))
        for forbidden in ["Good fit", "Follow-up interest", "follow_up", "Satisfaction", "Fit assessment", "Transcript"]:
            assert forbidden not in text

    def test_english_pdf_renders(self):
        data = render_pdf(_report(), _meta(), locale="en")
        assert data[:4] == b"%PDF"
        assert len(data) > 800


class TestPdf:
    def test_renders_nonempty_pdf(self):
        data = render_pdf(_report(), _meta())
        assert data[:4] == b"%PDF"
        assert len(data) > 800

    def test_pdf_handles_empty_section(self):
        report = ReportSections(discussion=["A"], agreements=[], actions=[])
        data = render_pdf(report, _meta())
        assert data[:4] == b"%PDF"
