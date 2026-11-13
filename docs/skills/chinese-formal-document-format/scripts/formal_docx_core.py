#!/usr/bin/env python3
"""Shared formatting and verification helpers for Chinese formal documents."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import xml.etree.ElementTree as ET
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable
from zipfile import BadZipFile, ZipFile

try:
    from docx import Document
    from docx.document import Document as DocumentObject
    from docx.enum.section import WD_ORIENT
    from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Mm, Pt, RGBColor
    from docx.table import Table
    from docx.text.paragraph import Paragraph
except ImportError as exc:  # pragma: no cover - exercised through CLI error path
    raise SystemExit(
        "缺少 python-docx。请先运行：python -m pip install python-docx"
    ) from exc


TOOL_VERSION = "1.3.0"
PACKAGE_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROFILE = PACKAGE_ROOT / "profiles" / "default.json"

LEVEL1_RE = re.compile(r"^\s*[一二三四五六七八九十百零〇两]+、")
LEVEL2_RE = re.compile(r"^\s*[（(][一二三四五六七八九十百零〇两]+[）)]")
LEVEL3_RE = re.compile(r"^\s*\d+(?:[.．、])\s*")
LEVEL4_RE = re.compile(r"^\s*[（(]\d+[）)]")
DATE_RE = re.compile(r"^\s*\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*$")
METADATA_KEYS = (
    "会议时间",
    "会议地点",
    "会议主题",
    "主持人",
    "出席人员",
    "列席人员",
    "缺席人员",
    "记录人",
)
CLOSING_PREFIXES = ("特此", "请审示", "请批示", "妥否", "以上", "请研处", "请函复")
ORGANIZATION_SUFFIXES = (
    "公司",
    "集团",
    "办公室",
    "委员会",
    "中心",
    "部门",
    "研究院",
    "事业部",
    "学校",
    "医院",
    "协会",
)
UNSUPPORTED_MARKERS = {
    b"<w:ins ": "修订插入",
    b"<w:del ": "修订删除",
    b"<w:sdt": "内容控件",
    b"<w:txbxContent": "文本框",
    b"<w:commentReference": "批注引用",
    b"<w:footnoteReference": "脚注引用",
    b"<w:endnoteReference": "尾注引用",
}


class FormalDocumentError(RuntimeError):
    """Raised for a user-actionable formatting failure."""


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Merge dictionaries recursively without mutating either input."""
    result = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


def load_profile(profile_path: Path | None = None) -> dict[str, Any]:
    base = json.loads(DEFAULT_PROFILE.read_text(encoding="utf-8"))
    if profile_path is None:
        return base
    resolved = profile_path.expanduser().resolve()
    override = json.loads(resolved.read_text(encoding="utf-8"))
    return deep_merge(base, override)


def iter_block_items(doc: DocumentObject) -> Iterable[Paragraph | Table]:
    """Yield top-level body paragraphs and tables in document order."""
    body = doc.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, doc)
        elif child.tag == qn("w:tbl"):
            yield Table(child, doc)


def paragraph_texts(doc: DocumentObject) -> list[str]:
    return [paragraph.text for paragraph in doc.paragraphs]


def _xml_text(element: Any) -> str:
    chunks: list[str] = []
    for node in element.iter():
        if node.tag == qn("w:t"):
            chunks.append(node.text or "")
        elif node.tag == qn("w:tab"):
            chunks.append("\t")
        elif node.tag in {qn("w:br"), qn("w:cr")}:
            chunks.append("\n")
    return "".join(chunks)


def table_signature(table: Table) -> dict[str, Any]:
    grid = [
        int(column.get(qn("w:w")))
        for column in table._tbl.tblGrid.gridCol_lst
        if column.get(qn("w:w"))
    ]
    rows: list[dict[str, Any]] = []
    for row in table._tbl.tr_lst:
        cells: list[dict[str, Any]] = []
        for tc in row.tc_lst:
            tc_pr = tc.tcPr
            span_element = (
                tc_pr.find(qn("w:gridSpan")) if tc_pr is not None else None
            )
            merge_element = (
                tc_pr.find(qn("w:vMerge")) if tc_pr is not None else None
            )
            paragraphs = [
                _xml_text(paragraph)
                for paragraph in tc.findall("./" + qn("w:p"))
            ]
            nested_tables = [
                table_signature(Table(nested, table._parent))
                for nested in tc.findall("./" + qn("w:tbl"))
            ]
            cells.append(
                {
                    "paragraphs": paragraphs,
                    "grid_span": (
                        int(span_element.get(qn("w:val")))
                        if span_element is not None
                        else 1
                    ),
                    "vertical_merge": (
                        merge_element.get(qn("w:val"), "continue")
                        if merge_element is not None
                        else None
                    ),
                    "nested_tables": nested_tables,
                }
            )
        rows.append({"cells": cells})
    return {
        "row_count": len(rows),
        "column_count": len(grid),
        "rows": rows,
    }


def header_footer_signature(doc: DocumentObject) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for index, section in enumerate(doc.sections):
        for kind, container in (
            ("header", section.header),
            ("first_page_header", section.first_page_header),
            ("even_page_header", section.even_page_header),
            ("footer", section.footer),
            ("first_page_footer", section.first_page_footer),
            ("even_page_footer", section.even_page_footer),
        ):
            result.append(
                {
                    "section": index,
                    "kind": kind,
                    "paragraphs": [p.text for p in container.paragraphs],
                    "tables": [table_signature(t) for t in container.tables],
                    "drawing_ids": re.findall(
                        r'<a:blip[^>]+r:embed="([^"]+)"',
                        container._element.xml,
                    ),
                }
            )
    return result


def document_signature(doc: DocumentObject) -> dict[str, Any]:
    blocks: list[dict[str, Any]] = []
    for block in iter_block_items(doc):
        if isinstance(block, Paragraph):
            blocks.append({"kind": "paragraph", "text": block.text})
        else:
            blocks.append({"kind": "table", **table_signature(block)})
    document_xml = doc.element.xml
    marker_counts = {
        "ins": document_xml.count("<w:ins "),
        "del": document_xml.count("<w:del "),
        "sdt": document_xml.count("<w:sdt"),
        "txbxContent": document_xml.count("<w:txbxContent"),
        "commentRangeStart": document_xml.count("<w:commentRangeStart"),
        "footnoteReference": document_xml.count("<w:footnoteReference"),
        "endnoteReference": document_xml.count("<w:endnoteReference"),
        "fldChar": document_xml.count("<w:fldChar"),
    }
    return {
        "blocks": blocks,
        "sections": len(doc.sections),
        "headers_footers": header_footer_signature(doc),
        "drawings": [
            {
                "kind": shape.type.value,
                "width": int(shape.width),
                "height": int(shape.height),
                "relationship_ids": re.findall(
                    r'r:(?:embed|id)="([^"]+)"', shape._inline.xml
                ),
            }
            for shape in doc.inline_shapes
        ],
        "all_drawing_relationship_ids": re.findall(
            r'<a:blip[^>]+r:embed="([^"]+)"', document_xml
        )
        + re.findall(r'<v:imagedata[^>]+r:id="([^"]+)"', document_xml),
        "hyperlink_relationship_ids": re.findall(
            r'<w:hyperlink[^>]+r:id="([^"]+)"', document_xml
        ),
        "marker_counts": marker_counts,
    }


def signature_hash(signature: dict[str, Any]) -> str:
    payload = json.dumps(signature, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def inspect_package(path: Path) -> list[str]:
    warnings: list[str] = []
    if path.suffix.lower() != ".docx":
        warnings.append("输入不是 .docx；本工具不直接处理 .doc、PDF 或扫描件。")
    try:
        with ZipFile(path) as package:
            document_xml = package.read("word/document.xml")
    except (BadZipFile, KeyError) as exc:
        raise FormalDocumentError("文件无法作为 DOCX 读取，可能已损坏、加密或扩展名不正确。") from exc
    for marker, label in UNSUPPORTED_MARKERS.items():
        if marker in document_xml:
            warnings.append(f"检测到{label}；主流程只排版普通段落和表格，请在 Word 中复核相关区域。")
    try:
        root = ET.fromstring(document_xml)
        if any(
            table.find(".//" + qn("w:tbl")) is not None
            for table in root.iter(qn("w:tbl"))
        ):
            warnings.append(
                "检测到嵌套表格；主流程只调整顶层表格，请在 Word 中复核嵌套区域。"
            )
    except ET.ParseError:
        warnings.append("document.xml 无法解析；请先在 Word 中重新保存后再试。")
    return warnings


def _first_nonempty_paragraph(doc: DocumentObject) -> int | None:
    for index, paragraph in enumerate(doc.paragraphs):
        if paragraph.text.strip():
            return index
    return None


def infer_document_type(
    doc: DocumentObject, title_line_count: int = 1
) -> str:
    title_index = _first_nonempty_paragraph(doc)
    if title_index is None:
        return "generic"
    title_parts: list[str] = []
    for paragraph in doc.paragraphs[title_index:]:
        if paragraph.text.strip():
            title_parts.append(paragraph.text.strip())
        if len(title_parts) >= max(1, title_line_count):
            break
    title = "\n".join(title_parts)
    compact_title = "".join(title_parts)
    early_text = "\n".join(
        paragraph.text
        for paragraph in doc.paragraphs[title_index : title_index + 20]
        if paragraph.text.strip()
    )
    metadata_count = sum(
        1 for paragraph in doc.paragraphs if is_metadata_paragraph(paragraph.text)
    )
    if "会议纪要" in compact_title or metadata_count >= 2:
        return "minutes"
    if re.search(r"(实施方案|工作方案|工作计划|方案)$", compact_title):
        return "plan"
    if re.search(r"(函|函件)$", compact_title):
        return "letter"
    if "报告" in compact_title or "报告如下" in early_text:
        return "report"
    return "generic"


def is_metadata_paragraph(text: str) -> bool:
    stripped = text.strip()
    return any(
        stripped.startswith(key + "：") or stripped.startswith(key + ":")
        for key in METADATA_KEYS
    )


def _is_closing(text: str) -> bool:
    stripped = text.strip()
    return any(stripped.startswith(prefix) for prefix in CLOSING_PREFIXES)


def _is_standalone_heading(text: str) -> bool:
    stripped = text.strip()
    return bool(stripped) and stripped[-1] not in "。；;！!？?"


def _is_numbered_body_item(text: str, role: str) -> bool:
    stripped = text.strip()
    marker_length = 0
    for pattern in (LEVEL2_RE, LEVEL3_RE, LEVEL4_RE):
        match = pattern.match(stripped)
        if match:
            marker_length = match.end()
            break
    content = stripped[marker_length:].strip()
    if role in {"heading3", "heading4"}:
        return any(mark in content for mark in "。；;！!？?")
    if role == "heading2":
        return (
            "。" in content
            and content.count("。") == 1
            and content.endswith("。")
            and len(content) > 20
        )
    return False


def _looks_like_organization(text: str) -> bool:
    stripped = text.strip()
    if not stripped or len(stripped) > 80 or _is_closing(stripped):
        return False
    if any(stripped.endswith(suffix) for suffix in ORGANIZATION_SUFFIXES):
        return True
    return not re.search(r"[。；;！!？?]", stripped) and len(stripped) <= 30


def classify_document(
    doc: DocumentObject,
    requested_type: str = "auto",
    title_line_count: int = 1,
) -> dict[str, Any]:
    paragraphs = doc.paragraphs
    roles = ["body"] * len(paragraphs)
    title_index = _first_nonempty_paragraph(doc)
    if title_index is not None:
        assigned = 0
        for index in range(title_index, len(paragraphs)):
            if not paragraphs[index].text.strip():
                continue
            roles[index] = "title"
            assigned += 1
            if assigned >= max(1, title_line_count):
                break

    for index, paragraph in enumerate(paragraphs):
        if is_metadata_paragraph(paragraph.text):
            roles[index] = "metadata"

    recipient_index: int | None = None
    if title_index is not None:
        last_title_index = max(
            index for index, role in enumerate(roles) if role == "title"
        )
        for index in range(
            last_title_index + 1,
            min(len(paragraphs), last_title_index + 9),
        ):
            text = paragraphs[index].text.strip()
            if not text or roles[index] == "metadata":
                continue
            if LEVEL1_RE.match(text) or LEVEL2_RE.match(text):
                break
            if text.endswith(("：", ":")) and len(text) <= 80:
                recipient_index = index
                roles[index] = "recipient"
            break

    for index, paragraph in enumerate(paragraphs):
        if roles[index] in {"title", "recipient", "metadata"}:
            continue
        text = paragraph.text.strip()
        if LEVEL1_RE.match(text):
            roles[index] = "heading1"
        elif LEVEL2_RE.match(text):
            roles[index] = "heading2"
        elif LEVEL3_RE.match(text):
            roles[index] = "heading3"
        elif LEVEL4_RE.match(text):
            roles[index] = "heading4"
        if roles[index] in {"heading2", "heading3", "heading4"}:
            if _is_numbered_body_item(text, roles[index]):
                roles[index] = "body_item"

    paragraph_index_by_element = {
        paragraph._p: index for index, paragraph in enumerate(paragraphs)
    }
    previous = None
    for block in iter_block_items(doc):
        if isinstance(block, Table):
            if isinstance(previous, Paragraph):
                paragraph_index = paragraph_index_by_element.get(previous._p)
                if paragraph_index is not None:
                    text = previous.text.strip()
                    if re.match(r"^(表|图)\s*\d+", text) and len(text) <= 120:
                        roles[paragraph_index] = "table_caption"
        previous = block

    date_index: int | None = None
    search_start = max(title_index + 1 if title_index is not None else 0, len(paragraphs) - 10)
    for index in range(len(paragraphs) - 1, search_start - 1, -1):
        if DATE_RE.match(paragraphs[index].text):
            date_index = index
            roles[index] = "date"
            break

    signature_index: int | None = None
    if date_index is not None:
        for index in range(date_index - 1, max(title_index or 0, date_index - 6) - 1, -1):
            if roles[index] in {"heading1", "heading2", "heading3", "heading4", "metadata"}:
                continue
            if _looks_like_organization(paragraphs[index].text):
                signature_index = index
                roles[index] = "signature"
                break

    doc_type = (
        infer_document_type(doc, title_line_count)
        if requested_type == "auto"
        else requested_type
    )
    return {
        "doc_type": doc_type,
        "roles": roles,
        "title_index": title_index,
        "recipient_index": recipient_index,
        "signature_index": signature_index,
        "date_index": date_index,
    }


def _set_run_font(
    run: Any,
    font_name: str,
    latin_font: str,
    size_pt: float,
    bold: bool | None,
) -> None:
    run.font.name = latin_font
    run.font.size = Pt(size_pt)
    if bold is not None:
        run.font.bold = bold
    run.font.color.rgb = RGBColor(0, 0, 0)
    r_pr = run._element.get_or_add_rPr()
    r_fonts = r_pr.find(qn("w:rFonts"))
    if r_fonts is None:
        r_fonts = OxmlElement("w:rFonts")
        r_pr.insert(0, r_fonts)
    for attr in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
        if qn(f"w:{attr}") in r_fonts.attrib:
            del r_fonts.attrib[qn(f"w:{attr}")]
    r_fonts.set(qn("w:ascii"), latin_font)
    r_fonts.set(qn("w:hAnsi"), latin_font)
    r_fonts.set(qn("w:cs"), latin_font)
    r_fonts.set(qn("w:eastAsia"), font_name)


def _set_indent_chars(paragraph: Paragraph, chars: float, font_size_pt: float) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    ind = p_pr.find(qn("w:ind"))
    if ind is None:
        ind = OxmlElement("w:ind")
        p_pr.append(ind)
    for attr in ("firstLine", "firstLineChars", "left", "leftChars", "hanging"):
        key = qn(f"w:{attr}")
        if key in ind.attrib:
            del ind.attrib[key]
    if chars > 0:
        ind.set(qn("w:firstLineChars"), str(int(round(chars * 100))))
        ind.set(qn("w:firstLine"), str(int(round(font_size_pt * chars * 20))))


def _set_right_indent_chars(
    paragraph: Paragraph, chars: float, font_size_pt: float
) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    ind = p_pr.find(qn("w:ind"))
    if ind is None:
        ind = OxmlElement("w:ind")
        p_pr.append(ind)
    for attr in ("right", "rightChars", "end", "endChars"):
        key = qn(f"w:{attr}")
        if key in ind.attrib:
            del ind.attrib[key]
    if chars > 0:
        ind.set(qn("w:rightChars"), str(int(round(chars * 100))))
        ind.set(qn("w:right"), str(int(round(font_size_pt * chars * 20))))


def _apply_layout(
    paragraph: Paragraph,
    alignment: int,
    line_pt: float,
    before_pt: float = 0,
    after_pt: float = 0,
    first_line_chars: float = 0,
    right_chars: float = 0,
    font_size_pt: float = 16,
) -> None:
    fmt = paragraph.paragraph_format
    fmt.alignment = alignment
    fmt.line_spacing = Pt(line_pt)
    fmt.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    fmt.space_before = Pt(before_pt)
    fmt.space_after = Pt(after_pt)
    _set_indent_chars(paragraph, first_line_chars, font_size_pt)
    _set_right_indent_chars(paragraph, right_chars, font_size_pt)


def _format_runs(
    paragraph: Paragraph,
    font_name: str,
    latin_font: str,
    size_pt: float,
    bold: bool | None = None,
) -> None:
    for run in paragraph.runs:
        _set_run_font(run, font_name, latin_font, size_pt, bold)


def _contains_special_inline_content(paragraph: Paragraph) -> bool:
    xml = paragraph._p.xml
    markers = (
        "<w:hyperlink",
        "<w:fldChar",
        "<w:instrText",
        "<w:drawing",
        "<w:object",
        "<w:commentRangeStart",
        "<w:bookmarkStart",
    )
    return any(marker in xml for marker in markers)


def _split_level2_heading_and_body(
    paragraph: Paragraph, profile: dict[str, Any]
) -> tuple[bool, str | None]:
    text = paragraph.text
    period_index = text.find("。")
    if period_index < 0 or period_index == len(text) - 1:
        return False, None
    if _contains_special_inline_content(paragraph):
        return False, "二级标题与正文同段，但含超链接、域或批注，已整段使用楷体并保留原结构。"
    heading_text = text[: period_index + 1]
    body_text = text[period_index + 1 :]
    for run in list(paragraph.runs):
        paragraph._p.remove(run._r)
    heading_run = paragraph.add_run(heading_text)
    body_run = paragraph.add_run(body_text)
    _set_run_font(
        heading_run,
        profile["fonts"]["heading2"],
        profile["fonts"]["latin"],
        profile["sizes_pt"]["heading"],
        False,
    )
    _set_run_font(
        body_run,
        profile["fonts"]["body"],
        profile["fonts"]["latin"],
        profile["sizes_pt"]["body"],
        False,
    )
    return True, None


def _set_table_borders(table: Table, profile: dict[str, Any]) -> None:
    tbl_pr = table._tbl.tblPr
    borders = tbl_pr.find(qn("w:tblBorders"))
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        tbl_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        element = borders.find(qn(f"w:{edge}"))
        if element is None:
            element = OxmlElement(f"w:{edge}")
            borders.append(element)
        element.set(qn("w:val"), "single")
        element.set(qn("w:sz"), str(profile["table"]["border_size_eighths_pt"]))
        element.set(qn("w:space"), "0")
        element.set(qn("w:color"), profile["table"]["border_color"])


def _set_table_cell_margins(table: Table, profile: dict[str, Any]) -> None:
    tbl_pr = table._tbl.tblPr
    cell_margins = tbl_pr.find(qn("w:tblCellMar"))
    if cell_margins is None:
        cell_margins = OxmlElement("w:tblCellMar")
        tbl_pr.append(cell_margins)
    for edge in ("top", "left", "bottom", "right"):
        element = cell_margins.find(qn(f"w:{edge}"))
        if element is None:
            element = OxmlElement(f"w:{edge}")
            cell_margins.append(element)
        element.set(
            qn("w:w"),
            str(profile["table"][f"cell_margin_{edge}_twips"]),
        )
        element.set(qn("w:type"), "dxa")


def _visual_units(text: str) -> int:
    return sum(2 if ord(character) > 127 else 1 for character in text.strip())


def _fit_table_to_page(table: Table, profile: dict[str, Any]) -> None:
    tbl = table._tbl
    grid = tbl.tblGrid
    columns = list(grid.gridCol_lst)
    if not columns:
        return
    usable_mm = (
        profile["page"]["width_mm"]
        - profile["page"]["margin_left_mm"]
        - profile["page"]["margin_right_mm"]
    )
    font_mm = profile["table"]["font_size_pt"] * 25.4 / 72
    padding_mm = (
        profile["table"]["cell_margin_left_twips"]
        + profile["table"]["cell_margin_right_twips"]
    ) * 25.4 / 1440
    desired_mm = [0.0] * len(columns)
    for row in table.rows:
        column_index = 0
        for tc in row._tr.tc_lst:
            tc_pr = tc.tcPr
            span_element = (
                tc_pr.find(qn("w:gridSpan")) if tc_pr is not None else None
            )
            span = (
                int(span_element.get(qn("w:val")))
                if span_element is not None
                else 1
            )
            if span == 1 and column_index < len(desired_mm):
                text = "".join(
                    node.text or "" for node in tc.findall(".//" + qn("w:t"))
                )
                desired = _visual_units(text) * font_mm / 2 + padding_mm
                desired_mm[column_index] = max(
                    desired_mm[column_index],
                    desired,
                )
            column_index += span
    minimum_mm = min(
        float(profile["table"]["minimum_column_mm"]),
        usable_mm / len(columns),
    )
    desired_mm = [
        min(max(value, minimum_mm), usable_mm * 0.45)
        for value in desired_mm
    ]
    desired_total = sum(desired_mm)
    if desired_total <= 0:
        desired_mm = [usable_mm / len(columns)] * len(columns)
    else:
        desired_mm = [
            value / desired_total * usable_mm for value in desired_mm
        ]
    widths_twips = [
        max(1, int(round(value * 1440 / 25.4))) for value in desired_mm
    ]
    difference = int(round(usable_mm * 1440 / 25.4)) - sum(widths_twips)
    widths_twips[-1] += difference
    for column, width in zip(columns, widths_twips):
        column.set(qn("w:w"), str(width))

    tbl_pr = tbl.tblPr
    tbl_width = tbl_pr.find(qn("w:tblW"))
    if tbl_width is None:
        tbl_width = OxmlElement("w:tblW")
        tbl_pr.append(tbl_width)
    tbl_width.set(qn("w:w"), str(sum(widths_twips)))
    tbl_width.set(qn("w:type"), "dxa")
    layout = tbl_pr.find(qn("w:tblLayout"))
    if layout is None:
        layout = OxmlElement("w:tblLayout")
        tbl_pr.append(layout)
    layout.set(qn("w:type"), "fixed")

    for row in table.rows:
        column_index = 0
        for tc in row._tr.tc_lst:
            tc_pr = tc.get_or_add_tcPr()
            span_element = tc_pr.find(qn("w:gridSpan"))
            span = (
                int(span_element.get(qn("w:val")))
                if span_element is not None
                else 1
            )
            width = sum(widths_twips[column_index : column_index + span])
            tc_width = tc_pr.find(qn("w:tcW"))
            if tc_width is None:
                tc_width = OxmlElement("w:tcW")
                tc_pr.append(tc_width)
            tc_width.set(qn("w:w"), str(width))
            tc_width.set(qn("w:type"), "dxa")
            column_index += span


def _mark_repeat_header(row: Any) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    if tr_pr.find(qn("w:tblHeader")) is None:
        tr_pr.append(OxmlElement("w:tblHeader"))


def _format_table(table: Table, profile: dict[str, Any]) -> None:
    _set_table_borders(table, profile)
    _set_table_cell_margins(table, profile)
    if profile["table"]["fit_to_usable_width"]:
        _fit_table_to_page(table, profile)
    for row_index, row in enumerate(table.rows):
        if row_index == 0 and profile["table"]["repeat_header_row"]:
            _mark_repeat_header(row)
        header = row_index == 0
        font_name = (
            profile["table"]["header_font"]
            if header
            else profile["table"]["body_font"]
        )
        for cell in row.cells:
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            for paragraph in cell.paragraphs:
                paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
                fmt = paragraph.paragraph_format
                fmt.line_spacing_rule = WD_LINE_SPACING.SINGLE
                fmt.space_before = Pt(0)
                fmt.space_after = Pt(0)
                _set_indent_chars(paragraph, 0, profile["table"]["font_size_pt"])
                _format_runs(
                    paragraph,
                    font_name,
                    profile["table"]["latin_font"],
                    profile["table"]["font_size_pt"],
                    profile["table"]["header_bold"] if header else None,
                )


def _apply_page_setup(doc: DocumentObject, profile: dict[str, Any]) -> None:
    page = profile["page"]
    for section in doc.sections:
        section.orientation = WD_ORIENT.PORTRAIT
        section.page_width = Mm(page["width_mm"])
        section.page_height = Mm(page["height_mm"])
        section.top_margin = Mm(page["margin_top_mm"])
        section.bottom_margin = Mm(page["margin_bottom_mm"])
        section.left_margin = Mm(page["margin_left_mm"])
        section.right_margin = Mm(page["margin_right_mm"])


def format_document(
    doc: DocumentObject,
    profile: dict[str, Any],
    requested_type: str = "auto",
    title_line_count: int = 1,
) -> dict[str, Any]:
    before = document_signature(doc)
    classification = classify_document(doc, requested_type, title_line_count)
    roles = classification["roles"]
    warnings: list[str] = []
    formatted_paragraphs = 0
    split_paragraphs = 0

    _apply_page_setup(doc, profile)
    fonts = profile["fonts"]
    sizes = profile["sizes_pt"]
    paragraph_profile = profile["paragraph"]

    for index, paragraph in enumerate(doc.paragraphs):
        if not paragraph.text.strip():
            continue
        role = roles[index]
        if role == "title":
            _format_runs(
                paragraph,
                fonts["title"],
                fonts["latin"],
                sizes["title"],
                False,
            )
            _apply_layout(
                paragraph,
                WD_ALIGN_PARAGRAPH.CENTER,
                paragraph_profile["body_line_pt"],
                paragraph_profile["title_space_before_pt"],
                paragraph_profile["title_space_after_pt"],
                0,
                0,
                sizes["title"],
            )
        elif role == "recipient":
            _format_runs(
                paragraph, fonts["body"], fonts["latin"], sizes["body"], None
            )
            _apply_layout(
                paragraph,
                WD_ALIGN_PARAGRAPH.LEFT,
                paragraph_profile["body_line_pt"],
                font_size_pt=sizes["body"],
            )
        elif role == "metadata":
            _format_runs(
                paragraph, fonts["body"], fonts["latin"], sizes["body"], None
            )
            _apply_layout(
                paragraph,
                WD_ALIGN_PARAGRAPH.LEFT,
                paragraph_profile["body_line_pt"],
                font_size_pt=sizes["body"],
            )
        elif role in {"heading1", "heading2", "heading3", "heading4"}:
            heading_font = fonts[role]
            heading_bold = role == "heading3"
            split = False
            if role == "heading2":
                split, warning = _split_level2_heading_and_body(paragraph, profile)
                if split:
                    split_paragraphs += 1
                    warning = None
                elif warning:
                    warnings.append(f"第{index + 1}段：{warning}")
            if not split:
                _format_runs(
                    paragraph,
                    heading_font,
                    fonts["latin"],
                    sizes["heading"],
                    heading_bold,
                )
            _apply_layout(
                paragraph,
                WD_ALIGN_PARAGRAPH.JUSTIFY,
                paragraph_profile["body_line_pt"],
                first_line_chars=paragraph_profile["first_line_chars"],
                font_size_pt=sizes["heading"],
            )
            if _is_standalone_heading(paragraph.text):
                paragraph.paragraph_format.keep_with_next = True
            else:
                paragraph.paragraph_format.keep_with_next = False
        elif role == "table_caption":
            _format_runs(
                paragraph,
                fonts["body"],
                fonts["latin"],
                sizes["body"],
                True,
            )
            _apply_layout(
                paragraph,
                WD_ALIGN_PARAGRAPH.CENTER,
                paragraph_profile["body_line_pt"],
                font_size_pt=sizes["body"],
            )
            paragraph.paragraph_format.keep_with_next = True
        elif role == "signature":
            _format_runs(
                paragraph,
                fonts["body"],
                fonts["latin"],
                sizes["signature"],
                None,
            )
            _apply_layout(
                paragraph,
                WD_ALIGN_PARAGRAPH.RIGHT,
                paragraph_profile["body_line_pt"],
                paragraph_profile["signature_space_before_pt"],
                0,
                0,
                paragraph_profile["signature_right_chars"],
                sizes["signature"],
            )
            paragraph.paragraph_format.keep_with_next = True
        elif role == "date":
            _format_runs(
                paragraph, fonts["body"], fonts["latin"], sizes["date"], None
            )
            _apply_layout(
                paragraph,
                WD_ALIGN_PARAGRAPH.RIGHT,
                paragraph_profile["body_line_pt"],
                0,
                0,
                0,
                paragraph_profile["date_right_chars"],
                sizes["date"],
            )
        else:
            _format_runs(
                paragraph, fonts["body"], fonts["latin"], sizes["body"], None
            )
            _apply_layout(
                paragraph,
                WD_ALIGN_PARAGRAPH.JUSTIFY,
                paragraph_profile["body_line_pt"],
                first_line_chars=paragraph_profile["first_line_chars"],
                font_size_pt=sizes["body"],
            )
        formatted_paragraphs += 1

    if (
        classification["signature_index"] is not None
        and classification["date_index"] is not None
    ):
        signature_index = classification["signature_index"]
        for index in range(signature_index - 1, -1, -1):
            if not doc.paragraphs[index].text.strip():
                continue
            if roles[index] in {"heading1", "heading2", "heading3", "heading4"}:
                break
            if (
                _is_closing(doc.paragraphs[index].text)
                or len(doc.paragraphs[index].text.strip()) <= 50
            ):
                doc.paragraphs[index].paragraph_format.keep_with_next = True
            break

    for table in doc.tables:
        _format_table(table, profile)

    after = document_signature(doc)
    text_equal = before == after
    if not text_equal:
        raise FormalDocumentError("排版后正文、表格或页眉页脚的结构发生变化，已停止输出。")

    return {
        "classification": classification,
        "role_counts": {
            role: sum(
                1
                for index, assigned_role in enumerate(roles)
                if assigned_role == role
                and doc.paragraphs[index].text.strip()
            )
            for role in sorted(set(roles))
        },
        "before": before,
        "after": after,
        "content_hash_before": signature_hash(before),
        "content_hash_after": signature_hash(after),
        "content_integrity": True,
        "formatted_paragraphs": formatted_paragraphs,
        "formatted_tables": len(doc.tables),
        "split_level2_paragraphs": split_paragraphs,
        "warnings": warnings,
    }


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def save_docx_atomic(doc: DocumentObject, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{path.stem}.", suffix=".docx", dir=path.parent
    )
    os.close(fd)
    try:
        doc.save(temp_name)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def format_file(
    input_path: Path,
    output_path: Path,
    profile_path: Path | None = None,
    requested_type: str = "auto",
    overwrite: bool = False,
    strict: bool = False,
    title_line_count: int = 1,
) -> dict[str, Any]:
    if input_path.resolve() == output_path.resolve():
        raise FormalDocumentError("输出路径必须与输入路径不同，以保留原件。")
    if output_path.exists() and not overwrite:
        raise FormalDocumentError(f"输出文件已存在：{output_path}。如需覆盖，请加 --overwrite。")
    profile = load_profile(profile_path)
    package_warnings = inspect_package(input_path)
    if strict and package_warnings:
        raise FormalDocumentError(
            "严格模式发现不受支持的结构，未开始排版：" + "；".join(package_warnings)
        )
    try:
        doc = Document(str(input_path))
    except Exception as exc:
        raise FormalDocumentError("无法打开 DOCX。请先解除密码保护并确认文件未损坏。") from exc
    result = format_document(
        doc, profile, requested_type, title_line_count=title_line_count
    )
    save_docx_atomic(doc, output_path)
    report = {
        "schema_version": 1,
        "tool_version": TOOL_VERSION,
        "status": "success",
        "input": str(input_path),
        "output": str(output_path),
        "profile": profile["name"],
        "document_type": result["classification"]["doc_type"],
        "content_integrity": {
            "passed": result["content_integrity"],
            "hash_before": result["content_hash_before"],
            "hash_after": result["content_hash_after"],
            "paragraphs": sum(
                1
                for block in result["before"]["blocks"]
                if block["kind"] == "paragraph" and block["text"].strip()
            ),
            "tables": sum(
                1 for block in result["before"]["blocks"] if block["kind"] == "table"
            ),
        },
        "changes": {
            "sections": result["before"]["sections"],
            "paragraphs_formatted": result["formatted_paragraphs"],
            "tables_formatted": result["formatted_tables"],
            "level2_paragraphs_split": result["split_level2_paragraphs"],
        },
        "structure_detection": {
            "role_counts": result["role_counts"],
            "numbered_body_items": result["role_counts"].get("body_item", 0),
        },
        "warnings": package_warnings + result["warnings"],
        "strict": strict,
        "title_lines": max(1, title_line_count),
    }
    return report


def _run_east_asia_font(run: Any) -> str | None:
    r_pr = run._element.rPr
    if r_pr is None or r_pr.rFonts is None:
        return None
    return r_pr.rFonts.get(qn("w:eastAsia"))


def _paragraph_indent_value(paragraph: Paragraph, attribute: str) -> int:
    p_pr = paragraph._p.pPr
    if p_pr is None:
        return 0
    ind = p_pr.find(qn("w:ind"))
    if ind is None:
        return 0
    value = ind.get(qn(f"w:{attribute}"))
    return int(value) if value is not None else 0


def _paragraph_expected_font(
    role: str, profile: dict[str, Any]
) -> str:
    mapping = {
        "title": profile["fonts"]["title"],
        "recipient": profile["fonts"]["body"],
        "metadata": profile["fonts"]["body"],
        "heading1": profile["fonts"]["heading1"],
        "heading2": profile["fonts"]["heading2"],
        "heading3": profile["fonts"]["heading3"],
        "heading4": profile["fonts"]["heading4"],
        "body_item": profile["fonts"]["body"],
        "table_caption": profile["fonts"]["body"],
        "signature": profile["fonts"]["body"],
        "date": profile["fonts"]["body"],
        "body": profile["fonts"]["body"],
    }
    return mapping[role]


def _check_item(
    checks: list[dict[str, Any]],
    name: str,
    passed: bool,
    evidence: str,
) -> None:
    checks.append({"name": name, "passed": bool(passed), "evidence": evidence})


def verify_document(
    formatted_path: Path,
    reference_path: Path | None,
    profile_path: Path | None = None,
    title_line_count: int = 1,
) -> dict[str, Any]:
    profile = load_profile(profile_path)
    try:
        formatted = Document(str(formatted_path))
    except Exception as exc:
        raise FormalDocumentError("无法打开待核验 DOCX。") from exc
    checks: list[dict[str, Any]] = []

    if reference_path is not None:
        try:
            reference = Document(str(reference_path))
        except Exception as exc:
            raise FormalDocumentError("无法打开参考 DOCX。") from exc
        ref_sig = document_signature(reference)
        out_sig = document_signature(formatted)
        _check_item(
            checks,
            "正文与关键结构一致",
            ref_sig == out_sig,
            f"reference={signature_hash(ref_sig)[:12]}, formatted={signature_hash(out_sig)[:12]}",
        )

    page = profile["page"]
    page_ok = True
    page_evidence: list[str] = []
    for index, section in enumerate(formatted.sections):
        values = {
            "width_mm": round(section.page_width.mm, 1),
            "height_mm": round(section.page_height.mm, 1),
            "top_mm": round(section.top_margin.mm, 1),
            "bottom_mm": round(section.bottom_margin.mm, 1),
            "left_mm": round(section.left_margin.mm, 1),
            "right_mm": round(section.right_margin.mm, 1),
        }
        expected = {
            "width_mm": page["width_mm"],
            "height_mm": page["height_mm"],
            "top_mm": page["margin_top_mm"],
            "bottom_mm": page["margin_bottom_mm"],
            "left_mm": page["margin_left_mm"],
            "right_mm": page["margin_right_mm"],
        }
        section_ok = all(abs(values[key] - expected[key]) <= 0.2 for key in expected)
        page_ok = page_ok and section_ok
        page_evidence.append(f"section {index + 1}: {'ok' if section_ok else values}")
    _check_item(checks, "页面与页边距", page_ok, "; ".join(page_evidence))

    classification = classify_document(
        formatted,
        infer_document_type(formatted, title_line_count),
        title_line_count=title_line_count,
    )
    roles = classification["roles"]
    font_failures: list[str] = []
    size_failures: list[str] = []
    bold_failures: list[str] = []
    paragraph_layout_failures: list[str] = []
    spacing_failures: list[str] = []
    indent_failures: list[str] = []
    alignment_failures: list[str] = []
    expected_line = float(profile["paragraph"]["body_line_pt"])
    expected_sizes = {
        "title": profile["sizes_pt"]["title"],
        "recipient": profile["sizes_pt"]["body"],
        "metadata": profile["sizes_pt"]["body"],
        "heading1": profile["sizes_pt"]["heading"],
        "heading2": profile["sizes_pt"]["heading"],
        "heading3": profile["sizes_pt"]["heading"],
        "heading4": profile["sizes_pt"]["heading"],
        "body_item": profile["sizes_pt"]["body"],
        "table_caption": profile["sizes_pt"]["body"],
        "signature": profile["sizes_pt"]["signature"],
        "date": profile["sizes_pt"]["date"],
        "body": profile["sizes_pt"]["body"],
    }
    expected_alignment = {
        "title": WD_ALIGN_PARAGRAPH.CENTER,
        "recipient": WD_ALIGN_PARAGRAPH.LEFT,
        "metadata": WD_ALIGN_PARAGRAPH.LEFT,
        "heading1": WD_ALIGN_PARAGRAPH.JUSTIFY,
        "heading2": WD_ALIGN_PARAGRAPH.JUSTIFY,
        "heading3": WD_ALIGN_PARAGRAPH.JUSTIFY,
        "heading4": WD_ALIGN_PARAGRAPH.JUSTIFY,
        "body_item": WD_ALIGN_PARAGRAPH.JUSTIFY,
        "table_caption": WD_ALIGN_PARAGRAPH.CENTER,
        "signature": WD_ALIGN_PARAGRAPH.RIGHT,
        "date": WD_ALIGN_PARAGRAPH.RIGHT,
        "body": WD_ALIGN_PARAGRAPH.JUSTIFY,
    }
    for index, paragraph in enumerate(formatted.paragraphs):
        text = paragraph.text.strip()
        if not text:
            continue
        role = roles[index]
        expected_font = _paragraph_expected_font(role, profile)
        actual_fonts = {
            _run_east_asia_font(run)
            for run in paragraph.runs
            if run.text.strip()
        }
        expected_fonts = {expected_font}
        if role == "heading2" and "。" in paragraph.text[:-1]:
            expected_fonts.add(profile["fonts"]["body"])
            if len(expected_fonts) > 1 and actual_fonts != expected_fonts:
                font_failures.append(
                    f"第{index + 1}段 role=heading2 同段标题正文未分别使用两种字体 fonts={sorted(actual_fonts)}"
                )
        elif not actual_fonts or actual_fonts != expected_fonts:
            font_failures.append(f"第{index + 1}段 role={role} fonts={sorted(actual_fonts)}")
        actual_sizes = {
            round(run.font.size.pt, 1)
            for run in paragraph.runs
            if run.text.strip() and run.font.size is not None
        }
        if actual_sizes != {round(float(expected_sizes[role]), 1)}:
            size_failures.append(
                f"第{index + 1}段 role={role} sizes={sorted(actual_sizes)}"
            )
        expected_bold = {
            "title": False,
            "heading1": False,
            "heading2": False,
            "heading3": True,
            "heading4": False,
            "table_caption": True,
        }.get(role)
        if role == "heading2" and "。" in paragraph.text[:-1]:
            expected_bold = None
        if expected_bold is not None:
            actual_bold = {
                bool(run.bold)
                for run in paragraph.runs
                if run.text.strip()
            }
            if actual_bold != {expected_bold}:
                bold_failures.append(
                    f"第{index + 1}段 role={role} bold={sorted(actual_bold)}"
                )
        line = paragraph.paragraph_format.line_spacing
        if line is None or abs(line.pt - expected_line) > 0.3:
            paragraph_layout_failures.append(
                f"第{index + 1}段 line={getattr(line, 'pt', None)}"
            )
        if paragraph.paragraph_format.alignment != expected_alignment[role]:
            alignment_failures.append(
                f"第{index + 1}段 role={role} alignment={paragraph.paragraph_format.alignment}"
            )
        expected_before = (
            profile["paragraph"]["title_space_before_pt"]
            if role == "title"
            else profile["paragraph"]["signature_space_before_pt"]
            if role == "signature"
            else 0
        )
        expected_after = (
            profile["paragraph"]["title_space_after_pt"]
            if role == "title"
            else 0
        )
        actual_before = paragraph.paragraph_format.space_before
        actual_after = paragraph.paragraph_format.space_after
        actual_before_pt = actual_before.pt if actual_before is not None else None
        actual_after_pt = actual_after.pt if actual_after is not None else None
        if (
            actual_before_pt is None
            or abs(actual_before_pt - expected_before) > 0.3
            or actual_after_pt is None
            or abs(actual_after_pt - expected_after) > 0.3
        ):
            spacing_failures.append(
                f"第{index + 1}段 role={role} before={actual_before_pt} after={actual_after_pt}"
            )
        if (
            role in {"heading1", "heading2", "heading3", "heading4"}
            and _is_standalone_heading(text)
        ) or role in {"signature", "table_caption"}:
            if paragraph.paragraph_format.keep_with_next is not True:
                paragraph_layout_failures.append(
                    f"第{index + 1}段 role={role} 未设置 keep_with_next"
                )
        expected_first = (
            int(profile["paragraph"]["first_line_chars"] * 100)
            if role in {"body", "body_item", "heading1", "heading2", "heading3", "heading4"}
            else 0
        )
        expected_right = {
            "signature": int(profile["paragraph"]["signature_right_chars"] * 100),
            "date": int(profile["paragraph"]["date_right_chars"] * 100),
        }.get(role, 0)
        actual_first = _paragraph_indent_value(paragraph, "firstLineChars")
        actual_right = _paragraph_indent_value(paragraph, "rightChars")
        if actual_first != expected_first or actual_right != expected_right:
            indent_failures.append(
                f"第{index + 1}段 role={role} first={actual_first} right={actual_right}"
            )
    _check_item(
        checks,
        "段落字体",
        not font_failures,
        "全部通过" if not font_failures else "; ".join(font_failures[:8]),
    )
    _check_item(
        checks,
        "字号",
        not size_failures,
        "全部通过" if not size_failures else "; ".join(size_failures[:8]),
    )
    _check_item(
        checks,
        "标题字重",
        not bold_failures,
        "全部通过" if not bold_failures else "; ".join(bold_failures[:8]),
    )
    _check_item(
        checks,
        "固定行距",
        not paragraph_layout_failures,
        "全部通过"
        if not paragraph_layout_failures
        else "; ".join(paragraph_layout_failures[:8]),
    )
    _check_item(
        checks,
        "段前段后间距",
        not spacing_failures,
        "全部通过" if not spacing_failures else "; ".join(spacing_failures[:8]),
    )
    _check_item(
        checks,
        "对齐",
        not alignment_failures,
        "全部通过" if not alignment_failures else "; ".join(alignment_failures[:8]),
    )
    _check_item(
        checks,
        "首行与右侧缩进",
        not indent_failures,
        "全部通过" if not indent_failures else "; ".join(indent_failures[:8]),
    )

    table_failures: list[str] = []
    table_layout_failures: list[str] = []
    usable_twips = int(
        round(
            (
                page["width_mm"]
                - page["margin_left_mm"]
                - page["margin_right_mm"]
            )
            * 1440
            / 25.4
        )
    )
    for table_index, table in enumerate(formatted.tables):
        if profile["table"]["fit_to_usable_width"]:
            tbl_pr = table._tbl.tblPr
            tbl_width = tbl_pr.find(qn("w:tblW"))
            actual_width = (
                int(tbl_width.get(qn("w:w")))
                if tbl_width is not None and tbl_width.get(qn("w:w"))
                else None
            )
            grid_widths = [
                int(column.get(qn("w:w")))
                for column in table._tbl.tblGrid.gridCol_lst
                if column.get(qn("w:w"))
            ]
            if actual_width != usable_twips or sum(grid_widths) != usable_twips:
                table_layout_failures.append(
                    f"table {table_index + 1} width={actual_width} grid_sum={sum(grid_widths)} usable={usable_twips}"
                )
        tbl_pr = table._tbl.tblPr
        cell_margins = tbl_pr.find(qn("w:tblCellMar"))
        for edge in ("top", "bottom", "left", "right"):
            expected = str(profile["table"][f"cell_margin_{edge}_twips"])
            element = (
                cell_margins.find(qn(f"w:{edge}"))
                if cell_margins is not None
                else None
            )
            if element is None or element.get(qn("w:w")) != expected:
                table_layout_failures.append(
                    f"table {table_index + 1} missing cell margin {edge}"
                )
        borders = tbl_pr.find(qn("w:tblBorders"))
        for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
            element = (
                borders.find(qn(f"w:{edge}"))
                if borders is not None
                else None
            )
            if (
                element is None
                or element.get(qn("w:val")) != "single"
                or element.get(qn("w:sz"))
                != str(profile["table"]["border_size_eighths_pt"])
                or element.get(qn("w:color"))
                != profile["table"]["border_color"]
            ):
                table_layout_failures.append(
                    f"table {table_index + 1} border {edge} invalid"
                )
        for row_index, row in enumerate(table.rows):
            expected_font = (
                profile["table"]["header_font"]
                if row_index == 0
                else profile["table"]["body_font"]
            )
            for cell_index, cell in enumerate(row.cells):
                if cell.vertical_alignment != WD_CELL_VERTICAL_ALIGNMENT.CENTER:
                    table_failures.append(
                        f"table {table_index + 1} row {row_index + 1} cell {cell_index + 1} vertical alignment"
                    )
                for paragraph in cell.paragraphs:
                    if paragraph.alignment != WD_ALIGN_PARAGRAPH.CENTER:
                        table_failures.append(
                            f"table {table_index + 1} row {row_index + 1} cell {cell_index + 1} paragraph alignment"
                        )
                    for run in paragraph.runs:
                        actual_font = _run_east_asia_font(run)
                        if run.text.strip() and actual_font != expected_font:
                            table_failures.append(
                                f"table {table_index + 1} row {row_index + 1} cell {cell_index + 1}"
                            )
                            break
    _check_item(
        checks,
        "表格字体",
        not table_failures,
        "全部通过" if not table_failures else "; ".join(table_failures[:8]),
    )
    _check_item(
        checks,
        "表格宽度与单元格留白",
        not table_layout_failures,
        "全部通过"
        if not table_layout_failures
        else "; ".join(table_layout_failures[:8]),
    )

    passed = all(check["passed"] for check in checks)
    return {
        "schema_version": 1,
        "tool_version": TOOL_VERSION,
        "status": "passed" if passed else "failed",
        "formatted": str(formatted_path),
        "reference": str(reference_path) if reference_path else None,
        "profile": profile["name"],
        "document_type": classification["doc_type"],
        "structure_detection": {
            "role_counts": {
                role: sum(
                    1
                    for index, assigned_role in enumerate(roles)
                    if assigned_role == role
                    and formatted.paragraphs[index].text.strip()
                )
                for role in sorted(set(roles))
            }
        },
        "checks": checks,
        "warnings": inspect_package(formatted_path),
    }
