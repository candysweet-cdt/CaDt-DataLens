# CaDt-DataLens 插件开发指南

插件是一个**文件夹**：内含一份 `plugin.json` 清单和一个 JavaScript 入口文件。插件运行在界面（WebView）里，可以通过 `cadt.*` API 注册新的文件格式、工具菜单命令和主题。设置 → 插件 里可以添加、导入、启用/禁用和删除插件。

## 快速开始

```text
my-plugin/
├── plugin.json     ← 清单（必需）
└── main.js         ← 入口（默认名，可在清单里改）
```

`plugin.json`：

```json
{
    "id": "bak-json",
    "name": "JSON 备份查看",
    "version": "1.0.0",
    "author": "你的名字",
    "description": "把 .bak 文件按 JSON 解析",
    "entry": "main.js",
    "extensions": ["bak"]
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 小写字母/数字/连字符，≤64 字符；同时是安装目录名，全局唯一 |
| `name` | ✓ | 显示名称 |
| `version` | | 建议语义化版本 |
| `author` | | 作者 |
| `description` | | 描述，显示在插件列表 |
| `entry` | | 入口 JS 文件（相对插件目录），默认 `main.js`，≤2 MB |
| `extensions` | | 该插件涉及的扩展名，仅作列表展示 |

安装方式（设置 → 插件）：**添加插件** 选文件夹；**导入插件(.zip)** 选压缩包（zip 里 `plugin.json` 在根目录或唯一顶层子目录都可以）。插件目录默认在 exe 旁的 `plugins\`，可在设置里切换到 `%APPDATA%\CaDt-DataLens\plugins`。

## 插件 API

入口文件是一个普通 JS 脚本体，加载时会以 `cadt` 为参数执行（相当于 `new Function('cadt', code)`）。可用的 API：

### `cadt.registerFormat(driver)`

注册新的文件格式，复用内置的树 / 表格 / 代码 / 文本视图。

```js
cadt.registerFormat({
    id: 'bak-json',            // 必需，全局唯一，不能与内置格式同名
    name: 'JSON 备份',         // 必需，显示名
    extensions: ['bak'],       // 必需，小写扩展名（不带点）
    parse: (text) => JSON.parse(text),          // 树视图 / 编辑用
    stringify: (value) => JSON.stringify(value, null, 2),  // 保存 / 切视图用
    // 可选：
    // aceMode: 'json'                    // 代码视图高亮（Ace 模式名）
    // rawOnly: true                      // 不提供树视图（纯文本类）
    // table: true, parseTable(text), stringifyTable(headers, rows)  // 表格视图
});
```

- 内置格式优先：与内置格式扩展名相同的插件格式不会被用到（例如注册 `.json` 无效）。
- `parse` 抛异常时该文件自动退回文本视图，不会中断。
- 注册后即刻生效：之后打开的匹配文件会使用该格式；已打开的文件不受影响。
- 格式会出现在 设置 → 文件格式 树里，可获得独立的编码/缩进/换行/默认视图配置。

### `cadt.addCommand({id, label, run})`

在菜单栏 **工具(U)** 里注册命令。

```js
cadt.addCommand({
    id: 'char-count',          // 插件内唯一，会加插件前缀
    label: '统计当前文件字符数',
    run() {
        const file = cadt.getActiveFile();
        const text = cadt.getActiveText();
        cadt.flash((file ? file.name : '无文件') + ' 共 ' + (text ? text.length : 0) + ' 字符');
    },
});
```

### `cadt.addTheme({id, name, bg, accent, css})`

注册主题，出现在 主题(T) 菜单里。

```js
cadt.addTheme({
    id: 'my-theme',
    name: '我的主题',
    bg: '#241f31',             // 窗口底色（菜单色块也用它）
    accent: '#c58af9',         // 强调色
    css: `
        html[data-theme="my-theme"] {
            --bg: #241f31;
            --text: #e8e3f2;
            --muted: #9d94b8;
            --border: #3a3350;
            --hover: #2e2842;
            --accent: #c58af9;
            --on-accent: #1b1626;
        }
    `,
});
```

`css` 是追加进页面的样式表，选择器用 `html[data-theme="<id>"]` 覆盖 `--*` 设计变量即可；建议完整提供 `--bg/--text/--muted/--border/--hover/--accent/--on-accent`。

### 运行时辅助

| API | 说明 |
| --- | --- |
| `cadt.getActiveFile()` | 当前文件信息 `{path, name, size, formatId}`，无文件时为 `null` |
| `cadt.getActiveText()` | 当前文件文本（按当前视图取值），二进制文件为 `null` |
| `cadt.openPath(path)` | 用本程序打开一个文件或目录 |
| `cadt.flash(message)` | 在右下角弹出提示 |

## 目录与切换

- 默认（便携）：`<exe 目录>\plugins\<插件 id>\`，跟程序走，复制目录即可带走。
- 可选（应用数据）：`%APPDATA%\CaDt-DataLens\plugins\<插件 id>\`。
- 在 设置 → 插件 里切换目录模式；切换后列表按新目录展示，已安装插件不会自动迁移。

## 安全说明

插件代码运行在界面上下文中，能力等同于用户自己运行的脚本（可以调用应用的全部后端接口）。请只安装可信来源的插件；应用会在导入时校验清单格式、入口路径与压缩包结构（防路径穿越、限大小），但不做代码沙箱。

## 完整示例

见 [`examples/bak-json/`](examples/bak-json/)：把 `.bak` 文件按 JSON 解析，解析失败自动退回文本视图，并注册一个演示命令与主题。
