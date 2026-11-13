#!/usr/bin/env python3
"""Conservatively format a DOCX without changing any words."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from formal_docx_core import (
    FormalDocumentError,
    format_file,
    write_json_atomic,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="按参考版中文正式文档样式排版 DOCX，正文内容保持不变。"
    )
    parser.add_argument("input", type=Path, help="输入 .docx 文件")
    parser.add_argument("output", type=Path, help="输出 .docx 文件，必须不同于输入")
    parser.add_argument(
        "--profile",
        type=Path,
        help="可选 JSON 样式覆盖文件；默认使用 profiles/default.json",
    )
    parser.add_argument(
        "--doc-type",
        choices=["auto", "report", "plan", "letter", "minutes", "generic"],
        default="auto",
        help="文种；默认自动识别",
    )
    parser.add_argument(
        "--report",
        type=Path,
        help="格式核验报告路径；默认输出到 <output>.format-report.json",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="允许覆盖已存在的输出 DOCX 和报告",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="发现修订、内容控件或文本框时停止，不生成近似结果",
    )
    parser.add_argument(
        "--title-lines",
        type=int,
        default=1,
        metavar="N",
        help="标题占用的非空段落数；默认 1",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = args.report or args.output.with_suffix(
        args.output.suffix + ".format-report.json"
    )
    if report_path.exists() and not args.overwrite:
        print(
            f"错误：核验报告已存在：{report_path}。如需覆盖，请加 --overwrite。",
            file=sys.stderr,
        )
        return 2
    try:
        report = format_file(
            input_path=args.input,
            output_path=args.output,
            profile_path=args.profile,
            requested_type=args.doc_type,
            overwrite=args.overwrite,
            strict=args.strict,
            title_line_count=args.title_lines,
        )
    except (FormalDocumentError, OSError, ValueError) as exc:
        failure = {
            "schema_version": 1,
            "status": "failed",
            "input": str(args.input),
            "output": str(args.output),
            "error": str(exc),
        }
        write_json_atomic(report_path, failure)
        print(f"失败：{exc}", file=sys.stderr)
        return 2
    write_json_atomic(report_path, report)
    print(f"已生成：{args.output}")
    print(f"核验报告：{report_path}")
    print(f"文种：{report['document_type']}")
    print(f"正文完整性：{'通过' if report['content_integrity']['passed'] else '未通过'}")
    for warning in report["warnings"]:
        print(f"提醒：{warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
