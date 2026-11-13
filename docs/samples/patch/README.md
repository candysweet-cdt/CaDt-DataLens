# 补丁示例（.patch）

三份标准 unified diff 示例，分别演示**整体成功**、**允许部分成功**、**全部失败**三种结果。
目标工程是 `demo/`（4 个文件），初始内容保存在 `pristine/`，用于一键重置。

## 目录

| 路径 | 说明 |
| --- | --- |
| `all-success.patch` | 3 个文件全部可应用：改 `config.js`、追加 `style.css`、新建 `banner.js` |
| `partial.patch` | 3 个文件里 2 个可应用（`message.js`、`style.css`），`config.js` 因上下文不符被跳过 |
| `all-fail.patch` | 3 个文件全部不可用，且原因各不相同：上下文不符、目标文件不存在、hunk 超出文件末尾 |
| `demo/` | 被修改的示例工程，可当作工作区直接打开 |
| `pristine/` | 初始内容副本，只给重置脚本用，不要改 |
| `reset-samples.ps1` | Windows 一键重置 |
| `reset-samples.sh` | Git Bash / macOS / Linux 一键重置 |

三份补丁都以 `demo/` 为工作区根，路径前缀是 `a/`、`b/`（默认按 1 层剥离）。

## 命令行跑法

在**仓库根目录**执行（PowerShell 里把 `./` 换成 `.\`）：

```bash
# 只看结果，不写任何文件（推荐先跑这个）
./build/bin/CaDt-DataLens.exe --check-patch docs/samples/patch/all-success.patch --dir docs/samples/patch/demo

# ① 整体成功：写盘
./build/bin/CaDt-DataLens.exe --apply-patch docs/samples/patch/all-success.patch --dir docs/samples/patch/demo --yes

# ② 部分成功：必须显式加 --partial；不加则是整体成功模式，直接整体失败
./build/bin/CaDt-DataLens.exe --apply-patch docs/samples/patch/partial.patch --dir docs/samples/patch/demo --partial --yes

# ③ 全部失败：磁盘零变更
./build/bin/CaDt-DataLens.exe --apply-patch docs/samples/patch/all-fail.patch --dir docs/samples/patch/demo --yes
```

预期结果：

| 补丁 | 模式 | 输出 | 退出码 | 磁盘 |
| --- | --- | --- | --- | --- |
| `all-success` | 默认（整体成功） | 已应用 3 个文件（+12 −3） | 0 | 3 个文件改动 |
| `partial` | `--partial` | 已应用 2 个、跳过 1 个 | 1 | 2 个文件改动，`config.js` 不变 |
| `partial` | 默认（整体成功） | 未应用任何更改 | 1 | 零变更（可对比同一份补丁的两种模式） |
| `all-fail` | 任意 | 全部失败 / 全部跳过 | 1 | 零变更 |

> `all-fail` 里的三个失败原因在 `--check-patch` 下会一次列全；`--apply-patch` 在整体成功模式下遇到第一个冲突就停，其余标「未执行」，这是有意的（预检通过才会写盘）。

每次应用成功后会打印撤销命令，例如：

```bash
./build/bin/CaDt-DataLens.exe --revert-patch 20261113-141444-2163 --dir docs/samples/patch/demo --yes
```

## 在应用界面里跑

两种打开方式任选一种：

- **补丁与目标都可见（推荐）**：「文件 → 打开文件夹…」选择 `docs/samples/patch`，这样 `.patch` 和 `demo/` 都在文件树里；打开任一 `.patch` 后，补丁视图会提示「目标目录可能不对」，点「使用该目录」（或点顶部「目标」/「更改…」选 `demo`）即可。
- **直接以目标为工作区**：「文件 → 打开文件夹…」选择 `docs/samples/patch/demo`，再从「文件 → 打开文件…」打开 `docs/samples/patch/*.patch`（文件树里只有 demo 内容，补丁文件需从对话框打开）。

之后：

1. 顶部可切换「补丁视图 / 代码视图 / 文本视图」，补丁视图里勾选文件、选模式（整体成功 / 允许部分成功）后点「应用」；
2. 应用后按钮变「撤销」，可还原到应用前。

## 重置

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\docs\samples\patch\reset-samples.ps1
```

```bash
# Git Bash / macOS / Linux
./docs/samples/patch/reset-samples.sh
```

脚本做三件事：用 `pristine/` 覆盖 `demo/`、删除示例新建的 `src/banner.js`、删除应用留下的 `demo/.cadt/`（补丁索引、备份、工作区锁）。
跑完用 `diff -r pristine demo` 校验，应无输出。

## 说明

- 补丁是**标准 unified diff**，不含任何私有头；即使不用本应用，`git apply -p1` 也能直接应用 `all-success.patch`（在 `demo/` 目录下）。
- `all-fail` 故意覆盖三种失败类型，便于测试错误文案与「逐文件原因」展示；其中 `src/legacy.js` 在示例工程里**不存在**。
- 这三份补丁同时是回归样本：解析、匹配、atomic/partial、失败信息改动后，可用它们快速确认行为未变。
