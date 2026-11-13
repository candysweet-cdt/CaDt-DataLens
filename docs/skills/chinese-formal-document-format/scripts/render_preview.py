#!/usr/bin/env python3
"""Render a DOCX preview without hiding the host machine's CJK fonts."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from xml.sax.saxutils import escape


def font_directories() -> list[Path]:
    home = Path.home()
    candidates = [
        home / "Library" / "Fonts",
        Path("/Library/Fonts"),
        Path("/System/Library/Fonts"),
        Path("/System/Library/Fonts/Supplemental"),
        home / ".fonts",
        home / ".local" / "share" / "fonts",
        Path("/usr/share/fonts"),
        Path("/usr/local/share/fonts"),
    ]
    windows_root = os.environ.get("WINDIR")
    if windows_root:
        candidates.append(Path(windows_root) / "Fonts")
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        candidates.append(Path(local_app_data) / "Microsoft" / "Windows" / "Fonts")
    return [path for path in candidates if path.is_dir()]


def write_fontconfig(path: Path, cache_dir: Path) -> None:
    directories = font_directories()
    body = "\n".join(
        f"  <dir>{escape(str(directory))}</dir>" for directory in directories
    )
    path.write_text(
        "<?xml version=\"1.0\"?>\n"
        "<!DOCTYPE fontconfig SYSTEM \"urn:fontconfig:fonts.dtd\">\n"
        "<fontconfig>\n"
        f"{body}\n"
        f"  <cachedir>{escape(str(cache_dir))}</cachedir>\n"
        "</fontconfig>\n",
        encoding="utf-8",
    )


def run(command: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
    except OSError as exc:
        return subprocess.CompletedProcess(
            command,
            returncode=127,
            stdout="",
            stderr=str(exc),
        )


def find_pdf(output_dir: Path) -> Path | None:
    pdfs = sorted(output_dir.glob("*.pdf"))
    return pdfs[0] if pdfs else None


def resolve_binary(explicit: Path | None, name: str) -> str | None:
    if explicit is not None:
        candidate = explicit.expanduser().resolve()
        if candidate.is_file():
            return str(candidate)
        print(
            f"提示：指定的 {name} 不存在，尝试从 PATH 查找：{candidate}",
            file=sys.stderr,
        )
    found = shutil.which(name)
    if found:
        return found
    common_paths: list[Path] = []
    if name == "soffice":
        common_paths.extend(
            [
                Path("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
                Path(r"C:\Program Files\LibreOffice\program\soffice.exe"),
                Path(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"),
            ]
        )
    for candidate in common_paths:
        if candidate.is_file():
            return str(candidate)
    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="生成带中文字体发现的 DOCX 预览。"
    )
    parser.add_argument("input", type=Path, help="DOCX 文件")
    parser.add_argument("output_dir", type=Path, help="预览输出目录")
    parser.add_argument(
        "--soffice",
        type=Path,
        help="soffice 或 soffice.exe 路径；默认从 PATH 查找",
    )
    parser.add_argument(
        "--pdftoppm",
        type=Path,
        help="pdftoppm 路径；默认从 PATH 查找",
    )
    parser.add_argument("--dpi", type=int, default=160, help="PNG DPI，默认 160")
    parser.add_argument(
        "--quicklook-size",
        type=int,
        default=1600,
        help="macOS Quick Look 回退缩略图边长，默认 1600",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.input.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    if not source.is_file():
        print(f"错误：找不到输入文件：{source}", file=sys.stderr)
        return 2

    soffice = resolve_binary(args.soffice, "soffice")
    pdftoppm = resolve_binary(args.pdftoppm, "pdftoppm")

    with tempfile.TemporaryDirectory(prefix="chinese-formal-doc-preview-") as temp:
        temp_dir = Path(temp)
        profile_dir = temp_dir / "lo-profile"
        cache_dir = temp_dir / "font-cache"
        profile_dir.mkdir()
        cache_dir.mkdir()
        fontconfig_path = temp_dir / "fonts.conf"
        write_fontconfig(fontconfig_path, cache_dir)
        env = os.environ.copy()
        env["FONTCONFIG_FILE"] = str(fontconfig_path)
        env["FONTCONFIG_PATH"] = str(temp_dir)
        env["XDG_CACHE_HOME"] = str(temp_dir / "xdg-cache")
        env["XDG_CONFIG_HOME"] = str(temp_dir / "xdg-config")
        if sys.platform == "darwin" and Path("/private/tmp").is_dir():
            env["TMPDIR"] = "/private/tmp"
            env["TEMP"] = "/private/tmp"
            env["TMP"] = "/private/tmp"

        if soffice:
            convert_dir = temp_dir / "converted"
            convert_dir.mkdir()
            command = [
                soffice,
                f"-env:UserInstallation={profile_dir.resolve().as_uri()}",
                "--invisible",
                "--headless",
                "--norestore",
                "--convert-to",
                "pdf",
                "--outdir",
                str(convert_dir),
                str(source),
            ]
            result = run(command, env)
            pdf = find_pdf(convert_dir)
            if pdf is None:
                print("LibreOffice 未生成 PDF。", file=sys.stderr)
                if result.stderr:
                    print(result.stderr.strip(), file=sys.stderr)
            else:
                output_pdf = output_dir / pdf.name
                shutil.copy2(pdf, output_pdf)
                pdf = output_pdf
                print(f"PDF：{pdf}")
                if pdftoppm:
                    png_prefix = output_dir / "page"
                    png_result = run(
                        [
                            pdftoppm,
                            "-png",
                            "-r",
                            str(args.dpi),
                            str(pdf),
                            str(png_prefix),
                        ],
                        env,
                    )
                    pages = sorted(output_dir.glob("page-*.png"))
                    if pages:
                        print(f"PNG：{len(pages)} 页")
                        return 0
                    print("PDF 已生成，但 pdftoppm 未能导出 PNG。", file=sys.stderr)
                    if png_result.stderr:
                        print(png_result.stderr.strip(), file=sys.stderr)
                    return 1
                print("未找到 pdftoppm；保留 PDF 预览。")
                return 0

        qlmanage = shutil.which("qlmanage") if sys.platform == "darwin" else None
        if qlmanage:
            thumbnail_dir = temp_dir / "quicklook"
            thumbnail_dir.mkdir()
            result = run(
                [
                    qlmanage,
                    "-t",
                    "-s",
                    str(args.quicklook_size),
                    "-o",
                    str(thumbnail_dir),
                    str(source),
                ],
                env,
            )
            previews = sorted(thumbnail_dir.glob("*.png"))
            if previews:
                output_preview = output_dir / previews[0].name
                shutil.copy2(previews[0], output_preview)
                print(f"Quick Look 首屏预览：{output_preview}")
                print("提示：Quick Look 仅提供缩略图，不替代逐页检查。")
                return 0
            if result.stderr:
                print(result.stderr.strip(), file=sys.stderr)

    print(
        "无法生成预览。请安装 LibreOffice 和 Poppler，或在 Word/WPS 中人工检查。",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
