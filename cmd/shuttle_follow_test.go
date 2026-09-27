package cmd

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

var followEpoch = time.Unix(1_000_000, 0)

func followAt(seconds float64) time.Time {
	return followEpoch.Add(time.Duration(seconds * float64(time.Second)))
}

func defaultBatcher() *followBatcher {
	return newFollowBatcher(150, 15*time.Second, defaultFollowNames)
}

func TestFollowAddressedLineFlushesEverythingPending(t *testing.T) {
	b := defaultBatcher()
	if batch := b.Add("00:00:01 me   just talking about the covariance", followAt(0)); batch != nil {
		t.Fatalf("unexpected flush: %q", batch)
	}
	batch := b.Add("00:00:02 me   hey Claude, can you check the redshift bins?", followAt(1))
	want := []string{
		"00:00:01 me   just talking about the covariance",
		"00:00:02 me   hey Claude, can you check the redshift bins?",
	}
	if !reflect.DeepEqual(batch, want) {
		t.Fatalf("batch = %q, want %q", batch, want)
	}
	if len(b.pending) != 0 {
		t.Fatalf("pending not cleared: %q", b.pending)
	}
}

func TestFollowAddressedMatchIsCaseInsensitiveAndCatchesMishearings(t *testing.T) {
	for _, word := range []string{"Claude", "cloud", "Clawed", "KLAUD"} {
		if batch := defaultBatcher().Add("00:00:01 me   "+word+", what do you think?", followAt(0)); batch == nil {
			t.Errorf("%s did not flush", word)
		}
	}
}

func TestFollowAddressedMatchIsWholeWord(t *testing.T) {
	if batch := defaultBatcher().Add("00:00:01 me   the clouds are thick today", followAt(0)); batch != nil {
		t.Fatalf("substring match flushed: %q", batch)
	}
}

func TestFollowWordThresholdFlushesOnceReached(t *testing.T) {
	b := newFollowBatcher(10, 1000*time.Second, defaultFollowNames)
	sixWords := strings.TrimSpace(strings.Repeat("word ", 6))
	if batch := b.Add("00:00:01 me   "+sixWords, followAt(0)); batch != nil {
		t.Fatalf("unexpected flush: %q", batch)
	}
	if batch := b.Add("00:00:02 me   "+sixWords, followAt(1)); len(batch) != 2 {
		t.Fatalf("batch = %q, want 2 lines", batch)
	}
}

func TestFollowTimeThresholdFlushesAfterSecondsSinceFirstPendingLine(t *testing.T) {
	b := newFollowBatcher(1000, 15*time.Second, defaultFollowNames)
	if batch := b.Add("00:00:01 me   hi", followAt(100)); batch != nil {
		t.Fatalf("unexpected flush: %q", batch)
	}
	if batch := b.Tick(followAt(114)); batch != nil {
		t.Fatalf("flushed early: %q", batch)
	}
	if batch := b.Tick(followAt(115)); !reflect.DeepEqual(batch, []string{"00:00:01 me   hi"}) {
		t.Fatalf("batch = %q", batch)
	}
}

func TestFollowEndedLineFlushesAndMarksEnded(t *testing.T) {
	b := newFollowBatcher(1000, 1000*time.Second, defaultFollowNames)
	b.Add("00:00:01 me   hi", followAt(0))
	batch := b.Add("# ended 00:00:02", followAt(1))
	if want := []string{"00:00:01 me   hi", "# ended 00:00:02"}; !reflect.DeepEqual(batch, want) {
		t.Fatalf("batch = %q, want %q", batch, want)
	}
	if !b.Ended() {
		t.Fatal("batcher not ended")
	}
}

func TestFollowNamingLineRidesAlongWithoutCountingOrTriggering(t *testing.T) {
	b := newFollowBatcher(1000, 1000*time.Second, defaultFollowNames)
	b.Add("00:00:01 me   hello there", followAt(0))
	b.Add("# S2 = Martin", followAt(1))
	batch := b.Add("00:00:02 me   claude", followAt(2))
	want := []string{"00:00:01 me   hello there", "# S2 = Martin", "00:00:02 me   claude"}
	if !reflect.DeepEqual(batch, want) {
		t.Fatalf("batch = %q, want %q", batch, want)
	}
}

// runFollow drives followTranscript with a zero poll, a fixed clock, and a
// sleep hook that sees the call count, returning every emitted line.
func runFollow(t *testing.T, path string, onSleep func(n int)) ([]string, int) {
	t.Helper()
	var lines []string
	calls := 0
	err := followTranscript(path, defaultBatcher(), followIO{
		sleep: func(time.Duration) { calls++; onSleep(calls) },
		clock: func() time.Time { return followEpoch },
		emit:  func(line string) { lines = append(lines, line) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return lines, calls
}

func writeTranscript(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func appendTranscript(t *testing.T, path, text string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

func TestFollowPrintsExistingContentsAsFirstBatch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.txt")
	writeTranscript(t, path, "# hark session\n00:00:01 me   hello\n")
	lines, _ := runFollow(t, path, func(n int) {
		if n == 1 {
			appendTranscript(t, path, "# ended 00:00:02\n")
		}
	})
	want := []string{"# hark session", "00:00:01 me   hello", "", "# ended 00:00:02", ""}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines = %q, want %q", lines, want)
	}
}

func TestFollowWaitsForTheFileToAppear(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.txt")
	lines, calls := runFollow(t, path, func(n int) {
		if n == 3 {
			writeTranscript(t, path, "# hark session\n00:00:01 me   hello\n# ended 00:00:02\n")
		}
	})
	want := []string{"# hark session", "00:00:01 me   hello", "# ended 00:00:02", ""}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines = %q, want %q", lines, want)
	}
	if calls < 3 {
		t.Fatalf("sleep called %d times, want >= 3", calls)
	}
}

func TestFollowHandlesTruncationByRereadingFromZero(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.txt")
	writeTranscript(t, path, "# hark session\n00:00:01 me   this line will be lost\n")
	lines, _ := runFollow(t, path, func(n int) {
		if n == 1 {
			writeTranscript(t, path, "# hark session (restarted)\n# ended 00:00:02\n")
		}
	})
	want := []string{
		"# hark session", "00:00:01 me   this line will be lost", "",
		"# hark session (restarted)", "# ended 00:00:02", "",
	}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines = %q, want %q", lines, want)
	}
}

func TestFollowHoldsPartialLineUntilItsNewline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.txt")
	writeTranscript(t, path, "# hark session\n00:00:01 me   hey cla")
	lines, _ := runFollow(t, path, func(n int) {
		if n == 1 {
			appendTranscript(t, path, "ude, over here\n# ended 00:00:02\n")
		}
	})
	want := []string{"# hark session", "", "00:00:01 me   hey claude, over here", "", "# ended 00:00:02", ""}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines = %q, want %q", lines, want)
	}
}

func TestFollowTickFlushesPendingBetweenLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.txt")
	writeTranscript(t, path, "# hark session\n")
	now := followEpoch
	var lines []string
	calls := 0
	err := followTranscript(path, defaultBatcher(), followIO{
		sleep: func(time.Duration) {
			calls++
			now = now.Add(10 * time.Second)
			switch calls {
			case 1:
				appendTranscript(t, path, "00:00:01 me   hi\n")
			case 4:
				appendTranscript(t, path, "# ended 00:00:30\n")
			}
		},
		clock: func() time.Time { return now },
		emit:  func(line string) { lines = append(lines, line) },
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"# hark session", "", "00:00:01 me   hi", "", "# ended 00:00:30", ""}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines = %q, want %q", lines, want)
	}
}

func TestFollowDecodesInvalidUTF8Leniently(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.txt")
	writeTranscript(t, path, "00:00:01 me   caf\xe9\n# ended 00:00:02\n")
	lines, _ := runFollow(t, path, func(int) {})
	want := []string{"00:00:01 me   caf�", "# ended 00:00:02", ""}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines = %q, want %q", lines, want)
	}
}

func TestTranscriptLinesSplitsCompleteLines(t *testing.T) {
	got := transcriptLines([]byte("a\r\nb\n\nc\n"))
	if want := []string{"a", "b", "", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("transcriptLines = %q, want %q", got, want)
	}
}
