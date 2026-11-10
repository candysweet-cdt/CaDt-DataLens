//go:build windows

package main

import (
	"reflect"
	"testing"
)

func TestSplitIntegrationActions(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"assoc,menu", []string{"assoc", "menu"}},
		{"all", []string{"assoc", "menu", "path", "skill"}},
		{" assoc , ,skill ", []string{"assoc", "skill"}},
		{"", []string{}},
	}
	for _, c := range cases {
		got := splitIntegrationActions(c.in)
		if !reflect.DeepEqual(got, c.want) {
			t.Fatalf("splitIntegrationActions(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestParseIntegrationArgs(t *testing.T) {
	mode, actions := parseIntegrationArgs([]string{
		`C:\Program Files\CaDt-DataLens\datalens.exe`,
		"--integrate=assoc,menu",
		"--line=3",
	})
	if mode != "install" || !reflect.DeepEqual(actions, []string{"assoc", "menu"}) {
		t.Fatalf("install parse = %q %v", mode, actions)
	}

	mode, actions = parseIntegrationArgs([]string{"--unintegrate=all"})
	if mode != "remove" || !reflect.DeepEqual(actions, []string{"assoc", "menu", "path", "skill"}) {
		t.Fatalf("remove parse = %q %v", mode, actions)
	}

	mode, actions = parseIntegrationArgs([]string{"D:\\data\\a.json"})
	if mode != "" || len(actions) != 0 {
		t.Fatalf("plain args parse = %q %v", mode, actions)
	}
}
