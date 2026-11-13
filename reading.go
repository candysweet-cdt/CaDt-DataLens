package main

// 阅读模式扫描：把一个目录（或单个 md/txt/docx/epub 文件）识别为一本书。
// 只读实现：本文件不写任何源文件，也不引入新依赖。
// 方案见 docs/finished-plans/reading-mode.md §2/§3/§4。

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	readingDefaultMaxDepth           = 6
	readingDefaultMaxFiles           = 2000
	readingDefaultMaxFileBytes int64 = 20 << 20
	readingDefaultMaxHeadings        = 5000
	readingScanWorkers               = 4
)

// ReadingScanOptions 扫描预算与忽略目录。
type ReadingScanOptions struct {
	MaxDepth           int      `json:"maxDepth"`
	MaxFiles           int      `json:"maxFiles"`
	MaxFileBytes       int64    `json:"maxFileBytes"`
	MaxHeadingsPerFile int      `json:"maxHeadingsPerFile"`
	IgnoreDirs         []string `json:"ignoreDirs"`
}

// ReadingHeading 单个标题：文本文件 offset 为 1-based 行号，docx/epub 为块/spine 序号。
type ReadingHeading struct {
	Offset int    `json:"offset"`
	Level  int    `json:"level"`
	Title  string `json:"title"`
	Words  int    `json:"words"`
}

// ReadingFile 扫描出的单个文件。
type ReadingFile struct {
	Rel      string           `json:"rel"`
	Name     string           `json:"name"`
	Ext      string           `json:"ext"`
	Size     int64            `json:"size"`
	ModTime  int64            `json:"modTime"`
	Encoding string           `json:"encoding"`
	Words    int              `json:"words"`
	Headings []ReadingHeading `json:"headings"`
	Error    string           `json:"error,omitempty"`
}

// ReadingScan 一次书根扫描的完整结果。
type ReadingScan struct {
	Root       string        `json:"root"`
	Title      string        `json:"title"`
	Author     string        `json:"author"`
	Intro      string        `json:"intro"`
	Profile    string        `json:"profile"` // file | split | tree
	Confidence float64       `json:"confidence"`
	Files      []ReadingFile `json:"files"`
	Warnings   []string      `json:"warnings"`
	ScanMs     int64         `json:"scanMs"`
}

// ReadingBookSuggestion 书架候选书根（仅按文件元数据统计，不读内容，保证书架秒开）。
type ReadingBookSuggestion struct {
	Root     string  `json:"root"`
	Name     string  `json:"name"`
	Books    int     `json:"bookFiles"`
	Named    int     `json:"namedFiles"`
	Bytes    int64   `json:"bytes"`
	EstWords int64   `json:"estWords"`
	Score    float64 `json:"score"`
}

var readingTextExts = map[string]bool{
	".md": true, ".markdown": true, ".mdx": true, ".txt": true,
}

var readingChapterNameRe = regexp.MustCompile(`(?:第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章回节话]|番外\s*[0-9零〇一二三四五六七八九十百千万两]+)`)

// 卷/章关键词：对 md 标题文本、txt 行、docx 段落文本统一跑；卷优先判定。
var (
	reReadingVolume = regexp.MustCompile(`^\s{0,8}(第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[卷部篇]|番外卷|扩展卷|设定卷|人物卷|记录卷)\s*[:：、.．\s]*(.*)$`)
	reReadingChap   = regexp.MustCompile(`^\s{0,8}(第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章回节话]|序章|楔子|引子|前言|引言|尾声|终章|后记|附录|番外(?:篇|中|之外)?(?:\s*[0-9零〇一二三四五六七八九十百千万两]+)?(?:\s|[-—·:：、.．]|$))(.*)$`)
	reReadingNumPre = regexp.MustCompile(`^\s{0,4}([0-9]+|[零〇一二三四五六七八九十百千万两]+)\s*[:：、.．]\s*(.*)$`)
)

// Markdown ATX 标题（跳过 fenced code 内的 #）与围栏。
var (
	reReadingATX   = regexp.MustCompile(`^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$`)
	reReadingFence = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})")
)

// 阅读模式默认忽略目录（另加所有点开头目录）。
var readingIgnoreDirs = map[string]bool{
	".git": true, ".svn": true, ".hg": true, "node_modules": true, "dist": true,
	"build": true, "backup": true, "备份": true, "archive": true, "__pycache__": true,
	".webnovel": true, ".story-system": true, ".claude": true, ".zcode": true,
}

var cnReadingDigit = map[rune]int{
	'零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
	'五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
}

var cnReadingUnit = map[rune]float64{
	'十': 10, '百': 100, '千': 1000, '万': 10000, '亿': 1e8,
}

// parseReadingNumeral 解析中文/阿拉伯数字（支持 十/百/千/万/亿 组合），失败返回 ok=false。
func parseReadingNumeral(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	allArabic := true
	for _, r := range s {
		if r < '0' || r > '9' {
			allArabic = false
			break
		}
	}
	if allArabic {
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return 0, false
		}
		return v, true
	}
	total, section, digit := 0.0, 0.0, 0.0
	for _, r := range s {
		if v, ok := cnReadingDigit[r]; ok {
			digit = float64(v)
			continue
		}
		if u, ok := cnReadingUnit[r]; ok {
			if u >= 10000 {
				value := section + digit
				if value == 0 {
					value = 1 // 「万」「亿」单用
				}
				section = value * u
				total += section
				section = 0
			} else {
				if digit == 0 {
					digit = 1 // 「十」「十三」
				}
				section += digit * u
			}
			digit = 0
			continue
		}
		return 0, false
	}
	return total + section + digit, true
}

// countReadingWords 与前端 countWords 同口径：CJK 逐字计 1，拉丁字母/数字串计 1 词。
func countReadingWords(s string) int {
	if s == "" {
		return 0
	}
	count := 0
	inLatin := false
	for _, r := range s {
		if (r >= 0x4e00 && r <= 0x9fff) || (r >= 0x3040 && r <= 0x30ff) || (r >= 0xac00 && r <= 0xd7af) {
			count++
			inLatin = false
			continue
		}
		isLatin := (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if isLatin && !inLatin {
			count++
		}
		inLatin = isLatin
	}
	return count
}

// lineWordPrefix cum[i] = 前 i 行的累计字数（cum[0]=0），供标题区间字数差分。
func readingWordPrefix(lines []string) []int64 {
	cum := make([]int64, len(lines)+1)
	for i, line := range lines {
		cum[i+1] = cum[i] + int64(countReadingWords(line))
	}
	return cum
}

// decodeReadingText 文本解码：UTF-16 仅认 BOM，其余复用现有 utf-8/GBK 自动检测。
func decodeReadingText(raw []byte) (string, string, error) {
	if len(raw) >= 2 {
		if raw[0] == 0xFF && raw[1] == 0xFE {
			return decodeReadingUTF16(raw[2:], false), "utf-16le", nil
		}
		if raw[0] == 0xFE && raw[1] == 0xFF {
			return decodeReadingUTF16(raw[2:], true), "utf-16be", nil
		}
	}
	if len(raw) >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF {
		return string(raw[3:]), "utf-8", nil
	}
	return decodeBytes(raw, "")
}

func decodeReadingUTF16(raw []byte, bigEndian bool) string {
	n := len(raw) / 2
	units := make([]uint16, n)
	for i := 0; i < n; i++ {
		if bigEndian {
			units[i] = uint16(raw[i*2])<<8 | uint16(raw[i*2+1])
		} else {
			units[i] = uint16(raw[i*2+1])<<8 | uint16(raw[i*2])
		}
	}
	return string(utf16.Decode(units))
}

// ScanReadingRoot 扫描书根：目录（递归）或单个 md/txt/docx/epub 文件。
func (a *App) ScanReadingRoot(root string, opts ReadingScanOptions) (*ReadingScan, error) {
	start := time.Now()
	opts = normalizeReadingScanOptions(opts)
	abs, err := filepath.Abs(strings.TrimSpace(root))
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	scan := &ReadingScan{Root: abs}
	var files []ReadingFile
	if info.Mode().IsRegular() {
		files, err = a.scanReadingSingleFile(abs, info, opts, scan)
		if err != nil {
			return nil, err
		}
		if scan.Title == "" {
			scan.Title = strings.TrimSuffix(info.Name(), filepath.Ext(info.Name()))
		}
	} else if info.IsDir() {
		files, err = a.scanReadingDir(abs, opts, scan)
		if err != nil {
			return nil, err
		}
		if scan.Title == "" {
			scan.Title = filepath.Base(abs)
		}
	} else {
		return nil, fmt.Errorf("不支持的路径类型：%s", abs)
	}
	scan.Files = files
	fillReadingProfile(scan)
	scan.ScanMs = time.Since(start).Milliseconds()
	if devMode.Load() {
		writeAppLog("debug", "阅读扫描 %s：%d 文件 / %d 字 / profile=%s / %d ms",
			abs, len(scan.Files), readingTotalWords(scan), scan.Profile, scan.ScanMs)
	}
	return scan, nil
}

func normalizeReadingScanOptions(opts ReadingScanOptions) ReadingScanOptions {
	if opts.MaxDepth <= 0 {
		opts.MaxDepth = readingDefaultMaxDepth
	}
	if opts.MaxDepth > 12 {
		opts.MaxDepth = 12
	}
	if opts.MaxFiles <= 0 {
		opts.MaxFiles = readingDefaultMaxFiles
	}
	if opts.MaxFileBytes <= 0 {
		opts.MaxFileBytes = readingDefaultMaxFileBytes
	}
	if opts.MaxHeadingsPerFile <= 0 {
		opts.MaxHeadingsPerFile = readingDefaultMaxHeadings
	}
	return opts
}

func readingTotalWords(scan *ReadingScan) int {
	total := 0
	for i := range scan.Files {
		total += scan.Files[i].Words
	}
	return total
}

// scanReadingSingleFile 单文件书：md/txt/docx 直接解析；epub 走 reading_epub.go。
func (a *App) scanReadingSingleFile(abs string, info os.FileInfo, opts ReadingScanOptions, scan *ReadingScan) ([]ReadingFile, error) {
	ext := strings.ToLower(filepath.Ext(abs))
	switch {
	case readingTextExts[ext] || ext == ".docx":
		rf := processReadingFile(abs, filepath.Base(abs), info, opts, scan)
		return []ReadingFile{rf}, nil
	case ext == ".epub":
		meta, err := prepareReadingEpub(abs)
		if err != nil {
			return nil, err
		}
		scan.Title = meta.Title
		scan.Author = meta.Author
		rf := ReadingFile{
			Rel:  info.Name(),
			Name: info.Name(),
			Ext:  ".epub",
			Size: info.Size(),
		}
		if meta.ModTime != 0 {
			rf.ModTime = meta.ModTime
		}
		for _, ch := range meta.Chapters {
			rf.Headings = append(rf.Headings, ReadingHeading{
				Offset: ch.Index + 1, Level: 1, Title: ch.Title, Words: ch.Words,
			})
			rf.Words += ch.Words
		}
		rf.Encoding = "utf-8"
		return []ReadingFile{rf}, nil
	case ext == ".doc":
		return nil, fmt.Errorf("暂不支持 .doc，请另存为 .docx")
	}
	return nil, fmt.Errorf("不支持的书籍格式：%s", filepath.Base(abs))
}

// readingWalkItem 待解析文件。
type readingWalkItem struct {
	path string
	rel  string
	info os.FileInfo
}

// collectReadingFiles 收集书根下的支持文件（只读元数据，不读内容）。
func collectReadingFiles(abs string, opts ReadingScanOptions, warnings *[]string) []readingWalkItem {
	ignore := make(map[string]bool, len(readingIgnoreDirs)+len(opts.IgnoreDirs))
	for k := range readingIgnoreDirs {
		ignore[strings.ToLower(k)] = true
	}
	for _, d := range opts.IgnoreDirs {
		d = strings.TrimSpace(d)
		if d != "" {
			ignore[strings.ToLower(strings.Trim(d, "/\\"))] = true
		}
	}
	var items []readingWalkItem
	docWarned := false
	var walkDir func(dir, rel string, depth int) error
	walkDir = func(dir, rel string, depth int) error {
		if len(items) >= opts.MaxFiles {
			return filepath.SkipAll
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			if warnings != nil {
				*warnings = append(*warnings, "无法读取目录："+rel)
			}
			return nil
		}
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			if entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			full := filepath.Join(dir, name)
			childRel := name
			if rel != "" {
				childRel = rel + "/" + name
			}
			if entry.IsDir() {
				if depth >= opts.MaxDepth || ignore[strings.ToLower(name)] {
					continue
				}
				if err := walkDir(full, childRel, depth+1); err != nil {
					return err
				}
				continue
			}
			if !entry.Type().IsRegular() {
				continue
			}
			ext := strings.ToLower(filepath.Ext(name))
			if !readingTextExts[ext] && ext != ".docx" && ext != ".epub" {
				if ext == ".doc" && !docWarned {
					docWarned = true
					if warnings != nil {
						*warnings = append(*warnings, "暂不支持 .doc，请另存为 .docx（"+name+"）")
					}
				}
				continue
			}
			if len(items) >= opts.MaxFiles {
				if warnings != nil {
					*warnings = append(*warnings, fmt.Sprintf("文件数超过 %d，已停止扫描", opts.MaxFiles))
				}
				return filepath.SkipAll
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			items = append(items, readingWalkItem{path: full, rel: childRel, info: info})
		}
		return nil
	}
	_ = walkDir(abs, "", 0)
	return items
}

// scanReadingDir 目录扫描：收集文件列表后 4 worker 并发解析，结果再统一排序。
func (a *App) scanReadingDir(abs string, opts ReadingScanOptions, scan *ReadingScan) ([]ReadingFile, error) {
	items := collectReadingFiles(abs, opts, &scan.Warnings)
	files := make([]ReadingFile, len(items))
	jobs := make(chan int)
	var wg sync.WaitGroup
	worker := func() {
		defer wg.Done()
		for idx := range jobs {
			files[idx] = processReadingFile(items[idx].path, items[idx].rel, items[idx].info, opts, scan)
		}
	}
	for i := 0; i < readingScanWorkers; i++ {
		wg.Add(1)
		go worker()
	}
	for i := range items {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	sortReadingFiles(files)
	return files, nil
}

// processReadingFile 解析单个文件：文本按行，docx 按块，epub（目录内）仅占位。
func processReadingFile(path, rel string, info os.FileInfo, opts ReadingScanOptions, scan *ReadingScan) ReadingFile {
	rf := ReadingFile{
		Rel:     rel,
		Name:    filepath.Base(rel),
		Ext:     strings.ToLower(filepath.Ext(rel)),
		Size:    info.Size(),
		ModTime: info.ModTime().UnixMilli(),
	}
	if rf.Size > opts.MaxFileBytes {
		rf.Error = fmt.Sprintf("文件超过 %d MB，已跳过", opts.MaxFileBytes>>20)
		scan.Warnings = append(scan.Warnings, rel+"："+rf.Error)
		return rf
	}
	switch {
	case rf.Ext == ".docx":
		blocks, err := parseReadingDocxFile(path)
		if err != nil {
			rf.Error = err.Error()
			return rf
		}
		texts := make([]string, len(blocks))
		for i, b := range blocks {
			texts[i] = b.PlainText()
		}
		cum := blockWordPrefix(texts)
		for i, b := range blocks {
			if b.Kind < "h1" || b.Kind > "h6" {
				continue
			}
			level, _ := strconv.Atoi(b.Kind[1:])
			rf.Headings = append(rf.Headings, ReadingHeading{
				Offset: i + 1,
				Level:  level,
				Title:  strings.TrimSpace(b.Text),
			})
		}
		for i := range rf.Headings {
			end := readingHeadingEnd(rf.Headings, i, len(blocks)+1)
			rf.Headings[i].Words = int(cum[end-1] - cum[rf.Headings[i].Offset-1])
		}
		rf.Words = int(cum[len(texts)])
		rf.Encoding = "utf-8"
	case rf.Ext == ".epub":
		// 目录内的 epub 不在扫描期解包（避免整本书预提取），打开时再走 PrepareReadingEpub。
		rf.Encoding = "utf-8"
	default:
		raw, err := os.ReadFile(path)
		if err != nil {
			rf.Error = err.Error()
			return rf
		}
		text, enc, err := decodeReadingText(raw)
		if err != nil {
			rf.Error = err.Error()
			return rf
		}
		rf.Encoding = enc
		lines := splitReadingLines(text)
		if rf.Ext == ".txt" {
			rf.Headings = scanTxtHeadings(lines, opts.MaxHeadingsPerFile)
		} else {
			rf.Headings = scanMdHeadings(lines, opts.MaxHeadingsPerFile)
		}
		if len(rf.Headings) >= opts.MaxHeadingsPerFile {
			scan.Warnings = append(scan.Warnings, rel+"：标题数超过上限，已截断")
		}
		cum := readingWordPrefix(lines)
		for i := range rf.Headings {
			end := readingHeadingEnd(rf.Headings, i, len(lines)+1)
			rf.Headings[i].Words = int(cum[end-1] - cum[rf.Headings[i].Offset-1])
		}
		rf.Words = int(cum[len(lines)])
	}
	return rf
}

// readingHeadingEnd 标题 i 的结束 offset（不含）：下一个同级/更高级标题的 offset，否则 defaultEnd。
func readingHeadingEnd(hs []ReadingHeading, i, defaultEnd int) int {
	for j := i + 1; j < len(hs); j++ {
		if hs[j].Level <= hs[i].Level {
			return hs[j].Offset
		}
	}
	return defaultEnd
}

func blockWordPrefix(texts []string) []int64 {
	cum := make([]int64, len(texts)+1)
	for i, t := range texts {
		cum[i+1] = cum[i] + int64(countReadingWords(t))
	}
	return cum
}

func splitReadingLines(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return strings.Split(text, "\n")
}

// scanMdHeadings 提取 Markdown ATX 标题，跳过 fenced code。
func scanMdHeadings(lines []string, maxHeadings int) []ReadingHeading {
	var headings []ReadingHeading
	inFence := false
	fenceChar := byte(0)
	fenceLen := 0
	for i, line := range lines {
		if inFence {
			if m := reReadingFence.FindStringSubmatch(line); m != nil && m[1][0] == fenceChar && len(m[1]) >= fenceLen {
				inFence = false
			}
			continue
		}
		if m := reReadingFence.FindStringSubmatch(line); m != nil {
			inFence = true
			fenceChar = m[1][0]
			fenceLen = len(m[1])
			continue
		}
		m := reReadingATX.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		title := strings.TrimSpace(m[2])
		if title == "" {
			continue
		}
		headings = append(headings, ReadingHeading{Offset: i + 1, Level: len(m[1]), Title: title})
		if len(headings) >= maxHeadings {
			break
		}
	}
	return headings
}

// scanTxtHeadings 纯文本逐行跑卷/章关键词；卷 → level 1，章 → level 2。
func scanTxtHeadings(lines []string, maxHeadings int) []ReadingHeading {
	var headings []ReadingHeading
	for i, line := range lines {
		line = strings.TrimRight(line, " \t")
		if m := reReadingVolume.FindStringSubmatch(line); m != nil {
			headings = append(headings, ReadingHeading{Offset: i + 1, Level: 1, Title: strings.TrimSpace(line)})
		} else if m := reReadingChap.FindStringSubmatch(line); m != nil {
			headings = append(headings, ReadingHeading{Offset: i + 1, Level: 2, Title: strings.TrimSpace(line)})
		}
		if len(headings) >= maxHeadings {
			break
		}
	}
	return headings
}

// --- 结构 profile 判定（§4.3） ---

type readingFileStat struct {
	ChapterHits int
	Headings    int
	MaxLevel    int
	Named       bool
}

func fillReadingProfile(scan *ReadingScan) {
	n := len(scan.Files)
	if n == 0 {
		scan.Profile = "file"
		scan.Warnings = append(scan.Warnings, "目录中没有找到支持的文件（md/txt/docx/epub）")
		return
	}
	stats := make([]readingFileStat, n)
	for i := range scan.Files {
		f := &scan.Files[i]
		s := &stats[i]
		s.Named = readingChapterNameRe.MatchString(strings.TrimSuffix(f.Name, filepath.Ext(f.Name)))
		if f.Ext == ".txt" {
			for _, h := range f.Headings {
				if reReadingChap.MatchString(h.Title) {
					s.ChapterHits++
				}
				s.Headings++
				if h.Level > s.MaxLevel {
					s.MaxLevel = h.Level
				}
			}
		} else if f.Ext != ".epub" || len(f.Headings) > 0 {
			for _, h := range f.Headings {
				if reReadingChap.MatchString(h.Title) {
					s.ChapterHits++
				}
				s.Headings++
				if h.Level > s.MaxLevel {
					s.MaxLevel = h.Level
				}
			}
		}
	}
	totalHeadings, totalHits := 0, 0
	for _, s := range stats {
		totalHeadings += s.Headings
		totalHits += s.ChapterHits
	}
	med := func(values []int) int {
		if len(values) == 0 {
			return 0
		}
		sorted := append([]int(nil), values...)
		sort.Ints(sorted)
		return sorted[len(sorted)/2]
	}
	chapHits := make([]int, n)
	headCounts := make([]int, n)
	for i, s := range stats {
		chapHits[i] = s.ChapterHits
		headCounts[i] = s.Headings
	}
	multi := 0
	named := 0
	for _, s := range stats {
		if s.ChapterHits >= 2 {
			multi++
		}
		if s.Named {
			named++
		}
	}
	maxLevel := 0
	for _, s := range stats {
		if s.MaxLevel > maxLevel {
			maxLevel = s.MaxLevel
		}
	}
	fileScore := 0.0
	if n >= 3 && med(chapHits) <= 1 && med(headCounts) <= 2 {
		fileScore += 0.5
	}
	if named*2 >= n {
		fileScore += 0.3
	}
	if multi == 0 {
		fileScore += 0.2
	}
	splitScore := 0.0
	if multi > 0 && n <= 20 {
		splitScore += 0.6
	}
	if multi*2 >= n {
		splitScore += 0.2
	}
	anyFive := false
	for _, s := range stats {
		if s.ChapterHits >= 5 {
			anyFive = true
			break
		}
	}
	if anyFive {
		splitScore += 0.2
	}
	treeScore := 0.0
	if maxLevel >= 3 {
		treeScore += 0.4
	}
	if totalHeadings/n >= 8 {
		treeScore += 0.3
	}
	if totalHits*5 < totalHeadings { // 密度 < 0.2
		treeScore += 0.2
	}
	if n <= 20 {
		treeScore += 0.1
	}
	type profileCandidate struct {
		name  string
		score float64
	}
	cands := []profileCandidate{{"file", fileScore}, {"split", splitScore}, {"tree", treeScore}}
	best := cands[0]
	for _, c := range cands[1:] {
		if c.score > best.score {
			best = c
		}
	}
	// 同分或分差 <0.1：优先 tree，其次 split，最后 file
	for _, prio := range []string{"tree", "split", "file"} {
		for _, c := range cands {
			if c.name == prio && best.score-c.score < 0.1 {
				best = c
				break
			}
		}
		if best.name == prio {
			break
		}
	}
	scan.Profile = best.name
	scan.Confidence = best.score
	if best.score < 0.6 {
		scan.Warnings = append(scan.Warnings, fmt.Sprintf(
			"结构识别置信度较低（%.2f），可在「结构设置」中手动调整", best.score))
	}
}

// --- 排序（§4.4） ---

// 阅读分组：详情页 -1 → 前言 0 → 正文 1 → 番外 2 → 扩展/附录/后记 3。
const (
	readingGroupDetail   = -1
	readingGroupFront    = 0
	readingGroupMain     = 1
	readingGroupExtra    = 2
	readingGroupAppendix = 3
)

type readingSortKey struct {
	group  int
	num    float64
	hasNum bool
	title  string
	rel    string
}

// classifyReadingTitle 对标题/文件名做分组与数字提取。返回 ok=false 表示无关键词也无数字前缀。
func classifyReadingTitle(s string) (readingSortKey, bool) {
	key := readingSortKey{group: readingGroupMain, title: s}
	m := reReadingVolume.FindStringSubmatch(s)
	if m != nil {
		head := strings.TrimSpace(m[1])
		if strings.HasPrefix(head, "第") {
			// 第N卷：N==0 详情页，N>0 正文序列；番外卷/扩展卷等 → 扩展/附录组
			if n, ok := parseReadingNumeral(numeralPart(head)); ok {
				if n == 0 {
					key.group = readingGroupDetail
					key.num, key.hasNum = 0, true
					return key, true
				}
				key.num, key.hasNum = n, true
			}
			return key, true
		}
		key.group = readingGroupAppendix
		return key, true
	}
	m = reReadingChap.FindStringSubmatch(s)
	if m != nil {
		head := strings.TrimSpace(m[1])
		switch {
		case strings.HasPrefix(head, "第"):
			if n, ok := parseReadingNumeral(numeralPart(head)); ok {
				if n == 0 {
					key.group = readingGroupFront
				}
				key.num, key.hasNum = n, true
			}
		case head == "序章" || head == "楔子" || head == "引子" || head == "前言" || head == "引言":
			key.group = readingGroupFront
		case head == "后记" || head == "附录":
			key.group = readingGroupAppendix
		case head == "尾声" || head == "终章":
			key.group = readingGroupMain // 无数字，自然排在编号章节之后
		default: // 番外…（含番外N）
			key.group = readingGroupExtra
			rest := strings.TrimPrefix(strings.TrimPrefix(head, "番外"), "篇")
			rest = strings.TrimRight(strings.TrimSpace(rest), " \t-—·:：、.．")
			if n, ok := parseReadingNumeral(rest); ok {
				key.num, key.hasNum = n, true
			}
		}
		return key, true
	}
	if m := reReadingNumPre.FindStringSubmatch(s); m != nil {
		if n, ok := parseReadingNumeral(m[1]); ok {
			key.num, key.hasNum = n, true
			return key, true
		}
	}
	return key, false
}

// numeralPart 从「第…卷/章」头部取出数字段。
func numeralPart(head string) string {
	head = strings.TrimPrefix(strings.TrimSpace(head), "第")
	head = strings.TrimLeft(head, " \t")
	for j, r := range head {
		if _, ok := cnReadingDigit[r]; ok {
			continue
		}
		if r >= '0' && r <= '9' {
			continue
		}
		return head[:j]
	}
	return head
}

func sortReadingFiles(files []ReadingFile) {
	keys := make([]readingSortKey, len(files))
	detailRe := regexp.MustCompile(`^(第0卷[-_ ]?基本信息|基本信息|简介)$`)
	for i := range files {
		base := strings.TrimSuffix(files[i].Name, filepath.Ext(files[i].Name))
		if detailRe.MatchString(base) {
			keys[i] = readingSortKey{group: readingGroupDetail, num: 0, hasNum: true, title: base, rel: files[i].Rel}
			continue
		}
		k, _ := classifyReadingTitle(base)
		k.title, k.rel = base, files[i].Rel
		keys[i] = k
	}
	// 插入排序按 key 排序 files（保持两者同步）
	idx := make([]int, len(files))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool {
		return readingSortLess(keys[idx[a]], keys[idx[b]])
	})
	sorted := make([]ReadingFile, len(files))
	for i, id := range idx {
		sorted[i] = files[id]
	}
	copy(files, sorted)
}

func readingSortLess(a, b readingSortKey) bool {
	if a.group != b.group {
		return a.group < b.group
	}
	if a.hasNum != b.hasNum {
		return a.hasNum // 有数字的排前面
	}
	if a.hasNum && a.num != b.num {
		return a.num < b.num
	}
	return readingNaturalLess(a.title, b.title)
}

// readingNaturalLess 自然序：数字段按数值比较，其余按 UTF-8 字节序。
func readingNaturalLess(a, b string) bool {
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		ca, cb := a[i], b[j]
		da, db := ca >= '0' && ca <= '9', cb >= '0' && cb <= '9'
		if da && db {
			ia, ja := i, j
			for ia < len(a) && a[ia] >= '0' && a[ia] <= '9' {
				ia++
			}
			for ja < len(b) && b[ja] >= '0' && b[ja] <= '9' {
				ja++
			}
			na, _ := strconv.ParseFloat(a[i:ia], 64)
			nb, _ := strconv.ParseFloat(b[j:ja], 64)
			if na != nb {
				return na < nb
			}
			i, j = ia, ja
			continue
		}
		if ca != cb {
			// 按 rune 比较保证 UTF-8 多字节字符语义稳定
			ra, _ := utf8.DecodeRuneInString(a[i:])
			rb, _ := utf8.DecodeRuneInString(b[j:])
			return ra < rb
		}
		_, wa := utf8.DecodeRuneInString(a[i:])
		_, wb := utf8.DecodeRuneInString(b[j:])
		i += wa
		j += wb
	}
	return len(a)-i < len(b)-j
}

// --- 书籍元数据（§3.3） ---

var readingMetaFilePriority = []string{"第0卷 基本信息", "第0卷基本信息", "基本信息", "简介", "readme"}

var (
	reReadingMetaTitle = regexp.MustCompile(`^\s*\*{0,2}书名\*{0,2}\s*[:：]\s*(.+?)\s*$`)
	reReadingMetaAuth  = regexp.MustCompile(`^\s*\*{0,2}作者\*{0,2}\s*[:：]\s*(.+?)\s*$`)
	reReadingMetaIntro = regexp.MustCompile(`^\s*\*{0,2}(简介|介绍|内容提要)\*{0,2}\s*[:：]\s*(.*)$`)
	reReadingFMTitle   = regexp.MustCompile(`^(title|书名)\s*[:：]\s*(.+?)\s*$`)
	reReadingFMAuth    = regexp.MustCompile(`^(author|作者)\s*[:：]\s*(.+?)\s*$`)
	reReadingFMIntro   = regexp.MustCompile(`^(description|简介|介绍)\s*[:：]\s*(.*)$`)
)

// extractReadingMeta 从书根目录提取书名/作者/简介（第0卷/基本信息/简介/README 优先）。
func extractReadingMeta(root string) (title, author, intro string) {
	for _, base := range readingMetaFilePriority {
		for _, ext := range []string{".md", ".markdown", ".txt"} {
			path := filepath.Join(root, base+ext)
			info, err := os.Stat(path)
			if err != nil || info.IsDir() || info.Size() > 4<<20 {
				continue
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			text, _, err := decodeReadingText(raw)
			if err != nil {
				continue
			}
			t, a2, i := parseReadingMetaText(text)
			if title == "" {
				title = t
			}
			if author == "" {
				author = a2
			}
			if intro == "" {
				intro = i
			}
			if title != "" && author != "" && intro != "" {
				return title, author, intro
			}
		}
	}
	return title, author, intro
}

func parseReadingMetaText(text string) (title, author, intro string) {
	lines := splitReadingLines(text)
	// YAML front matter
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		for i := 1; i < len(lines); i++ {
			line := strings.TrimSpace(lines[i])
			if line == "---" || line == "..." {
				break
			}
			if m := reReadingFMTitle.FindStringSubmatch(line); m != nil && title == "" {
				title = strings.Trim(m[2], `"'`)
			}
			if m := reReadingFMAuth.FindStringSubmatch(line); m != nil && author == "" {
				author = strings.Trim(m[2], `"'`)
			}
			if m := reReadingFMIntro.FindStringSubmatch(line); m != nil && intro == "" {
				intro = strings.Trim(m[2], `"'`)
			}
		}
	}
	for _, line := range lines {
		if m := reReadingMetaTitle.FindStringSubmatch(line); m != nil && title == "" {
			title = strings.TrimSpace(m[1])
		}
		if m := reReadingMetaAuth.FindStringSubmatch(line); m != nil && author == "" {
			author = strings.TrimSpace(m[1])
		}
		if m := reReadingMetaIntro.FindStringSubmatch(line); m != nil && intro == "" {
			intro = strings.TrimSpace(m[2])
			if intro == "" {
				// 简介内容在下一行的场景
				continue
			}
		}
	}
	return title, author, intro
}

// SuggestReadingBooks 书架候选：统计一级~三级子目录的书籍特征（仅元数据，不读内容）。
func (a *App) SuggestReadingBooks(workspace string, limit int) []ReadingBookSuggestion {
	if limit <= 0 {
		limit = 12
	}
	abs, err := filepath.Abs(strings.TrimSpace(workspace))
	if err != nil {
		return []ReadingBookSuggestion{}
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return []ReadingBookSuggestion{}
	}
	var suggestions []ReadingBookSuggestion
	var inspect func(dir, display string, depth int)
	inspect = func(dir, display string, depth int) {
		if len(suggestions) >= limit*4 {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		var books, named int64
		var bytes int64
		var subdirs []string
		bookishSub := false
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			if entry.IsDir() {
				if readingIgnoreDirs[strings.ToLower(name)] {
					continue
				}
				subdirs = append(subdirs, name)
				continue
			}
			ext := strings.ToLower(filepath.Ext(name))
			if !readingTextExts[ext] && ext != ".docx" && ext != ".epub" {
				continue
			}
			fi, err := entry.Info()
			if err != nil {
				continue
			}
			books++
			bytes += fi.Size()
			if readingChapterNameRe.MatchString(strings.TrimSuffix(name, filepath.Ext(name))) {
				named++
			}
		}
		for _, name := range []string{"正文", "分卷", "设定", "世界观", "章节"} {
			for _, sub := range subdirs {
				if sub == name {
					bookishSub = true
				}
			}
		}
		if books >= 2 {
			score := float64(books) + float64(named)*1.5
			if bookishSub {
				score += 3
			}
			suggestions = append(suggestions, ReadingBookSuggestion{
				Root:     dir,
				Name:     display,
				Books:    int(books),
				Named:    int(named),
				Bytes:    bytes,
				EstWords: bytes / 3,
				Score:    score,
			})
		}
		if depth < 2 {
			for _, sub := range subdirs {
				subDisplay := sub
				if display != "" && display != filepath.Base(abs) {
					subDisplay = display + " · " + sub
				} else if display != "" {
					subDisplay = display + " · " + sub
				}
				inspect(filepath.Join(dir, sub), subDisplay, depth+1)
			}
		}
	}
	inspect(abs, filepath.Base(abs), 0)
	// 工作区本身就是章节目录时直接作为一本书
	if len(suggestions) == 0 {
		if direct := countReadingSupportedFiles(abs, 0); direct >= 2 {
			suggestions = append(suggestions, ReadingBookSuggestion{
				Root: abs, Name: filepath.Base(abs), Score: 1,
			})
		}
	}
	sort.SliceStable(suggestions, func(i, j int) bool {
		return suggestions[i].Score > suggestions[j].Score
	})
	if len(suggestions) > limit {
		suggestions = suggestions[:limit]
	}
	return suggestions
}

func countReadingSupportedFiles(dir string, depth int) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	count := 0
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if readingTextExts[ext] || ext == ".docx" || ext == ".epub" {
			count++
		}
	}
	return count
}
