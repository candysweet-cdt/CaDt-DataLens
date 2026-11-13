# 贡献指南

## 原则

这个 Skill 的核心边界是：

> 只改格式，不改一个字。

任何改动都必须优先保证正文、数字、标点、段落顺序、表格、页眉页脚和图片关系不变。

## 开发环境

需要 Python 3.10 或更高版本。

```bash
python3 -m pip install -r requirements.txt
```

## 修改后至少运行

```bash
python3 -m unittest discover -s tests -v
```

涉及版式时，还要至少用一组真实结构的匿名 DOCX 完成：

```bash
python3 scripts/format_docx.py 输入.docx 输出.docx --strict
python3 scripts/verify_docx.py 输出.docx --reference 输入.docx
```

## 提交内容

请勿提交：

- 未脱敏的单位文件；
- 个人身份信息；
- 商业字体文件；
- 作者、修订记录或批注未清理的真实材料。

新增示例请使用虚构内容，并同时保留源文件、输出文件与核验报告。

## 版本规则

- 修复 bug：补丁版本号；
- 向后兼容的新能力：次版本号；
- 技术名、目录结构或核心行为变化：主版本号。

每次发布同步更新 `VERSION`、`CHANGELOG.md`、`docs/iterations.md` 和测试。

