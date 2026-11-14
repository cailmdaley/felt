package messaging

import "context"

func offerMailbox(dir string, accepts func(Request) bool, emit func([]Request) error) error {
	return offerMailboxWithAck(dir, "shuttle://host/claude/hook", accepts, emit, false, nil, "")
}

func offerMailboxValidated(dir string, accepts func(Request) bool, current func(context.Context, Request) (bool, error), emit func([]Request) error) error {
	return offerMailboxWithAck(dir, "shuttle://host/claude/hook", accepts, emit, false, current, "")
}

// writeFiberMailboxAttempt pins an entry to address, or unpins it, the way a
// build that predates the attempt record does: attempt_address alone.
func writeFiberMailboxAttempt(path string, entry mailboxEntry, address string) error {
	entry.AttemptAddress = address
	entry.Attempt = nil
	return writeMailboxEntry(path, entry)
}
