package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeNotifyEntry(buf []byte, offset int, next uint32, name string, action uint32) int {
	units := utf16Encode(name)
	nameLen := len(units) * 2
	binary.LittleEndian.PutUint32(buf[offset:], next)
	binary.LittleEndian.PutUint32(buf[offset+4:], action)
	binary.LittleEndian.PutUint32(buf[offset+8:], uint32(nameLen))
	for i, u := range units {
		binary.LittleEndian.PutUint16(buf[offset+12+i*2:], u)
	}
	return offset + 12 + nameLen
}

func utf16Encode(s string) []uint16 {
	out := make([]uint16, 0, len(s))
	for _, r := range s {
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			out = append(out, uint16(r))
		}
	}
	return out
}

func TestParseNotifyBuffer(t *testing.T) {
	buf := make([]byte, 256)
	firstLen := 12 + len(utf16Encode("a.txt"))*2
	next := writeNotifyEntry(buf, 0, uint32(firstLen), "a.txt", 1)
	writeNotifyEntry(buf, next, 0, "子目录\\b.json", 3)
	paths, overflow := parseNotifyBuffer(buf, uint32(next+12+len(utf16Encode("子目录\\b.json"))*2))
	if overflow {
		t.Fatal("unexpected overflow")
	}
	if len(paths) != 2 || paths[0] != "a.txt" || paths[1] != "子目录\\b.json" {
		t.Fatalf("unexpected paths: %#v", paths)
	}
	if _, overflow := parseNotifyBuffer(nil, 0); !overflow {
		t.Fatal("zero-size batch should mark overflow")
	}
}

func TestWatchDirectoryReceivesCreate(t *testing.T) {
	dir := t.TempDir()
	stop := make(chan struct{})
	done := make(chan struct{})
	events := make(chan string, 8)
	go func() {
		defer close(done)
		_ = watchDirectory(dir, stop, func(paths []string, overflow bool) {
			for _, path := range paths {
				select {
				case events <- path:
				default:
				}
			}
		})
	}()
	defer func() {
		close(stop)
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatal("watcher did not stop")
		}
	}()
	time.Sleep(150 * time.Millisecond)
	target := filepath.Join(dir, "new-file.txt")
	if err := os.WriteFile(target, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(4 * time.Second)
	for {
		select {
		case name := <-events:
			if strings.Contains(name, "new-file.txt") {
				return
			}
		case <-deadline:
			t.Fatal("did not receive file creation notification")
		}
	}
}
