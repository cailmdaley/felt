package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestAbsentNeighborsCannotResolveToLocalTwins(t *testing.T) {
	t.Parallel()
	dir, storage := newStore(t)
	root := "---\nname: Shared\nneighbors: [loom, ai-futures, foreign]\n---\n"
	if err := os.WriteFile(filepath.Join(storage.Root(), "shared.md"), []byte(root), 0644); err != nil {
		t.Fatal(err)
	}
	for _, f := range []*felt.Felt{
		{ID: "local/felt-migration", Name: "Local migration"},
		{ID: "local/ledger", Name: "Local ledger"},
		{ID: "practices/lightcone", Name: "Local lightcone"},
		{ID: "topics/foreign/item", Name: "Local suffix twin"},
		{ID: "destination", Name: "Destination"},
		{ID: "source", Name: "Source", Body: "[[loom/felt/migrations/felt-migration]] [[loom/dream/ledger]] [[ai-futures/lightcone]] [[foreign/item]]"},
		{ID: "reader", Name: "Reader", Body: "[[loom/dream/ledger]] [[local/ledger]] [[topics/foreign/item]]"},
	} {
		if err := storage.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	out, err := runCommand(t, dir, "check", "--json")
	if err != nil {
		t.Fatalf("check: %v: %s", err, out)
	}
	var issues []felt.CheckIssue
	if err := json.Unmarshal([]byte(out), &issues); err != nil {
		t.Fatal(err)
	}
	if len(issues) != 3 {
		t.Fatalf("want only neighbor summaries, not rescued links: %s", out)
	}
	for i, want := range []string{"ai-futures: not mounted, 1 link", "foreign: not mounted, 1 link", "loom: not mounted, 3 links"} {
		if issues[i].Level != felt.CheckLevelInfo || issues[i].FiberID != "shared" || issues[i].Message != want {
			t.Fatalf("unexpected summaries: %s", out)
		}
	}
	for _, command := range []string{"show", "tree"} {
		for _, target := range []string{"loom/felt/migrations/felt-migration", "loom/dream/ledger", "ai-futures/lightcone", "foreign/item"} {
			_, err := runCommand(t, dir, command, target)
			if err == nil || !strings.Contains(err.Error(), "not mounted") {
				t.Fatalf("%s %s resolved locally: %v", command, target, err)
			}
		}
	}
	out, err = runCommand(t, dir, "show", "reader")
	if err != nil || !strings.Contains(out, "Refs:     loom/dream/ledger, local/ledger, topics/foreign/item") {
		t.Fatalf("show rewrote a foreign reference: %v\n%s", err, out)
	}
	citations, _, err := storage.ScanRelationships("local/ledger")
	if err != nil || len(citations) != 1 || citations[0].SourceID != "reader" {
		t.Fatalf("foreign reference became a local citation: %+v, %v", citations, err)
	}
	if _, err := runCommand(t, dir, "nest", "topics/foreign/item", "destination"); err != nil {
		t.Fatal(err)
	}
	if got := mustRead(t, storage, "source").Body; !strings.Contains(got, "[[foreign/item]]") {
		t.Fatalf("move rewrote a foreign link: %s", got)
	}
	if got := mustRead(t, storage, "reader").Body; !strings.Contains(got, "[[destination/item]]") {
		t.Fatalf("move failed to repair the real local link: %s", got)
	}
}
