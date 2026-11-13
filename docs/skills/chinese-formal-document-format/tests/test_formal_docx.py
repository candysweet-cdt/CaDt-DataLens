from __future__ import annotations

import sys
import tempfile
import unittest
from base64 import b64decode
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Pt

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from formal_docx_core import (  # noqa: E402
    FormalDocumentError,
    classify_document,
    document_signature,
    format_document,
    format_file,
    load_profile,
    table_signature,
    verify_document,
)


class ChineseFormalDocumentFormattingTests(unittest.TestCase):
    def make_document(self, path: Path) -> None:
        doc = Document()
        doc.add_paragraph("关于测试工作的报告").alignment = 1
        doc.add_paragraph("测试集团：")
        doc.add_paragraph("现将有关情况报告如下。")
        doc.add_paragraph("一、总体情况")
        doc.add_paragraph("（一）工作进展。本季度完成率达到95%。")
        doc.add_paragraph("（二）存在问题")
        doc.add_paragraph("1、部分事项仍需协调。")
        table = doc.add_table(rows=2, cols=3)
        table.style = "Table Grid"
        for row_index, values in enumerate(
            (
                ("序号", "事项", "状态"),
                ("1", "测试任务", "完成"),
            )
        ):
            for column_index, value in enumerate(values):
                table.cell(row_index, column_index).text = value
        table.cell(1, 1).merge(table.cell(1, 2))
        doc.add_paragraph("特此报告。")
        doc.add_paragraph("测试集团有限公司")
        doc.add_paragraph("2026年10月23日")
        for paragraph in doc.paragraphs:
            for run in paragraph.runs:
                run.font.size = Pt(11)
        doc.save(path)

    def test_format_preserves_content_and_structure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = temp / "source.docx"
            output = temp / "formatted.docx"
            self.make_document(source)

            original = Document(source)
            before = document_signature(original)
            result = format_document(original, load_profile())
            self.assertTrue(result["content_integrity"])
            self.assertEqual(before, result["after"])
            self.assertEqual(result["classification"]["doc_type"], "report")
            self.assertEqual(result["classification"]["roles"].count("signature"), 1)
            self.assertEqual(result["classification"]["roles"].count("date"), 1)
            self.assertEqual(result["split_level2_paragraphs"], 1)

            report = format_file(source, output)
            self.assertTrue(report["content_integrity"]["passed"])
            verification = verify_document(output, source)
            self.assertEqual(verification["status"], "passed")

    def test_refuses_to_overwrite_the_source(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "source.docx"
            self.make_document(source)
            with self.assertRaises(FormalDocumentError):
                format_file(source, source)

    def test_refuses_unknown_binary_as_docx(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "broken.docx"
            output = Path(temp_dir) / "formatted.docx"
            source.write_bytes(b"not a docx")
            with self.assertRaises(FormalDocumentError):
                format_file(source, output)

    def test_multi_paragraph_title(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = temp / "multi-title.docx"
            output = temp / "multi-title-formatted.docx"
            doc = Document()
            doc.add_paragraph("关于数字化转型工作的")
            doc.add_paragraph("情况报告")
            doc.add_paragraph("测试集团：")
            doc.add_paragraph("现将有关情况报告如下。")
            doc.add_paragraph("测试集团有限公司")
            doc.add_paragraph("2026年10月23日")
            doc.save(source)
            report = format_file(source, output, title_line_count=2)
            self.assertTrue(report["content_integrity"]["passed"])
            self.assertEqual(report["document_type"], "report")
            verification = verify_document(
                output,
                source,
                title_line_count=2,
            )
            self.assertEqual(verification["status"], "passed")

    def test_strict_mode_rejects_content_control_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = temp / "source.docx"
            strict_source = temp / "with-control.docx"
            output = temp / "formatted.docx"
            self.make_document(source)
            with ZipFile(source) as original, ZipFile(
                strict_source, "w", ZIP_DEFLATED
            ) as patched:
                for item in original.infolist():
                    payload = original.read(item.filename)
                    if item.filename == "word/document.xml":
                        payload = payload.replace(
                            b"</w:body>", b"<w:sdt/></w:body>"
                        )
                    patched.writestr(item, payload)
            with self.assertRaises(FormalDocumentError):
                format_file(strict_source, output, strict=True)
            self.assertFalse(output.exists())

    def test_table_caption_and_custom_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = temp / "caption.docx"
            output = temp / "caption-formatted.docx"
            profile = ROOT / "profiles" / "example-org.json"
            doc = Document()
            doc.add_paragraph("测试报告")
            doc.add_paragraph("表1 任务完成情况")
            table = doc.add_table(rows=2, cols=2)
            table.cell(0, 0).text = "事项"
            table.cell(0, 1).text = "状态"
            table.cell(1, 0).text = "测试"
            table.cell(1, 1).text = "完成"
            doc.add_paragraph("测试集团有限公司")
            doc.add_paragraph("2026年10月23日")
            doc.save(source)
            classification = classify_document(Document(source))
            self.assertIn("table_caption", classification["roles"])
            report = format_file(source, output, profile_path=profile)
            self.assertTrue(report["content_integrity"]["passed"])
            verification = verify_document(output, source, profile_path=profile)
            self.assertEqual(verification["status"], "passed")

    def test_merged_and_unmerged_tables_have_different_signatures(self) -> None:
        docs: list[Document] = []
        for merged in (False, True):
            doc = Document()
            table = doc.add_table(rows=2, cols=2)
            for row in range(2):
                for column in range(2):
                    table.cell(row, column).text = f"R{row}C{column}"
            if merged:
                table.cell(1, 0).merge(table.cell(1, 1))
            docs.append(doc)
        self.assertNotEqual(
            table_signature(docs[0].tables[0]),
            table_signature(docs[1].tables[0]),
        )

    def test_letter_header_footer_and_image_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = temp / "letter.docx"
            output = temp / "letter-formatted.docx"
            doc = Document()
            doc.sections[0].header.paragraphs[0].text = "内部资料"
            doc.sections[0].footer.paragraphs[0].text = "仅供沟通"
            doc.add_paragraph("关于项目合作的函")
            doc.add_paragraph("合作单位：")
            doc.add_paragraph("现将有关合作事项函告如下。")
            doc.add_paragraph("（一）合作范围。双方在测试范围内开展合作。")
            one_pixel_png = b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
                "/A8AAQUBAScY42YAAAAASUVORK5CYII="
            )
            doc.add_picture(BytesIO(one_pixel_png))
            doc.add_paragraph("测试集团有限公司")
            doc.add_paragraph("2026年10月23日")
            doc.save(source)
            report = format_file(source, output)
            self.assertEqual(report["document_type"], "letter")
            self.assertTrue(report["content_integrity"]["passed"])
            verification = verify_document(output, source)
            self.assertEqual(verification["status"], "passed")

    def test_bundled_examples_end_to_end(self) -> None:
        examples = ROOT / "examples" / "before"
        for source in sorted(examples.glob("*.docx")):
            with self.subTest(source=source.name), tempfile.TemporaryDirectory() as temp_dir:
                output = Path(temp_dir) / source.name
                report = format_file(source, output, strict=True)
                self.assertTrue(report["content_integrity"]["passed"])
                verification = verify_document(output, source)
                self.assertEqual(verification["status"], "passed")

    def test_numbered_sentence_is_body_not_heading(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = temp / "numbered.docx"
            output = temp / "numbered-formatted.docx"
            doc = Document()
            doc.add_paragraph("关于事项安排的说明")
            doc.add_paragraph("一、总体安排")
            doc.add_paragraph("1. 完成情况")
            doc.add_paragraph("1. 由市场部牵头，于10月25日前形成重点客户清单。")
            doc.add_paragraph("2. 由财务部牵头，于10月22日前完成账款分类。")
            doc.add_paragraph("测试集团有限公司")
            doc.add_paragraph("2026年10月23日")
            doc.save(source)

            classification = classify_document(Document(source))
            self.assertEqual(classification["roles"][2], "heading3")
            self.assertEqual(classification["roles"][3], "body_item")
            self.assertEqual(classification["roles"][4], "body_item")

            report = format_file(source, output)
            self.assertTrue(report["content_integrity"]["passed"])
            self.assertEqual(
                report["structure_detection"]["numbered_body_items"],
                2,
            )
            formatted = Document(output)
            heading_run = formatted.paragraphs[2].runs[0]
            item_run = formatted.paragraphs[3].runs[0]
            self.assertEqual(
                heading_run._element.rPr.rFonts.get(qn("w:eastAsia")),
                "仿宋_GB2312",
            )
            self.assertTrue(heading_run.bold)
            self.assertEqual(
                item_run._element.rPr.rFonts.get(qn("w:eastAsia")),
                "仿宋_GB2312",
            )
            self.assertFalse(bool(item_run.bold))
            self.assertEqual(verify_document(output, source)["status"], "passed")


if __name__ == "__main__":
    unittest.main()
