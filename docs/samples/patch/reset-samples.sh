#!/usr/bin/env bash
# 还原 docs/samples/patch/demo 到初始状态（Git Bash / macOS / Linux）。
#
# 用法：
#   ./reset-samples.sh
#
# 做三件事：
#   1. 用 pristine/ 覆盖 demo/（还原被补丁改过的内容）
#   2. 删除示例新建的 src/banner.js
#   3. 删除应用留下的 .cadt/（补丁索引、备份、工作区锁）

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$root/pristine"
dst="$root/demo"

if [ ! -d "$src" ]; then
    echo "找不到原始副本目录：$src" >&2
    exit 1
fi

mkdir -p "$dst"

# 1) 覆盖回原始内容
restored=()
while IFS= read -r -d '' f; do
    rel="${f#"$src"/}"
    mkdir -p "$dst/$(dirname "$rel")"
    cp -p "$f" "$dst/$rel"
    restored+=("$rel")
done < <(find "$src" -type f -print0 | sort -z)

# 2) 删除示例新建的文件与应用留下的补丁目录
removed=()
for rel in "src/banner.js"; do
    if [ -e "$dst/$rel" ]; then
        rm -f "$dst/$rel"
        removed+=("$rel")
    fi
done
if [ -d "$dst/.cadt" ]; then
    rm -rf "$dst/.cadt"
    removed+=(".cadt/")
fi

echo "已还原 ${#restored[@]} 个文件："
for r in "${restored[@]}"; do echo "  + $r"; done
if [ "${#removed[@]}" -gt 0 ]; then
    echo "已清理 ${#removed[@]} 项示例产物："
    for r in "${removed[@]}"; do echo "  - $r"; done
else
    echo "没有需要清理的示例产物。"
fi
echo "demo 已回到初始状态，可以重新跑示例。"
