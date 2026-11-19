package harness

import (
	"encoding/json"
	"os"
	"testing"
)

// TestFactsMatchTheSharedConformanceTable holds the table to
// daemon/test/fixtures/harnesses/facts.json, which the daemon's conformance
// suite reads to know which harnesses its Shuttle.Harness modules must cover
// and what each of them must answer. Regenerate it with
// UPDATE_HARNESS_FACTS=1 go test ./internal/harness.
func TestFactsMatchTheSharedConformanceTable(t *testing.T) {
	t.Parallel()
	const path = "../../daemon/test/fixtures/harnesses/facts.json"
	got, err := json.MarshalIndent(All(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	if os.Getenv("UPDATE_HARNESS_FACTS") == "1" {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("facts table differs from %s; regenerate it:\n%s", path, got)
	}
}

func TestEveryHarnessIsFoundByBothSpellings(t *testing.T) {
	t.Parallel()
	for _, f := range All() {
		for _, spelling := range []string{f.Name, f.Ledger} {
			if got, ok := Lookup(spelling); !ok || got.Name != f.Name {
				t.Errorf("Lookup(%q) = %+v, %v", spelling, got, ok)
			}
		}
		if !Known(f.Name) || (f.Ledger != f.Name && Known(f.Ledger)) {
			t.Errorf("%s: Known accepts only the canonical spelling", f.Name)
		}
	}
	if _, ok := Lookup("gemini"); ok || Normalize("gemini") != "gemini" || LedgerName("gemini") != "" {
		t.Error("an unknown harness resolves")
	}
}
