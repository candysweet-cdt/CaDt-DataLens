package workspacemark

// workspacemark_test.go：「首次 / 重复 / 归一化」三件事的守门用例。
// 归一化是本包的核心：前端会把 D:\ws 与 d:/ws/ 当成同一个工作区，账本必须同口径，
// 否则换手或跨窗口打开时会重复跑重活。

import (
	"sync"
	"testing"
)

func TestMarkOpenedFirstThenFalse(t *testing.T) {
	Reset()
	if !MarkOpened(`D:\repo\a`) {
		t.Fatal("首次应返回 true")
	}
	if MarkOpened(`D:\repo\a`) {
		t.Fatal("重复应返回 false")
	}
	// 不同工作区各算各的
	if !MarkOpened(`D:\repo\b`) {
		t.Fatal("另一个工作区首次应返回 true")
	}
}

func TestMarkOpenedNormalizes(t *testing.T) {
	Reset()
	if !MarkOpened(`D:\ws`) {
		t.Fatal("首次应返回 true")
	}
	for _, variant := range []string{`d:\ws`, `D:/ws/`, `d:/ws`, `D:\ws\\`} {
		if MarkOpened(variant) {
			t.Fatalf("%q 应视为同一工作区（已打开过）", variant)
		}
	}
}

func TestMarkOpenedEmpty(t *testing.T) {
	Reset()
	if MarkOpened("") || MarkOpened("   ") {
		t.Fatal("空路径不该算打开过（否则首个无根会话会吞掉真实工作区的重活）")
	}
}

func TestReset(t *testing.T) {
	Reset()
	MarkOpened(`D:\ws`)
	Reset()
	if !MarkOpened(`D:\ws`) {
		t.Fatal("Reset 后应重新算首次")
	}
}

// 并发：同一工作区同时被两个窗口打开，只有一个能拿到 true。
func TestMarkOpenedConcurrentSingleWinner(t *testing.T) {
	Reset()
	const n = 8
	var wg sync.WaitGroup
	results := make([]bool, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			results[idx] = MarkOpened(`D:\ws\race`)
		}(i)
	}
	wg.Wait()
	wins := 0
	for _, ok := range results {
		if ok {
			wins++
		}
	}
	if wins != 1 {
		t.Fatalf("并发下应恰好一个 true，got %d", wins)
	}
}
