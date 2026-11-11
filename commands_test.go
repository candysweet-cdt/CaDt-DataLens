package main

import (
	"strings"
	"testing"
	"time"
)

func TestCommandJobBufferIncrementalRead(t *testing.T) {
	job := registerCommandJob("bg-test-incr", "Git Bash", "echo hi")
	defer unregisterCommandJob("bg-test-incr")
	job.writeLine("out", "line-1")
	job.writeLine("err", "oops")
	text, cursor, lost := job.read(0)
	if lost {
		t.Fatal("未超限时不应标记 lost")
	}
	if !strings.Contains(text, "line-1") || !strings.Contains(text, "[stderr] oops") {
		t.Fatalf("首次读取应包含全部行: %q", text)
	}
	job.writeLine("out", "line-2")
	text2, cursor2, _ := job.read(cursor)
	if !strings.Contains(text2, "line-2") || strings.Contains(text2, "line-1") {
		t.Fatalf("增量读取应只包含新行: %q", text2)
	}
	if cursor2 <= cursor {
		t.Fatalf("游标应单调递增: %d -> %d", cursor, cursor2)
	}
}

func TestCommandJobBufferReadChunk(t *testing.T) {
	job := registerCommandJob("bg-test-chunk", "sh", "flood")
	defer unregisterCommandJob("bg-test-chunk")
	job.writeChunk([]byte(strings.Repeat("a", aiJobReadChunk+100)))
	text, cursor, _ := job.read(0)
	if len(text) != aiJobReadChunk {
		t.Fatalf("单次读取应截到 %d 字节，实际 %d", aiJobReadChunk, len(text))
	}
	rest, cursor2, _ := job.read(cursor)
	if len(rest) != 100 {
		t.Fatalf("剩余增量应为 100 字节，实际 %d", len(rest))
	}
	if cursor2 != job.written {
		t.Fatalf("读完游标应等于已写入总量: %d vs %d", cursor2, job.written)
	}
}

func TestCommandJobBufferDropHead(t *testing.T) {
	job := registerCommandJob("bg-test-drop", "sh", "flood")
	defer unregisterCommandJob("bg-test-drop")
	filler := strings.Repeat("x", 4096)
	for i := 0; i < 100; i++ { // 100 * 4KB ≈ 400 KB > 256 KB 缓冲
		job.writeLine("out", filler)
	}
	job.mu.Lock()
	dropped := job.dropped
	job.mu.Unlock()
	if !dropped {
		t.Fatal("超出缓冲后应标记 dropped")
	}
	text, cursor, lost := job.read(0)
	if !lost {
		t.Fatal("超出缓冲后从 0 读应标记 lost")
	}
	if len(text) > aiJobBufferCap {
		t.Fatalf("输出不应超过缓冲容量: %d", len(text))
	}
	if cursor == 0 {
		t.Fatal("游标应已前进")
	}
	// 读完剩余增量直到游标稳定，再次读取应无新增且游标保持
	for {
		_, next, _ := job.read(cursor)
		if next == cursor {
			break
		}
		cursor = next
	}
	_, cursor2, lost2 := job.read(cursor)
	if lost2 {
		t.Fatal("连续读取不应再报 lost")
	}
	if cursor2 != cursor {
		t.Fatalf("无新增输出时游标应保持: %d vs %d", cursor2, cursor)
	}
}

func TestFinishCommandJobEviction(t *testing.T) {
	base := time.Now()
	ids := make([]string, 0, aiJobMaxFinished+2)
	for i := 0; i < aiJobMaxFinished+2; i++ {
		id := "bg-evict-" + string(rune('a'+i))
		ids = append(ids, id)
		registerCommandJob(id, "sh", "noop")
		// 直接写入结束时间，避免依赖时钟精度判断淘汰顺序
		commandJobsMu.Lock()
		j := commandJobs[id]
		j.mu.Lock()
		j.exited = true
		j.endedAt = base.Add(time.Duration(i) * time.Minute)
		j.mu.Unlock()
		commandJobsMu.Unlock()
		finishCommandJob(id, 0)
	}
	commandJobsMu.Lock()
	_, oldestGone := commandJobs[ids[0]]
	_, secondGone := commandJobs[ids[1]]
	_, kept := commandJobs[ids[len(ids)-1]]
	commandJobsMu.Unlock()
	if oldestGone || secondGone {
		t.Fatal("最旧的已结束作业应被淘汰")
	}
	if !kept {
		t.Fatal("最新的已结束作业应保留")
	}
}

func TestCommandJobStatusNotfound(t *testing.T) {
	app := &App{}
	st := app.commandJobStatus("bg-not-exist", 0)
	if st.State != "notfound" {
		t.Fatalf("未知作业应返回 notfound，实际 %s", st.State)
	}
}
