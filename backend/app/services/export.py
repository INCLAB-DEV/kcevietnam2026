"""보고문서 내보내기 — PDF + DOCX (D5/D6).

본문 = AI 구조화(핵심 논의사항/합의 사항/후속 액션) + 미팅 메타(상대 기업·일시·장소).
**비공개 항목(Follow-up Intent·Fit Assessment·만족도·전사 원문)은 절대 포함하지 않는다(D6).**
이 모듈은 ReportSections + 공개 메타만 입력으로 받으므로, 비공개 데이터가 구조적으로 들어올 수 없다.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

from app.domain.review_capture import ReportSections


@dataclass(frozen=True)
class ReportMeta:
    """보고문서에 넣는 공개 메타. 비공개 평가는 일부러 포함하지 않는다."""

    counterpart_org: str  # 상대 기업
    meeting_datetime: str = ""  # 일시 (표시용 문자열)
    venue: str = ""  # 장소
    own_org: str = ""  # 작성 기업


_SECTION_TITLES = [
    ("discussion", "핵심 논의사항"),
    ("agreements", "합의 사항"),
    ("actions", "후속 액션"),
]


def _ordered_sections(report: ReportSections) -> list[tuple[str, list[str]]]:
    mapping = {
        "discussion": report.discussion,
        "agreements": report.agreements,
        "actions": report.actions,
    }
    return [(title, mapping[key]) for key, title in _SECTION_TITLES]


def _meta_lines(meta: ReportMeta) -> list[tuple[str, str]]:
    lines = [("상대 기업", meta.counterpart_org)]
    if meta.meeting_datetime:
        lines.append(("일시", meta.meeting_datetime))
    if meta.venue:
        lines.append(("장소", meta.venue))
    if meta.own_org:
        lines.append(("작성", meta.own_org))
    return lines


def render_docx(report: ReportSections, meta: ReportMeta) -> bytes:
    """편집 가능한 DOCX(회사 양식 수정용, D5)."""
    from docx import Document
    from docx.shared import Pt

    doc = Document()
    doc.add_heading("미팅 보고서", level=0)

    for label, value in _meta_lines(meta):
        p = doc.add_paragraph()
        run = p.add_run(f"{label}: ")
        run.bold = True
        p.add_run(value)

    for title, items in _ordered_sections(report):
        doc.add_heading(title, level=1)
        if items:
            for item in items:
                doc.add_paragraph(item, style="List Bullet")
        else:
            empty = doc.add_paragraph("(해당 없음)")
            empty.runs[0].font.size = Pt(10)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def render_pdf(report: ReportSections, meta: ReportMeta) -> bytes:
    """최종 보고 첨부용 PDF(D5). 한글은 reportlab 내장 CID 폰트로 렌더."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer

    pdfmetrics.registerFont(UnicodeCIDFont("HYSMyeongJo-Medium"))
    base = getSampleStyleSheet()
    title_style = ParagraphStyle("t", parent=base["Title"], fontName="HYSMyeongJo-Medium")
    h_style = ParagraphStyle("h", parent=base["Heading2"], fontName="HYSMyeongJo-Medium")
    body = ParagraphStyle("b", parent=base["BodyText"], fontName="HYSMyeongJo-Medium")

    buf = io.BytesIO()
    docpdf = SimpleDocTemplate(buf, pagesize=A4, topMargin=20 * mm, bottomMargin=20 * mm)
    flow = [Paragraph("미팅 보고서", title_style), Spacer(1, 6 * mm)]

    for label, value in _meta_lines(meta):
        flow.append(Paragraph(f"<b>{label}:</b> {value}", body))
    flow.append(Spacer(1, 4 * mm))

    for title, items in _ordered_sections(report):
        flow.append(Paragraph(title, h_style))
        if items:
            flow.append(
                ListFlowable(
                    [ListItem(Paragraph(it, body)) for it in items], bulletType="bullet"
                )
            )
        else:
            flow.append(Paragraph("(해당 없음)", body))
        flow.append(Spacer(1, 3 * mm))

    docpdf.build(flow)
    return buf.getvalue()
