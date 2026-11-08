#!/usr/bin/env python3
"""CaDt-DataLens Python 示例。"""

from pathlib import Path


def merge_blocks(left: int, right: int) -> int:
    return left * 60 + right


def summarize(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    return {
        "name": path.stem,
        "lines": len(lines),
        "chars": len(text),
        "preview": lines[:3],
    }


if __name__ == "__main__":
    print(merge_blocks(3, 7))
    print(summarize(Path(__file__)))
