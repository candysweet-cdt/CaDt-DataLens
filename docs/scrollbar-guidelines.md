# 滚动条规范（Scrollbar Guidelines）

> 适用范围：`frontend/src/style.css` 及 `frontend/src/` 下一切涉及滚动条尺寸的样式。
> 目的：滚动条宽度只有一个数值旋钮，用途靠语义别名表达，杜绝各处裸写 `px`。

## 核心规则

1. **禁止裸写滚动条尺寸**：不得在 `::-webkit-scrollbar` 上直接写 `width: 8px` 这类字面量，
   也不得新增第三种语义别名。业务样式一律引用下表的语义令牌。
2. **调宽度只改基础尺度** `--sb-unit`：所有语义令牌都是它的倍数，改一处全局等比缩放。
   需要整体变细/变粗时只动这一个值，不要逐个改语义令牌。
3. **按用途选语义令牌**，不按个人喜好：
   - 常规滚动区（聊天、侧栏、预览、编辑器等大面积内容）→ `--scrollbar-size`
   - 小控件 / 弹出层（下拉、模型选择器等窄面板）→ `--scrollbar-size-sm`
   - 滑块圆角一律 `--scrollbar-thumb-radius`，不单独写圆角值。
4. **隐藏滚动条**是另一类语义（标签条等），用 `scrollbar-width: none` +
   `::-webkit-scrollbar { display: none }`，与尺寸令牌无关，不受本规范约束。

## 令牌表

| 令牌 | 定义 | 当前值 | 用途 |
|---|---|---|---|
| `--sb-unit` | 基础尺度（唯一数值旋钮） | `2px` | 只在此处调大小 |
| `--scrollbar-size` | `calc(--sb-unit * 4)` | 8px | 常规滚动区宽/高 |
| `--scrollbar-size-sm` | `calc(--sb-unit * 3)` | 6px | 小控件/浮层宽/高 |
| `--scrollbar-thumb-radius` | `calc(--sb-unit * 2)` | 4px | 滑块圆角（胶囊） |

定义位置：`frontend/src/style.css` 顶部的 `:root`（尺寸与主题无关，颜色令牌才在 `core/themes.json`）。

## 用法示例

常规滚动条（全局默认规则已处理，普通容器无需重复声明）：

```css
::-webkit-scrollbar { width: var(--scrollbar-size); height: var(--scrollbar-size); }
::-webkit-scrollbar-thumb { border-radius: var(--scrollbar-thumb-radius); }
```

小浮层（给容器单独收窄时，只写一条宽度覆盖）：

```css
.ai-model-picker-list::-webkit-scrollbar {
    width: var(--scrollbar-size-sm);
    height: var(--scrollbar-size-sm);
}
```

## 新增滚动区怎么办

- 大面积内容区：什么都不用写，继承全局默认即可。
- 窄浮层要更细：加一条 `选择器::-webkit-scrollbar { width: var(--scrollbar-size-sm); height: var(--scrollbar-size-sm); }`。
- **不要**新增 `--scrollbar-size-xs` 之类的第四档；确需新档位先改本规范与护栏基线。

## 护栏

`frontend/test/core/scrollbar-guard.test.mjs`（已登记 `npm test`）强制：

- 三级令牌定义齐全且语义令牌都基于 `--sb-unit`；
- `style.css` 里 `::-webkit-scrollbar` 的尺寸不得出现裸 `px` 字面量（只能 `var(--scrollbar-*)`）；
- 全局默认规则与两个已知浮层覆盖点按基线登记，新增覆盖点需显式登记并写明理由（只许减不许增）。

改令牌结构时同步更新该护栏与本规范，否则测试会红。
