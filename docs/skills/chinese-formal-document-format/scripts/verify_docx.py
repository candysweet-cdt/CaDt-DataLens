#!/usr/bin/env python3
"""Verify content preservation and typography for a formatted DOCX."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from formal_docx_core import (
    FormalDocumentError,
    verify_document,
    write_json_atomic,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="核验 DOCX 是否保持正文结构并按指定配置完成排版。"
    )
    parser.add_argument("formatted", type=Path, help="待核验的排版后 DOCX")
    parser.add_argument(
        "--reference",
        type=Path,
        help="原始 DOCX；提供后会逐字、逐表比较",
    )
    parser.add_argument(
        "--profile",
        type=Path,
        help="可选 JSON 样式覆盖文件；应与排版时使用同一文件",
    )
    parser.add_argument("--report", type=Path, help="输出 JSON 核验报告")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="允许覆盖已存在的核验报告",
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
    report_path = args.report or args.formatted.with_suffix(
        args.formatted.suffix + ".verify-report.json"
    )
    if report_path.exists() and not args.overwrite:
        print(
            f"错误：核验报告已存在：{report_path}。如需覆盖，请加 --overwrite。",
            file=sys.stderr,
        )
        return 2
    try:
        report = verify_document(
            formatted_path=args.formatted,
            reference_path=args.reference,
            profile_path=args.profile,
            title_line_count=args.title_lines,
        )
    except (FormalDocumentError, OSError, ValueError) as exc:
        report = {
            "schema_version": 1,
            "status": "failed",
            "formatted": str(args.formatted),
            "reference": str(args.reference) if args.reference else None,
            "error": str(exc),
            "checks": [],
        }
        write_json_atomic(report_path, report)
        print(f"失败：{exc}", file=sys.stderr)
        return 2
    write_json_atomic(report_path, report)
    print(f"核验状态：{report['status']}")
    print(f"报告：{report_path}")
    for check in report["checks"]:
        print(f"{'通过' if check['passed'] else '失败'}：{check['name']}")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
