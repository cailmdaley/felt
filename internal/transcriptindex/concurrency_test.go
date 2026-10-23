package transcriptindex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestConcurrentWritersCheckpointOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.sqlite")
	a, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	transcript := fixture(t, "claude")
	ready := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, i := range []*Index{a, b} {
		wg.Add(1)
		go func(i *Index) {
			defer wg.Done()
			<-ready
			errs <- i.IndexFile(context.Background(), transcript, "claude")
		}(i)
	}
	close(ready)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	stats, err := a.Stats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if stats.Messages != 4 {
		t.Fatalf("concurrent writers duplicated rows: %+v", stats)
	}
}

func TestLargeLinesMalformedRecordsAndCancellation(t *testing.T) {
	i := testIndex(t)
	p := filepath.Join(t.TempDir(), "large.jsonl")
	// Harness image lines routinely exceed bufio.Scanner's default limit.
	text := strings.Repeat("word ", 20000) + "largeneedle"
	content := userLine(text) + "{malformed}\n" + userLine("afterbadline")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := i.IndexFile(ctx, p, "claude"); err == nil || !strings.Contains(err.Error(), "1 malformed") {
		t.Fatalf("malformed line not reported: %v", err)
	}
	if len(search(t, i, "largeneedle", Options{})) != 1 || len(search(t, i, "afterbadline", Options{})) != 1 {
		t.Fatal("large or subsequent record was lost")
	}
	appendFile(t, p, userLine("cancelneedle"))
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := i.IndexFile(cancelled, p, "claude"); err == nil {
		t.Fatal("ignored cancellation")
	}
	if err := i.IndexFile(ctx, p, "claude"); err != nil {
		t.Fatal(err)
	}
	if len(search(t, i, "cancelneedle", Options{})) != 1 {
		t.Fatal("cancelled checkpoint lost or duplicated data")
	}
}
