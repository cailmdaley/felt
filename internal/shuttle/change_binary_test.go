package shuttle

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestChangeBinaryNoticesExcludeLinesAndCoverage(t *testing.T) {
	// A binary notice can describe NUL-containing data or plain text above Git's size threshold.
	c := &Change{
		Files: []ChangeFile{{Path: "text-too-large"}, {Path: "binary"}, {Path: "text"}},
		Patch: "diff --git a/text-too-large b/text-too-large\nnew file mode 100644\nBinary files /dev/null and b/text-too-large differ\n" +
			"diff --git a/binary b/binary\nnew file mode 100644\nBinary files /dev/null and b/binary differ\n" +
			"diff --git a/text b/text\n--- /dev/null\n+++ b/text\n@@ -0,0 +1 @@\n+visible\n",
	}
	hunks, err := c.parsePatch()
	if err != nil {
		t.Fatal(err)
	}
	if len(hunks) != 1 {
		t.Fatalf("hunks: %+v", hunks)
	}
	for _, f := range c.Files[:2] {
		if f.Additions != 0 || f.Deletions != 0 || len(f.Hunks) != 0 || !strings.Contains(f.Header, "Binary files ") {
			t.Fatalf("binary file has counted lines or lost metadata: %+v", f)
		}
	}
	if report := ValidateChange(c, hunks); !report.Valid || report.Total != 1 || report.Covered != 0 {
		t.Fatalf("coverage: %+v", report)
	}
}

func TestChangeJSONInvalidUTF8IsLossy(t *testing.T) {
	line := ChangeLine{Kind: "addition", New: 1, Text: "text\xff\x00"}
	encoded, err := json.Marshal(line)
	if err != nil {
		t.Fatal(err)
	}
	var decoded ChangeLine
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Text != "text\ufffd\x00" {
		t.Fatalf("JSON text: %q", decoded.Text)
	}
}
