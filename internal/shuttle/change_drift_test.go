package shuttle

import "testing"

func TestChangeRetainsStaleFlagsAndDropsMissingRoles(t *testing.T) {
	t.Parallel()
	c := &Change{Files: []ChangeFile{}, Story: &ChangeStory{Flags: []ChangeFlag{{ChangeRange: ChangeRange{File: "gone.go"}, Text: "Keep the judgment"}}, Roles: map[string]string{"gone.go": "generated"}}}
	report := ValidateChange(c, nil)
	if !report.Valid || len(report.Stale) != 1 || len(report.Dropped) != 1 || c.Story.Flags[0].Stale == "" || c.Story.Flags[0].Text != "Keep the judgment" || len(c.Story.Roles) != 0 {
		t.Fatalf("%+v; story: %+v", report, c.Story)
	}
}
