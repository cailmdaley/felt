//go:build !darwin && !linux

package progstatus

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteUnsupportedPlatformEmitsNothing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "output")
	const sentinel = "untouched"
	if err := os.WriteFile(path, []byte(sentinel), 0600); err != nil {
		t.Fatal(err)
	}
	if err := Write(path, []byte("escape bytes")); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != sentinel {
		t.Fatalf("unsupported platform wrote %q: %v", got, err)
	}
}
