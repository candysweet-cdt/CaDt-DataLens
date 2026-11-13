from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from formal_docx_core import TOOL_VERSION  # noqa: E402


class SkillMetadataTests(unittest.TestCase):
    def test_name_version_and_triggers(self) -> None:
        skill_text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        frontmatter = skill_text.split("---", 2)[1]
        self.assertIn("name: chinese-formal-document-format", frontmatter)
        description = next(
            line.split(":", 1)[1].strip()
            for line in frontmatter.splitlines()
            if line.startswith("description:")
        )
        for trigger in ("排版", "整理格式", "调格式", "公文", "方案", "函", "会议纪要"):
            self.assertIn(trigger, description)
        self.assertLessEqual(len(description), 1024)
        self.assertIn("鼓翼成长星球", skill_text)
        self.assertIn(
            "鼓翼成长星球",
            (ROOT / "README.md").read_text(encoding="utf-8"),
        )
        version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        self.assertEqual(TOOL_VERSION, version)

    def test_iteration_history_is_retained(self) -> None:
        history = (ROOT / "docs" / "iterations.md").read_text(encoding="utf-8")
        changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
        for version in (
            "0.9.0",
            "1.0.0",
            "1.0.1",
            "1.1.0",
            "1.1.1",
            "1.1.2",
            "1.2.0",
            "1.3.0",
        ):
            self.assertIn(version, history)
            self.assertIn(version, changelog)

    def test_chinese_user_guides_exist_alongside_english_sources(self) -> None:
        reference_dir = ROOT / "references"
        for name in (
            "runtime-notes",
            "customization",
            "format-spec",
            "document-structures",
            "conservative-rules",
        ):
            english = reference_dir / f"{name}.md"
            chinese = reference_dir / f"{name}.zh-CN.md"
            self.assertTrue(english.is_file(), f"missing {english.name}")
            self.assertTrue(chinese.is_file(), f"missing {chinese.name}")
            self.assertRegex(
                chinese.read_text(encoding="utf-8"),
                r"[\u4e00-\u9fff]",
            )
        self.assertIn("中文正式文档排版", (ROOT / "README.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
