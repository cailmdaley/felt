package shuttle

import "testing"

func TestChangePatchFileMatchesBothHeaderPaths(t *testing.T) {
	c := &Change{Files: []ChangeFile{
		{Path: "renamed\nfile", OldPath: "old\tfile"},
		{Path: "same"},
	}}
	for _, tc := range []struct {
		name, old, next string
		want            int
	}{
		{"rename", "old\tfile", "renamed\nfile", 0},
		{"unchanged path", "same", "same", 1},
		{"wrong old", "renamed\nfile", "renamed\nfile", -1},
		{"wrong new", "old\tfile", "other", -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			header := "diff --git " + changeQuotePath("a/"+tc.old) + " " + changeQuotePath("b/"+tc.next)
			got := c.patchFile([]string{header, "Binary files differ"})
			if tc.want < 0 {
				if got != nil {
					t.Fatalf("unexpected inventory match: %+v", got)
				}
			} else if got != &c.Files[tc.want] {
				t.Fatalf("header %q resolved to %+v, want %+v", header, got, c.Files[tc.want])
			}
		})
	}
}
