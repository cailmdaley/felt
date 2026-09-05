package cmd

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

func saveFindGlobals() func() {
	prevStatus, prevTags, prevBody := findStatus, findTags, findBody
	prevExact, prevRegex, prevHasFields := findExact, findRegex, findHasFields
	prevVerbose, prevLimit, prevJSON := findVerbose, findLimit, jsonOutput

	findStatus, findTags, findBody = "", nil, false
	findExact, findRegex, findHasFields = false, false, nil
	findVerbose, findLimit, jsonOutput = false, findOuterCap, false

	for _, name := range []string{"status", "tag", "body", "exact", "regex", "has-field", "verbose", "limit"} {
		if f := findCmd.Flags().Lookup(name); f != nil {
			f.Changed = false
		}
	}

	return func() {
		findStatus, findTags, findBody = prevStatus, prevTags, prevBody
		findExact, findRegex, findHasFields = prevExact, prevRegex, prevHasFields
		findVerbose, findLimit, jsonOutput = prevVerbose, prevLimit, prevJSON
	}
}

// TestFindSearchesTheWholeStore: find is the verb whose whole job is finding
// things, so it crosses the view boundary — local hits first under their local
// ids, the rest of the store under a separator naming it, each by its full id
// there. This store's own subtree never appears twice.
func TestFindSearchesTheWholeStore(t *testing.T) {
	_, subProj := newCrossStoreFixture(t)
	defer saveFindGlobals()()
	defer saveShowGlobals()()

	out, err := runCommand(t, subProj, "find", "debug")
	if err != nil {
		t.Fatalf("find: %v\n%s", err, out)
	}
	root := loomRoot(t, subProj)
	if !strings.Contains(out, "── elsewhere in "+root+" ──") {
		t.Fatalf("find output missing the enclosing-store separator:\n%s", out)
	}
	if !strings.Contains(out, "ai-futures/portolan/debug") {
		t.Fatalf("find output missing the outer hit:\n%s", out)
	}
	if strings.Contains(out, "ai-futures/felt/debug") {
		t.Fatalf("find repeats a local fiber in the outer block:\n%s", out)
	}
	local := strings.Index(out, " debug\n")
	if local == -1 || local > strings.Index(out, "── elsewhere") {
		t.Fatalf("local hits should print before the outer block:\n%s", out)
	}

	// The outer id printed there is directly actionable from right here.
	showOut, err := runCommand(t, subProj, "show", "ai-futures/portolan/debug", "--detail", "name")
	if err != nil {
		t.Fatalf("show on an id from the outer block: %v\n%s", err, showOut)
	}
	if !strings.Contains(showOut, "Portolan debug") {
		t.Fatalf("show output = %q", showOut)
	}
}

// TestFindAcceptsSearchShapedFilters: -t and --body ask the same question a
// query does, and reach just as far.
func TestFindAcceptsSearchShapedFilters(t *testing.T) {
	for _, filter := range [][]string{
		{"-t", "decision"},
		{"--body", "Charted"},
	} {
		t.Run(strings.Join(filter, " "), func(t *testing.T) {
			_, subProj := newCrossStoreFixture(t)
			defer saveFindGlobals()()

			out, err := runCommand(t, subProj, append([]string{"find"}, filter...)...)
			if err != nil {
				t.Fatalf("find %v: %v\n%s", filter, err, out)
			}
			if !strings.Contains(out, "── in ") {
				t.Fatalf("filter %v did not reach the enclosing store:\n%s", filter, out)
			}
		})
	}
}

// TestFindCapsTheOuterBlock: a loom holds thousands of fibers, so the outer
// block stops at the cap and closes with an EXACT count of the remainder and
// the flag that lifts it — a truncation the reader can act on.
func TestFindCapsTheOuterBlock(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	loom := felt.NewStorage(loomProj)
	// 25 flat siblings: past the cap, and none is an ancestor of another, so
	// containment collapse cannot fold them.
	for i := 0; i < 25; i++ {
		writeFixtureFelt(t, loom, fmt.Sprintf("swarm-%02d", i), fmt.Sprintf("Swarm %d", i))
	}
	defer saveFindGlobals()()

	out, err := runCommand(t, subProj, "find", "swarm-")
	if err != nil {
		t.Fatalf("find swarm-: %v\n%s", err, out)
	}
	if strings.Count(out, "swarm-") < findOuterCap {
		t.Fatalf("find printed fewer than the cap:\n%s", out)
	}
	if !strings.Contains(out, "… 5 more — refine the query or pass --limit 0") {
		t.Fatalf("missing exact remainder line:\n%s", out)
	}

	uncapped, err := runCommand(t, subProj, "find", "swarm-", "--limit", "0")
	if err != nil {
		t.Fatalf("find --limit 0: %v\n%s", err, uncapped)
	}
	if strings.Contains(uncapped, "more — refine the query") {
		t.Fatalf("--limit 0 still capped:\n%s", uncapped)
	}
	if !strings.Contains(uncapped, "swarm-24") {
		t.Fatalf("--limit 0 lost the tail:\n%s", uncapped)
	}
}

// TestFindInTopLevelStoreIsALocalSearch: a store that encloses nothing has no
// outer half; find is simply a search of that store, with no separator.
func TestFindInTopLevelStoreIsALocalSearch(t *testing.T) {
	dir, storage := newStore(t)
	writeFixtureFelt(t, storage, "kanban", "Kanban board")
	writeFixtureFelt(t, storage, "unrelated", "Unrelated")
	defer saveFindGlobals()()

	out, err := runCommand(t, dir, "find", "kanban")
	if err != nil {
		t.Fatalf("find in a top-level store: %v\n%s", err, out)
	}
	if !strings.Contains(out, "kanban") {
		t.Fatalf("find lost the hit:\n%s", out)
	}
	if strings.Contains(out, "elsewhere in") {
		t.Fatalf("top-level find printed an outer block:\n%s", out)
	}
	if strings.Contains(out, "unrelated") {
		t.Fatalf("find ignored the query:\n%s", out)
	}
}

// TestFindNeedsSomethingToSearchFor: a bare `felt find` is `felt ls` asked
// wrong; say so rather than dumping the loom.
func TestFindNeedsSomethingToSearchFor(t *testing.T) {
	_, subProj := newCrossStoreFixture(t)
	defer saveFindGlobals()()

	out, err := runCommand(t, subProj, "find")
	if err == nil {
		t.Fatalf("bare find should error, got:\n%s", out)
	}
	if !strings.Contains(err.Error(), "felt ls") {
		t.Fatalf("error = %q, want it to point at ls", err)
	}
}

// TestFindClosedHintCountsBothStores: closed matches are suppressed and
// counted, and the count covers the outer block too.
func TestFindClosedHintCountsBothStores(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	loom := felt.NewStorage(loomProj)
	closedAt := time.Now()
	if err := loom.Write(&felt.Felt{
		ID: "retired-debug", Name: "Retired debug",
		Status: felt.StatusClosed, CreatedAt: closedAt, ClosedAt: &closedAt,
	}); err != nil {
		t.Fatalf("write closed fiber: %v", err)
	}
	defer saveFindGlobals()()

	out, err := runCommand(t, subProj, "find", "debug")
	if err != nil {
		t.Fatalf("find debug: %v\n%s", err, out)
	}
	if !strings.Contains(out, "(+1 closed — add -s closed)") {
		t.Fatalf("missing closed hint:\n%s", out)
	}
	if strings.Contains(out, "retired-debug") {
		t.Fatalf("closed match should be counted, not printed:\n%s", out)
	}

	closed, err := runCommand(t, subProj, "find", "debug", "-s", "closed")
	if err != nil {
		t.Fatalf("find -s closed: %v\n%s", err, closed)
	}
	if !strings.Contains(closed, "retired-debug") {
		t.Fatalf("-s closed did not surface it:\n%s", closed)
	}
}

// TestFindJSONIsOneMergedArray: -j is a wire. One array, each fiber in the
// coordinates it was printed in, each naming the store that holds it — and
// uncapped, because a machine consumer wants the whole answer.
func TestFindJSONIsOneMergedArray(t *testing.T) {
	loomProj, subProj := newCrossStoreFixture(t)
	loom := felt.NewStorage(loomProj)
	for i := 0; i < 25; i++ {
		writeFixtureFelt(t, loom, fmt.Sprintf("debug-%02d", i), fmt.Sprintf("Debug %d", i))
	}
	defer saveFindGlobals()()

	out, err := runCommand(t, subProj, "find", "debug", "--json")
	if err != nil {
		t.Fatalf("find --json: %v\n%s", err, out)
	}
	var hits []struct {
		ID    string `json:"id"`
		Store string `json:"store"`
	}
	if err := json.Unmarshal([]byte(out), &hits); err != nil {
		t.Fatalf("find --json did not emit JSON: %v\n%s", err, out)
	}
	if len(hits) < 26 {
		t.Fatalf("--json should be uncapped, got %d entries", len(hits))
	}

	byID := map[string]string{}
	for _, hit := range hits {
		byID[hit.ID] = hit.Store
	}
	localRoot := felt.NewStorage(subProj).Root()
	if got := byID["debug"]; got != localRoot {
		t.Fatalf("local hit store = %q, want %q", got, localRoot)
	}
	if got := byID["ai-futures/portolan/debug"]; got != loomRoot(t, subProj) {
		t.Fatalf("outer hit store = %q, want the enclosing root", got)
	}
	if _, ok := byID["ai-futures/felt/debug"]; ok {
		t.Fatalf("--json repeats a local fiber under its outer id: %v", byID)
	}

	// An explicit --limit still caps the outer half, for a consumer that asks.
	capped, err := runCommand(t, subProj, "find", "debug", "--json", "--limit", "3")
	if err != nil {
		t.Fatalf("find --json --limit 3: %v\n%s", err, capped)
	}
	var cappedHits []struct{}
	if err := json.Unmarshal([]byte(capped), &cappedHits); err != nil {
		t.Fatalf("capped --json: %v\n%s", err, capped)
	}
	if len(cappedHits) >= len(hits) {
		t.Fatalf("--limit 3 did not cap the wire: %d vs %d", len(cappedHits), len(hits))
	}
}

// TestFindWithoutLocalHitsNamesTheStorePlainly: "elsewhere" reads as a
// contrast with something above it. With no local hits there is nothing above.
func TestFindWithoutLocalHitsNamesTheStorePlainly(t *testing.T) {
	_, subProj := newCrossStoreFixture(t)
	defer saveFindGlobals()()

	out, err := runCommand(t, subProj, "find", "commons")
	if err != nil {
		t.Fatalf("find commons: %v\n%s", err, out)
	}
	if strings.Contains(out, "elsewhere") {
		t.Fatalf("no local hits, so nothing to be elsewhere from:\n%s", out)
	}
	if !strings.Contains(out, "── in "+loomRoot(t, subProj)+" ──") {
		t.Fatalf("missing the plain store banner:\n%s", out)
	}
}
