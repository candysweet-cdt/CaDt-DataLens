# Markdown 预览示例

普通文本、**粗体**、*斜体*、`行内代码`，以及[项目仓库](https://github.com/candysweet-cdt/CaDt-DataLens)。

## 代码块

```js
export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  return units[Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))];
}
```

```yaml
name: 时空纪元
version: 1.0.0
enabled: true
```

## 数学公式

行内公式：$E = mc^2$。

块级公式：

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$

## 表格与引用

| 项目 | 说明 |
| --- | --- |
| 电缆 | 每格每日 4 件 |
| 机器 | 2.10+ 运行时配方 |

> 预览中的原始 HTML 默认不执行，避免本地脚本接触应用接口。
