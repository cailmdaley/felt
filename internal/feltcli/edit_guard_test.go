package feltcli

import (
	"crypto/sha256"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestEditRevisionPrecondition(t *testing.T) {
	t.Parallel()
	for _, changed := range []bool{false, true} {
		t.Run(fmt.Sprint(changed), func(t *testing.T) {
			dir, st := newStore(t)
			f, _ := felt.New("task", "Task")
			f.Status = felt.StatusOpen
			if err := st.Write(f); err != nil {
				t.Fatal(err)
			}
			raw, _ := os.ReadFile(st.Path(f.ID))
			revision := fmt.Sprintf("%x", sha256.Sum256(raw))
			if changed {
				f.Status = felt.StatusActive
				if err := st.Write(f); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := os.ReadFile(st.Path(f.ID))
			out, err := runCommand(t, dir, "edit", "task", "--exact", "--if-match", revision, "--set", "cold=true")
			after, _ := os.ReadFile(st.Path(f.ID))
			if changed {
				if err == nil || !strings.Contains(err.Error(), "document changed") || string(before) != string(after) {
					t.Fatalf("stale edit wrote or lost its refusal: %v %s", err, out)
				}
			} else if err != nil || !strings.Contains(string(after), "cold: true") {
				t.Fatalf("matching revision failed: %v %s", err, out)
			}
		})
	}
}

func TestEditExactDoesNotSelectSameLeaf(t *testing.T) {
	t.Parallel()
	dir, st := newStore(t)
	f, _ := felt.New("elsewhere/task", "Task")
	if err := st.Write(f); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(st.Path(f.ID))
	if out, err := runCommand(t, dir, "edit", "task", "--exact", "--set", "cold=true"); err == nil {
		t.Fatalf("exact edit guessed another namespace: %s", out)
	}
	after, _ := os.ReadFile(st.Path(f.ID))
	if string(before) != string(after) {
		t.Fatal("exact edit changed a same-leaf document")
	}
}

func TestEditRereadsInsideDocumentLock(t *testing.T) {
	t.Parallel()
	dir, st := newStore(t)
	f, _ := felt.New("task", "Task")
	f.Status = felt.StatusOpen
	if err := st.Write(f); err != nil {
		t.Fatal(err)
	}
	unlock, err := st.LockFiber(f.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if unlock != nil {
			unlock()
		}
	})
	done := make(chan error, 1)
	go func() { _, err := runCommand(t, dir, "edit", "task", "--set", "cold=true"); done <- err }()
	select {
	case err := <-done:
		t.Fatalf("edit passed a held document lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	f.Status = felt.StatusActive
	if err := st.Write(f); err != nil {
		t.Fatal(err)
	}
	if err := unlock(); err != nil {
		t.Fatal(err)
	}
	unlock = nil
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	got, err := st.Read(f.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != felt.StatusActive || !strings.Contains(string(mustReadEditFile(t, st.Path(f.ID))), "cold: true") {
		t.Fatalf("edit overwrote the serialized arm: %#v", got)
	}
}

func mustReadEditFile(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
