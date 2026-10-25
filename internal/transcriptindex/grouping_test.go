package transcriptindex

import "testing"

func TestSearchGroupsBestMessageAndCountsBeforeLimit(t *testing.T) {
	i := testIndex(t)
	for _, h := range []string{"claude", "codex", "pi"} {
		if err := i.IndexFile(ctx, fixture(t, h), h); err != nil {
			t.Fatal(err)
		}
	}
	messages := search(t, i, "src/sky_map.go", Options{PerMessage: true})
	grouped := search(t, i, "src/sky_map.go", Options{})
	if len(messages) != 5 || len(grouped) != 3 {
		t.Fatalf("messages=%+v grouped=%+v", messages, grouped)
	}
	counts := map[string]int{}
	best := map[string]Hit{}
	for _, hit := range messages {
		counts[hit.Session]++
		if _, ok := best[hit.Session]; !ok {
			best[hit.Session] = hit
		}
		if hit.Matches != 1 {
			t.Fatal(hit)
		}
	}
	for n, hit := range grouped {
		want := best[hit.Session]
		if hit.Matches != counts[hit.Session] || hit.Score != want.Score || hit.Line != want.Line || hit.Snippet != want.Snippet {
			t.Fatalf("hit=%+v best=%+v count=%d", hit, want, counts[hit.Session])
		}
		if n > 0 && grouped[n-1].Score < hit.Score {
			t.Fatal("sessions not ranked by best message")
		}
	}
	limited := search(t, i, "src/sky_map.go", Options{Limit: 2})
	if len(limited) != 2 || limited[0] != grouped[0] || limited[1] != grouped[1] {
		t.Fatalf("limit counted messages: %+v", limited)
	}
	filtered := search(t, i, "src/sky_map.go", Options{Harness: "claude"})
	if len(filtered) != 1 || filtered[0].Matches != 2 {
		t.Fatal(filtered)
	}
}
