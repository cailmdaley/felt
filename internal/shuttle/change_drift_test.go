package shuttle

import "testing"

func TestChangeAuthoringErrorsAreNotDrift(t *testing.T) {
	t.Parallel()
	for _, side := range []string{"new", "both"} {
		c := &Change{Story: &ChangeStory{Chapters: []ChangeChapter{{Stops: []ChangeStop{{ChangeRange: ChangeRange{File: "typo.go", Side: side}, Importance: "context"}}}}}}
		if report := ValidateChange(c, nil); report.Valid || len(report.Errors) != 1 || len(report.Stale) != 0 {
			t.Fatalf("explicit %s: %+v", side, report)
		}
		report := ReapplyChange(c, nil)
		if side == "both" && (report.Valid || len(report.Stale) != 0) {
			t.Fatalf("malformed side became stale: %+v", report)
		}
		if side == "new" && (!report.Valid || len(report.Stale) != 1) {
			t.Fatalf("missing file was not retained: %+v", report)
		}
	}
}

func TestChangeRetainsStaleFlagsAndDropsMissingRoles(t *testing.T) {
	t.Parallel()
	c := &Change{Files: []ChangeFile{}, Story: &ChangeStory{Flags: []ChangeFlag{{ChangeRange: ChangeRange{File: "gone.go"}, Text: "Keep the judgment"}}, Roles: map[string]string{"gone.go": "generated"}}}
	report := ReapplyChange(c, nil)
	if !report.Valid || len(report.Stale) != 1 || len(report.Dropped) != 1 || c.Story.Flags[0].Stale == "" || c.Story.Flags[0].Text != "Keep the judgment" || len(c.Story.Roles) != 0 {
		t.Fatalf("%+v; story: %+v", report, c.Story)
	}
}
