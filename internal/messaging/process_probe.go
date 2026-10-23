package messaging

import (
	"errors"
	"syscall"
)

// ProcessIdentity is a kernel observation of a PID's current lifetime.
// Only gone proves absence; unknown must not authorize a second owner.
type ProcessIdentity struct {
	Status string `json:"status"`
	Start  string `json:"start,omitempty"`
}

// ProbeProcessIdentity uses the same platform start token as hook registration.
// A failed token read is not absence: only ESRCH from kill(0) proves that.
func ProbeProcessIdentity(pid int) ProcessIdentity {
	return probeProcessIdentity(pid, processStartToken, processSignalZero)
}

func probeProcessIdentity(pid int, startToken func(int) string, signalZero func(int) error) ProcessIdentity {
	if pid <= 0 {
		return ProcessIdentity{Status: "unknown"}
	}
	if start := startToken(pid); start != "" {
		return ProcessIdentity{Status: "present", Start: start}
	}
	if errors.Is(signalZero(pid), syscall.ESRCH) {
		return ProcessIdentity{Status: "gone"}
	}
	return ProcessIdentity{Status: "unknown"}
}
