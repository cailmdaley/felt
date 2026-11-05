package shuttle

import (
	"reflect"
	"strings"
	"testing"
)

func TestChangeWindowStructuredLines(t *testing.T) {
	c := &Change{Files: []ChangeFile{{Path: "file"}}, Patch: "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -4,2 +4,2 @@\n context\n-old\n+new\n\\ No newline at end of file\n"}
	hunks, err := c.parsePatch()
	if err != nil {
		t.Fatal(err)
	}
	want := []ChangeLine{
		{Kind: "context", Old: 4, New: 4, Text: "context"},
		{Kind: "deletion", Old: 5, Text: "old"},
		{Kind: "addition", New: 5, Text: "new"},
		{Kind: "note", Text: " No newline at end of file"},
	}
	window := hunks[0].Windows[0]
	if window.Rows != len(want) || !reflect.DeepEqual(c.Files[0].Lines[window.Start:window.Start+window.Rows], want) {
		t.Fatalf("window lines: %+v", window)
	}
	c.Story = &ChangeStory{Chapters: []ChangeChapter{{ID: "read", Stops: []ChangeStop{{ChangeRange: ChangeRange{File: "file", From: 5, To: 5}, Importance: "important"}}}}}
	ValidateChange(c, hunks)
	stop := c.Story.Chapters[0].Stops[0]
	excerpt := stop.Hunks[0].Windows[0]
	if got := c.Files[0].Lines[excerpt.Start : excerpt.Start+excerpt.Rows]; !reflect.DeepEqual(got, want[2:]) {
		t.Fatalf("excerpt lines: %+v", got)
	}
	for _, h := range c.Files[0].Remaining {
		for _, w := range h.Windows {
			if w.Start < 0 || w.Start+w.Rows > len(c.Files[0].Lines) {
				t.Fatalf("remaining rows: %+v", w)
			}
		}
	}
}

func TestChangeWindowLinesStayBoundedWithNote(t *testing.T) {
	h := ChangeHunk{rows: []changeRow{}}
	for i := 1; i <= 240; i++ {
		h.rows = append(h.rows, changeRow{text: "+" + strings.Repeat("x", i), new: i, index: len(h.rows)})
		if i == 120 {
			h.rows = append(h.rows, changeRow{text: "\\ No newline at end of file", index: len(h.rows)})
		}
	}
	windows := h.windows()
	if len(windows) != 2 || windows[0].Rows != 121 || windows[1].Rows != 120 {
		t.Fatalf("window bounds: %+v", windows)
	}
	if windows[0].Start != 0 || windows[1].Start != 121 || windows[1].NewFrom != 121 {
		t.Fatalf("window boundary: %+v", windows)
	}
}
