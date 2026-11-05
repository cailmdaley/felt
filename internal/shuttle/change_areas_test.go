package shuttle

import "testing"

func TestChangeAreas(t *testing.T) {
	c := &Change{Story: &ChangeStory{Areas: []ChangeArea{{Name: "Reader", Files: []string{"ui/**"}, Chapter: "reader"}, {Name: "Overlap", Files: []string{"**"}}}}, Files: []ChangeFile{{Path: "ui/a.ts", Role: "implementation", Additions: 3, Deletions: 2}, {Path: "test.go", Role: "test", Additions: 4}}}
	a := resolveChangeAreas(c)
	if len(a) != 2 || a[0].Lines != 5 || a[0].Files[0] != "ui/a.ts" || a[1].Lines != 4 {
		t.Fatalf("areas: %#v", a)
	}
	c.Story = nil
	a = resolveChangeAreas(c)
	if a[0].Name != "Other" || a[1].Name != "Tests" || a[1].Role != "test" {
		t.Fatalf("fallbacks: %#v", a)
	}
	if !areaMatch("ui/**/a.ts", "ui/a.ts") || !areaMatch("ui/**/a.ts", "ui/src/a.ts") || areaMatch("ui/*.ts", "ui/src/a.ts") {
		t.Fatal("glob semantics")
	}
}
