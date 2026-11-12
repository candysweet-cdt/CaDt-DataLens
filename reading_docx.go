package main

// 阅读模式 DOCX 解析（docs/reading-mode.md §10.4）：
// 只解 word/document.xml 与 docProps/core.xml 的文本/标题/表格文本，图片给占位。
// 只读：不修改源文件，不抽取图片。零新依赖（archive/zip + encoding/xml）。

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// docx 也是 zip：解压上限与 epub 同思路，防压缩炸弹把内存打爆。
const (
	docxMaxEntryBytes int64  = 50 << 20  // 单个条目解压上限
	docxMaxTotalBytes uint64 = 200 << 20 // 全包解压总量上限
)

// ReadingDocxRow 表格行。
type ReadingDocxRow struct {	Cells []string `json:"cells"`
}

// ReadingDocxBlock 文档块：h1–h6 / p / table / image。
type ReadingDocxBlock struct {
	Kind  string           `json:"kind"`
	Level int              `json:"level,omitempty"`
	Text  string           `json:"text,omitempty"`
	Rows  []ReadingDocxRow `json:"rows,omitempty"`
}

// PlainText 块的纯文本（供扫描字数/搜索使用）。
func (b *ReadingDocxBlock) PlainText() string {
	if b.Kind == "table" {
		parts := make([]string, 0, len(b.Rows))
		for _, row := range b.Rows {
			parts = append(parts, strings.Join(row.Cells, " "))
		}
		return strings.Join(parts, " ")
	}
	return b.Text
}

// ReadingDocx ParseReadingDocx 的返回结构。
type ReadingDocx struct {
	Blocks []ReadingDocxBlock `json:"blocks"`
	Title  string             `json:"title"`
	Author string             `json:"author"`
}

var docxOLEHeader = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}

var (
	reDocxHeadingStyle = regexp.MustCompile(`^[Hh]eading\s*([1-9])$`)
	reDocxCnHeading    = regexp.MustCompile(`^标题\s*([1-9])$`)
)

// ParseReadingDocx 供前端读取 docx 的块序列与元数据。
func (a *App) ParseReadingDocx(path string) (*ReadingDocx, error) {
	blocks, title, author, err := readDocxContent(path)
	if err != nil {
		return nil, err
	}
	return &ReadingDocx{Blocks: blocks, Title: title, Author: author}, nil
}

func parseReadingDocxFile(path string) ([]ReadingDocxBlock, error) {
	blocks, _, _, err := readDocxContent(path)
	return blocks, err
}

func readDocxContent(path string) ([]ReadingDocxBlock, string, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, "", "", err
	}
	head := make([]byte, 8)
	n, _ := io.ReadFull(f, head)
	_ = f.Close()
	if n == 8 && bytes.Equal(head, docxOLEHeader) {
		return nil, "", "", fmt.Errorf("暂不支持 .doc，请另存为 .docx")
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, "", "", fmt.Errorf("无法读取 docx：%w", err)
	}
	defer zr.Close()
	var blocks []ReadingDocxBlock
	title, author := "", ""
	var total uint64
	for _, file := range zr.File {
		total += file.UncompressedSize64
		if total > docxMaxTotalBytes {
			return nil, "", "", fmt.Errorf("docx 解压后体积超过 %d MB，已拒绝打开", docxMaxTotalBytes>>20)
		}
		switch file.Name {
		case "word/document.xml":
			if file.UncompressedSize64 > uint64(docxMaxEntryBytes) {
				return nil, "", "", fmt.Errorf("docx 正文超过 %d MB，已拒绝打开", docxMaxEntryBytes>>20)
			}
			rc, err := file.Open()
			if err != nil {
				return nil, "", "", err
			}
			blocks, err = parseDocxDocument(io.LimitReader(rc, docxMaxEntryBytes+1))
			_ = rc.Close()
			if err != nil {
				return nil, "", "", err
			}
		case "docProps/core.xml":
			rc, err := file.Open()
			if err != nil {
				continue
			}
			title, author = parseDocxCore(io.LimitReader(rc, docxMaxEntryBytes+1))
			_ = rc.Close()
		}
	}
	if blocks == nil {
		return nil, "", "", fmt.Errorf("docx 缺少 word/document.xml")
	}
	return blocks, title, author, nil
}

// parseDocxDocument 流式解析 document.xml，按 Local 名匹配，忽略命名空间前缀。
func parseDocxDocument(r io.Reader) ([]ReadingDocxBlock, error) {
	decoder := xml.NewDecoder(r)
	st := &docxState{para: docxPara{outline: -1}}
	for {
		tok, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("document.xml 解析失败：%w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "p":
				st.paraDepth++
				if st.paraDepth == 1 {
					st.para = docxPara{outline: -1}
				}
			case "tbl":
				st.tableDepth++
				if st.tableDepth == 1 {
					st.table = docxTable{}
				}
			case "tr":
				if st.tableDepth > 0 {
					st.table.rows = append(st.table.rows, ReadingDocxRow{})
				}
			case "tc":
				st.cell = &strings.Builder{}
				if st.tableDepth > 0 && len(st.table.rows) > 0 {
					st.table.rows[len(st.table.rows)-1].Cells = append(
						st.table.rows[len(st.table.rows)-1].Cells, "")
				}
			case "pStyle":
				if v := attrVal(t, "val"); v != "" && st.paraDepth == 1 && st.para.style == "" {
					st.para.style = v
				}
			case "outlineLvl":
				if v := attrVal(t, "val"); v != "" && st.paraDepth == 1 && st.para.outline < 0 {
					if lvl, err := strconv.Atoi(v); err == nil {
						st.para.outline = lvl
					}
				}
			case "t":
				st.inT = true
			case "instrText", "delText":
				st.inT = false
			case "tab":
				st.addText("\t")
			case "br":
				st.addText("\n")
			case "drawing", "pict", "object":
				st.para.image = true
			}
		case xml.CharData:
			if st.inT {
				st.addText(string(t))
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				st.inT = false
			case "p":
				if st.paraDepth > 0 {
					st.paraDepth--
				}
				if st.paraDepth == 0 {
					if st.tableDepth > 0 && st.cell != nil {
						// 单元格文本已由 addText 直接写入 cell，这里只补段落分隔
						if st.cell.Len() > 0 {
							st.cell.WriteString("\n")
						}
					} else {
						if text := strings.TrimSpace(st.para.text.String()); text != "" {
							st.blocks = append(st.blocks, docxParaBlock(st.para, text))
						}
						if st.para.image {
							st.blocks = append(st.blocks, ReadingDocxBlock{Kind: "image", Text: "〔图片〕"})
						}
					}
					st.para = docxPara{outline: -1}
				}
			case "tc":
				if st.cell != nil && st.tableDepth > 0 && len(st.table.rows) > 0 {
					row := &st.table.rows[len(st.table.rows)-1]
					if len(row.Cells) > 0 {
						row.Cells[len(row.Cells)-1] = strings.TrimSpace(st.cell.String())
					}
				}
				st.cell = nil
			case "tbl":
				if st.tableDepth > 0 {
					st.tableDepth--
				}
				if st.tableDepth == 0 && len(st.table.rows) > 0 {
					st.blocks = append(st.blocks, ReadingDocxBlock{Kind: "table", Rows: st.table.rows})
					st.table = docxTable{}
				}
			}
		}
	}
	return st.blocks, nil
}

type docxState struct {
	blocks     []ReadingDocxBlock
	para       docxPara
	table      docxTable
	cell       *strings.Builder
	tableDepth int
	paraDepth  int
	inT        bool
}

type docxPara struct {
	style   string
	outline int
	text    strings.Builder
	image   bool
}

func (st *docxState) addText(s string) {
	st.para.text.WriteString(s)
	if st.cell != nil {
		st.cell.WriteString(s)
	}
}

// docxParaBlock 段落 → 块：样式/大纲级别定标题，章关键词兜底，其余正文。
func docxParaBlock(para docxPara, text string) ReadingDocxBlock {
	level := 0
	if m := reDocxHeadingStyle.FindStringSubmatch(para.style); m != nil {
		level, _ = strconv.Atoi(m[1])
	} else if m := reDocxCnHeading.FindStringSubmatch(para.style); m != nil {
		level, _ = strconv.Atoi(m[1])
	} else if para.outline >= 0 && para.outline <= 8 {
		level = para.outline + 1
	}
	if level <= 0 {
		if reReadingVolume.MatchString(text) {
			level = 1
		} else if reReadingChap.MatchString(text) {
			level = 2
		}
	}
	if level > 6 {
		level = 6
	}
	if level > 0 {
		return ReadingDocxBlock{Kind: "h" + strconv.Itoa(level), Level: level, Text: text}
	}
	return ReadingDocxBlock{Kind: "p", Text: text}
}

func attrVal(se xml.StartElement, local string) string {
	for _, attr := range se.Attr {
		if attr.Name.Local == local {
			return strings.TrimSpace(attr.Value)
		}
	}
	return ""
}

type docxTable struct {
	rows []ReadingDocxRow
}

// parseDocxCore 读 docProps/core.xml 的 dc:title / dc:creator。
func parseDocxCore(r io.Reader) (title, author string) {
	decoder := xml.NewDecoder(r)
	current := ""
	depth := 0
	for {
		tok, err := decoder.Token()
		if err != nil {
			return title, author
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			switch t.Name.Local {
			case "title":
				current = "title"
			case "creator":
				current = "creator"
			}
		case xml.CharData:
			switch current {
			case "title":
				title += string(t)
			case "creator":
				author += string(t)
			}
		case xml.EndElement:
			if t.Name.Local == "title" || t.Name.Local == "creator" {
				current = ""
			}
			depth--
			if depth <= 0 {
				return strings.TrimSpace(title), strings.TrimSpace(author)
			}
		}
	}
}
