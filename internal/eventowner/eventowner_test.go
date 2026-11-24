package eventowner

// eventowner_test.go：归属表与载荷取字段（原根目录 event_owner_test.go 迁入，
// 去掉依赖 App/winReg 的部分——那一段留在根的 window_route_test.go 之外，
// 由 TestRegisterEventOwnerNeedsWindow 覆盖）。

import (
	"fmt"
	"testing"
)

func TestPayloadString(t *testing.T) {
	cases := []struct {
		name  string
		data  any
		field string
		want  string
	}{
		{"map-string id", map[string]string{"id": "t1", "data": "x"}, "id", "t1"},
		{"map-any id", map[string]interface{}{"id": "b2"}, "id", "b2"},
		{"map-any requestID", map[string]interface{}{"requestID": "r3"}, "requestID", "r3"},
		{"missing", map[string]string{"x": "y"}, "id", ""},
		{"wrong type", map[string]interface{}{"id": 42}, "id", ""},
		{"nil", nil, "id", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := PayloadString(tc.data, tc.field); got != tc.want {
				t.Fatalf("PayloadString(%v, %q) = %q, want %q", tc.data, tc.field, got, tc.want)
			}
		})
	}
}

type idCarrier struct{ id string }

func (c idCarrier) GetID() string { return c.id }

func TestPayloadStringGetID(t *testing.T) {
	if got := PayloadString(idCarrier{id: "r9"}, "id"); got != "r9" {
		t.Fatalf("实现了 GetID 的载荷应取到 id，实际 %q", got)
	}
	// 字段不是 id 时不能借 GetID 冒充
	if got := PayloadString(idCarrier{id: "r9"}, "requestID"); got != "" {
		t.Fatalf("非 id 字段不该走 GetID，实际 %q", got)
	}
}

func TestRegisterLookupUnregister(t *testing.T) {
	Reset()
	defer Reset()

	Register("", "term", "t1")
	if _, ok := Lookup("term", "t1"); ok {
		t.Fatal("无窗口名不应登记 owner")
	}
	Register("main", "  ", "t1")
	Register("main", "term", "  ")
	if Len() != 0 {
		t.Fatalf("空 kind/id 不应登记，实际 %d 条", Len())
	}

	Register("main", " term ", " t2 ")
	if owner, ok := Lookup("term", "t2"); !ok || owner != "main" {
		t.Fatalf("Lookup = (%q, %v)，want (main, true)", owner, ok)
	}
	Unregister("term", "t2")
	if _, ok := Lookup("term", "t2"); ok {
		t.Fatal("Unregister 未摘除登记")
	}
}

// TestEvictionKeepsNewest 钉住「表满按最老淘汰，且不清空整表」：
// 整表清空会把所有活跃归属一次性打回广播（审查 P2-6）。
func TestEvictionKeepsNewest(t *testing.T) {
	Reset()
	defer Reset()

	for i := 0; i < Limit; i++ {
		Register("main", "term", fmt.Sprintf("t%d", i))
	}
	if Len() != Limit {
		t.Fatalf("登记数 = %d，want %d", Len(), Limit)
	}
	// 溢出后再登记一条：最老的 t0 被淘汰，其他全部存活
	Register("main", "term", "new")
	if _, ok := Lookup("term", "t0"); ok {
		t.Fatal("表满应淘汰最老登记")
	}
	if _, ok := Lookup("term", "t1"); !ok {
		t.Fatal("淘汰不该波及次老登记")
	}
	if _, ok := Lookup("term", "new"); !ok {
		t.Fatal("新登记应写入")
	}
	if Len() != Limit {
		t.Fatalf("淘汰后登记数 = %d，want %d", Len(), Limit)
	}
}
