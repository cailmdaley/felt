//go:build darwin || linux

package messaging

import (
	"os"
	"testing"
)

func TestProcessBirthToken(t *testing.T) {
	if got := ProcessBirthToken(0); got != "" {
		t.Fatalf("invalid pid token: %q", got)
	}
	if got := ProcessBirthToken(os.Getpid()); got == "" {
		t.Fatal("current process has no birth token")
	}
	if got := ProcessBirthToken(os.Getpid()); got != ProcessBirthToken(os.Getpid()) {
		t.Fatal("birth token changed")
	}
}
