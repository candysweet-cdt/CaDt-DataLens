package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeConvertFixture(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestParseConvertArgsSingle(t *testing.T) {
	dir := t.TempDir()
	input := writeConvertFixture(t, dir, "a.json", `{"a":1}`)
	opts, isConvert, err := parseConvertArgs([]string{"--convert", input, "--to", "yml"})
	if err != nil || !isConvert {
		t.Fatalf("parse failed: convert=%v err=%v", isConvert, err)
	}
	if opts.To != "yaml" || len(opts.Jobs) != 1 {
		t.Fatalf("unexpected options: %+v", opts)
	}
	want := filepath.Join(dir, "a.yaml")
	if opts.Jobs[0].Output != want {
		t.Fatalf("output = %q, want %q", opts.Jobs[0].Output, want)
	}
}

func TestParseConvertArgsBatchOutDir(t *testing.T) {
	dir := t.TempDir()
	a := writeConvertFixture(t, dir, "a.json", `{}`)
	b := writeConvertFixture(t, dir, "b.json", `{}`)
	outDir := filepath.Join(dir, "out")
	if err := os.Mkdir(outDir, 0o755); err != nil {
		t.Fatal(err)
	}
	opts, _, err := parseConvertArgs([]string{"--convert", a, b, "--to", "jsonl", "--out", outDir})
	if err != nil {
		t.Fatal(err)
	}
	if len(opts.Jobs) != 2 {
		t.Fatalf("expected 2 jobs, got %d", len(opts.Jobs))
	}
	for _, job := range opts.Jobs {
		if filepath.Dir(job.Output) != outDir || filepath.Ext(job.Output) != ".jsonl" {
			t.Fatalf("unexpected job: %+v", job)
		}
	}
}

func TestParseConvertArgsErrors(t *testing.T) {
	dir := t.TempDir()
	a := writeConvertFixture(t, dir, "a.json", `{}`)
	b := writeConvertFixture(t, dir, "b.json", `{}`)
	cases := [][]string{
		{"--convert", a},
		{"--convert", a, "--to", "exe"},
		{"--convert", a, b, "--to", "yaml", "--stdout"},
		{"--convert", a, "--to", "yaml", "--bogus"},
	}
	for _, args := range cases {
		if _, isConvert, err := parseConvertArgs(args); !isConvert || err == nil {
			t.Fatalf("expected error for %v, isConvert=%v err=%v", args, isConvert, err)
		}
	}
}

func TestParseConvertArgsRefusesOverwrite(t *testing.T) {
	dir := t.TempDir()
	a := writeConvertFixture(t, dir, "a.json", `{}`)
	writeConvertFixture(t, dir, "a.yaml", "existing")
	if _, _, err := parseConvertArgs([]string{"--convert", a, "--to", "yaml"}); err == nil {
		t.Fatal("expected overwrite refusal")
	}
	if _, _, err := parseConvertArgs([]string{"--convert", a, "--to", "yaml", "--force"}); err != nil {
		t.Fatalf("force should allow overwrite: %v", err)
	}
}
