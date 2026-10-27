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


_SECTION_KEYS = ("discussion", "agreements", "actions")

#: 문서 안의 **항목 이름**(제목·섹션·메타 라벨·빈 섹션 표시). 본문(회의록 문장)은 사용자가 쓴
#: 그대로라 여기서 옮기지 않는다. en 표기는 화면 카탈로그(messages/en.json ``review.compose.*`` ·
#: ``review.done.emptySection``)와 같은 말을 쓴다 — 화면에서 본 섹션 이름이 문서에서 달라지면 안 된다.
_LABELS: dict[str, dict[str, str]] = {
    "ko": {
        "title": "미팅 보고서",
        "discussion": "핵심 논의사항",
        "agreements": "합의 사항",
        "actions": "후속 액션",
        "counterpart": "상대 기업",
        "datetime": "일시",
        "venue": "장소",
        "author": "작성",
        "empty": "(해당 없음)",
    },
    "en": {
        "title": "Meeting report",
        "discussion": "Key discussion points",
        "agreements": "Agreements",
        "actions": "Follow-up actions",
        "counterpart": "Counterpart",
        "datetime": "Date & time",
        "venue": "Venue",
        "author": "Prepared by",
        "empty": "(None)",
    },
}


def _labels(locale: str) -> dict[str, str]:
    """모르는 로케일은 기존 한국어 문서로 수렴한다(표시 선택지의 오타로 내보내기가 죽지 않게)."""
    return _LABELS.get(locale, _LABELS["ko"])


def _ordered_sections(report: ReportSections, locale: str) -> list[tuple[str, list[str]]]:
    labels = _labels(locale)
    mapping = {
        "discussion": report.discussion,
        "agreements": report.agreements,
        "actions": report.actions,
    }
    return [(labels[key], mapping[key]) for key in _SECTION_KEYS]


def _meta_lines(meta: ReportMeta, locale: str) -> list[tuple[str, str]]:
    labels = _labels(locale)
    lines = [(labels["counterpart"], meta.counterpart_org)]
    if meta.meeting_datetime:
        lines.append((labels["datetime"], meta.meeting_datetime))
    if meta.venue:
        lines.append((labels["venue"], meta.venue))
    if meta.own_org:
        lines.append((labels["author"], meta.own_org))
    return lines


def render_docx(report: ReportSections, meta: ReportMeta, *, locale: str = "ko") -> bytes:
    """편집 가능한 DOCX(회사 양식 수정용, D5). ``locale``은 항목 이름의 언어만 고른다."""
    from docx import Document
    from docx.shared import Pt

    labels = _labels(locale)
    doc = Document()
    doc.add_heading(labels["title"], level=0)

    for label, value in _meta_lines(meta, locale):
        p = doc.add_paragraph()
        run = p.add_run(f"{label}: ")
        run.bold = True
        p.add_run(value)

    for title, items in _ordered_sections(report, locale):
        doc.add_heading(title, level=1)
        if items:
            for item in items:
                doc.add_paragraph(item, style="List Bullet")
        else:
            empty = doc.add_paragraph(labels["empty"])
            empty.runs[0].font.size = Pt(10)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def render_pdf(report: ReportSections, meta: ReportMeta, *, locale: str = "ko") -> bytes:
    """최종 보고 첨부용 PDF(D5). 한글은 reportlab 내장 CID 폰트로 렌더.

    en 문서도 같은 폰트를 쓴다 — 항목 이름만 영어고 본문(회의록·기업명)에는 한글이 섞여 있을 수
    있어서, 한글 글리프가 없는 폰트로 바꾸면 그 글자들이 깨져 나온다.
    """
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
    labels = _labels(locale)
    flow = [Paragraph(labels["title"], title_style), Spacer(1, 6 * mm)]

    for label, value in _meta_lines(meta, locale):
        flow.append(Paragraph(f"<b>{label}:</b> {value}", body))
    flow.append(Spacer(1, 4 * mm))

    for title, items in _ordered_sections(report, locale):
        flow.append(Paragraph(title, h_style))
        if items:
            flow.append(
                ListFlowable(
                    [ListItem(Paragraph(it, body)) for it in items], bulletType="bullet"
                )
            )
        else:
            flow.append(Paragraph(labels["empty"], body))
        flow.append(Spacer(1, 3 * mm))

    docpdf.build(flow)
    return buf.getvalue()
